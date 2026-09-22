import nodemailer, { type Transporter } from "nodemailer";
import {
  isRetryableSmtp,
  SmtpError,
  type EmailMessage,
  type EmailTransport,
  type SmtpErrorCode,
  type TransportResult,
} from "./types.js";

export type SmtpSecurity = "starttls" | "ssl" | "none";

export interface SmtpTransportOptions {
  providerName: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  // Resolved at construction; never logged, never embedded in errors verbatim.
  password: string;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  // Injected seam for tests (streamTransport) and for callers that manage
  // their own nodemailer instance.
  transporter?: Transporter;
}

function address(value: { email: string; name?: string }): string {
  return value.name ? `${value.name} <${value.email}>` : value.email;
}

function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

// Maps nodemailer/transport failures to the retry taxonomy. Permanent
// auth/config/sender errors return immediately; only temp/connection/timeout
// may be retried by the caller.
export function classifySmtpError(err: unknown): SmtpError {
  const record = (err ?? {}) as {
    code?: unknown;
    message?: unknown;
    responseCode?: unknown;
    response?: unknown;
  };
  const message = typeof record.message === "string" ? record.message : String(err);
  const code = typeof record.code === "string" ? record.code : "";
  const responseCode = typeof record.responseCode === "number" ? record.responseCode : undefined;
  if (code === "EAUTH" || /authentication|auth.*failed|invalid.*credentials|535|534/i.test(message)) {
    return new SmtpError("auth", message, responseCode ?? code);
  }
  if (/CERT|certificate|self signed|unable to verify/i.test(message)) {
    return new SmtpError("tls", message, responseCode ?? code);
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEOUT" || /timed? ?out/i.test(message)) {
    return new SmtpError("timeout", message, responseCode ?? code);
  }
  if (
    code === "ECONNECTION" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    /connect|refused|reset|not found|getaddrinfo/i.test(message)
  ) {
    return new SmtpError("connection", message, responseCode ?? code);
  }
  if (responseCode !== undefined) {
    if (responseCode >= 500) return new SmtpError("perm", message, responseCode);
    if (responseCode >= 400) return new SmtpError("temp", message, responseCode);
  }
  return new SmtpError("unknown", message, responseCode ?? code);
}

export async function sendWithRetry<T>(
  attempt: () => Promise<T>,
  opts?: { maxAttempts?: number; baseMs?: number },
): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 3);
  const baseMs = opts?.baseMs ?? 500;
  let lastError: unknown = null;
  for (let n = 1; n <= maxAttempts; n++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof SmtpError ? isRetryableSmtp(err.code) : true;
      if (!retryable || n >= maxAttempts) throw err;
      const waitMs = Math.min(30_000, baseMs * 2 ** (n - 1)) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

// Generic SMTP transport over nodemailer. Brevo and local Mailpit are the
// same wire protocol with different endpoints/credentials; the subclasses
// below only resolve their own configuration (and Brevo's sender rule).
export class SmtpTransport implements EmailTransport {
  readonly name: string;
  protected readonly options: SmtpTransportOptions;
  private transporter: Transporter | null = null;

  constructor(options: SmtpTransportOptions) {
    if (!options.host) throw new SmtpError("config", "SMTP host is required");
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new SmtpError("config", "SMTP port must be 1-65535");
    }
    this.name = options.providerName;
    this.options = options;
  }

  protected buildTransporter(): Transporter {
    const { host, port, security, username, password } = this.options;
    return nodemailer.createTransport({
      host,
      port,
      secure: security === "ssl",
      requireTLS: security === "starttls",
      auth: username || password ? { user: username, pass: password } : undefined,
      connectionTimeout: this.options.connectionTimeoutMs,
      greetingTimeout: this.options.greetingTimeoutMs,
      socketTimeout: this.options.socketTimeoutMs,
      tls: security === "none" ? { rejectUnauthorized: false } : undefined,
    });
  }

  protected client(): Transporter {
    if (!this.transporter) this.transporter = this.options.transporter ?? this.buildTransporter();
    return this.transporter;
  }

  protected fail(err: unknown): never {
    const classified = err instanceof SmtpError ? err : classifySmtpError(err);
    const secrets = [this.options.password, this.options.username].filter(Boolean);
    throw new SmtpError(classified.code, scrubSecrets(classified.message, secrets), classified.providerCode);
  }

  // EHLO + STARTTLS + AUTH against the relay. Sends nothing.
  async verify(): Promise<void> {
    try {
      await this.client().verify();
    } catch (err) {
      this.fail(err);
    }
  }

  async send(message: EmailMessage): Promise<TransportResult> {
    if (!message.to.length) throw new SmtpError("config", "message needs at least one recipient");
    if (!message.subject.trim()) throw new SmtpError("config", "message subject is required");
    if (!message.html) throw new SmtpError("config", "message HTML body is required");
    try {
      const info = await this.client().sendMail({
        from: address(message.from),
        to: message.to.map(address),
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo ? address(message.replyTo) : undefined,
        inReplyTo: message.inReplyTo,
        references: message.references,
        messageId: message.messageId,
        headers: message.headers,
      });
      const messageId = typeof info?.messageId === "string" && info.messageId ? info.messageId : "";
      return { messageId };
    } catch (err) {
      this.fail(err);
    }
  }

  async close(): Promise<void> {
    const transporter = this.transporter;
    this.transporter = null;
    try {
      transporter?.close();
    } catch {
      // Close is best effort.
    }
  }
}

export interface BrevoSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
}

// Brevo relay adapter. BREVO_SMTP_USER is the authentication login only; the
// visible From must be the approved BREVO_FROM_EMAIL, never the login.
// Missing From fails fast instead of silently substituting the login.
export class BrevoSmtpTransport extends SmtpTransport {
  readonly fromEmail: string;
  readonly fromName: string;

  constructor(config: BrevoSmtpConfig) {
    if (!config.username) throw new SmtpError("config", "BREVO_SMTP_USER is required");
    if (!config.password) throw new SmtpError("config", "BREVO_SMTP_PASSWORD is required");
    if (!config.fromEmail) {
      throw new SmtpError(
        "config",
        "BREVO_FROM_EMAIL is required: the SMTP login must never be used as the visible sender",
      );
    }
    super({
      providerName: "brevo",
      host: config.host,
      port: config.port,
      security: config.security,
      username: config.username,
      password: config.password,
      connectionTimeoutMs: config.connectionTimeoutMs,
      greetingTimeoutMs: config.greetingTimeoutMs,
      socketTimeoutMs: config.socketTimeoutMs,
    });
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName;
  }

  defaultFrom(): { email: string; name?: string } {
    return this.fromName ? { email: this.fromEmail, name: this.fromName } : { email: this.fromEmail };
  }
}

// Local Mailpit/dev relay: no auth, no TLS. Never used for real recipients;
// the bridge only points here when EMAIL_PROVIDER=local.
export class LocalSmtpTransport extends SmtpTransport {
  constructor(opts: { host: string; port: number; timeouts: { connection: number; greeting: number; socket: number } }) {
    super({
      providerName: "local",
      host: opts.host,
      port: opts.port,
      security: "none",
      username: "",
      password: "",
      connectionTimeoutMs: opts.timeouts.connection,
      greetingTimeoutMs: opts.timeouts.greeting,
      socketTimeoutMs: opts.timeouts.socket,
    });
  }
}
