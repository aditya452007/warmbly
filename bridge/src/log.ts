import { redactSecrets } from "./domain/validate.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  campaignId?: string;
  agentId?: string;
  jobId?: string;
  leadId?: string;
  [key: string]: unknown;
}

// Single structured logger. Every line is JSON with timestamp, level,
// message, and correlation fields. Secrets are redacted before printing.
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  const safe = redactSecrets(line);
  if (level === "error" || level === "warn") process.stderr.write(safe + "\n");
  else process.stdout.write(safe + "\n");
}
