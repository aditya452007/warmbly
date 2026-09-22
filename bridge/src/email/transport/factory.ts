import type { BridgeConfig } from "../../config.js";
import { SmtpError } from "./types.js";
import { BrevoSmtpTransport, LocalSmtpTransport, type SmtpSecurity } from "./smtpTransport.js";

// Provider registry: adding Gmail/Outlook later means a new adapter plus one
// registration line here. No caller branches on provider names.
export const EMAIL_PROVIDERS = ["brevo", "local", "none"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

function parseSecurity(raw: string): SmtpSecurity {
  const value = raw.trim().toLowerCase();
  if (value === "starttls" || value === "ssl" || value === "none") return value;
  throw new SmtpError("config", `SMTP_SECURITY must be starttls, ssl, or none (got ${raw || "empty"})`);
}

function timeouts(config: BridgeConfig): { connection: number; greeting: number; socket: number } {
  return {
    connection: config.WARMBLY_API_TIMEOUT_MS,
    greeting: config.WARMBLY_API_TIMEOUT_MS,
    socket: config.WARMBLY_API_TIMEOUT_MS,
  };
}

// Builds the configured transport, or null when email is explicitly
// unconfigured ("none"). Strict per provider: Brevo requires host, port,
// user, password, and the approved From address; local needs host/port only.
export function createEmailTransport(
  config: BridgeConfig,
): BrevoSmtpTransport | LocalSmtpTransport | null {
  const provider = config.EMAIL_PROVIDER.trim().toLowerCase();
  if (provider === "none" || provider === "") return null;
  if (provider === "local") {
    return new LocalSmtpTransport({
      host: config.LOCAL_SMTP_HOST,
      port: config.LOCAL_SMTP_PORT,
      timeouts: timeouts(config),
    });
  }
  if (provider === "brevo") {
    return new BrevoSmtpTransport({
      host: config.BREVO_SMTP_HOST,
      port: config.BREVO_SMTP_PORT,
      security: parseSecurity(config.SMTP_SECURITY),
      username: config.BREVO_SMTP_USER,
      password: config.BREVO_SMTP_PASSWORD,
      fromEmail: config.BREVO_FROM_EMAIL,
      fromName: config.BREVO_FROM_NAME,
      connectionTimeoutMs: timeouts(config).connection,
      greetingTimeoutMs: timeouts(config).greeting,
      socketTimeoutMs: timeouts(config).socket,
    });
  }
  throw new SmtpError(
    "config",
    `unknown EMAIL_PROVIDER ${config.EMAIL_PROVIDER || "(empty)"} (available: ${EMAIL_PROVIDERS.join(", ")})`,
  );
}

export function isEmailConfigured(config: BridgeConfig): boolean {
  const provider = config.EMAIL_PROVIDER.trim().toLowerCase();
  return provider === "brevo" || provider === "local";
}
