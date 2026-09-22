// Provider-neutral email transport port. Application code depends only on
// these types; Brevo, Mailpit-local, and future providers live behind
// EmailTransport implementations registered in factory.ts.

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  // Final rendered bytes from the React Email layer. The transport delivers
  // them unchanged: no templating, no URL rewriting, no AI involvement.
  html: string;
  text?: string;
  replyTo?: EmailAddress;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  headers?: Record<string, string>;
}

export interface TransportResult {
  messageId: string;
}

// Classified send/verify failures. Only "temp" and "connection" are
// retryable; auth/config/sender/permanent failures must surface to the
// operator instead of burning retries.
export type SmtpErrorCode =
  | "config"
  | "auth"
  | "tls"
  | "connection"
  | "timeout"
  | "sender"
  | "temp"
  | "perm"
  | "unknown";

export class SmtpError extends Error {
  readonly code: SmtpErrorCode;
  readonly providerCode?: string | number;

  constructor(code: SmtpErrorCode, message: string, providerCode?: string | number) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.providerCode = providerCode;
  }
}

export function isRetryableSmtp(code: SmtpErrorCode): boolean {
  return code === "temp" || code === "connection" || code === "timeout";
}

export interface EmailTransport {
  readonly name: string;
  // Connectivity + authentication check. Must never send an email.
  verify(): Promise<void>;
  send(message: EmailMessage): Promise<TransportResult>;
  close(): Promise<void>;
}
