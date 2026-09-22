import { z } from "zod";

// Startup-validated bridge configuration. Secrets stay in process env and are
// never logged, never embedded in prompts, and never sent to the AI runtime.
const ConfigSchema = z.object({
  BRIDGE_HOST: z.string().default("127.0.0.1"),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  BRIDGE_DB_PATH: z.string().min(1).default("./data/bridge.sqlite"),
  WARMBLY_API_BASE_URL: z.string().url(),
  WARMBLY_API_KEY: z.string().regex(/^wmbly_/, "must be a scoped wmbly_* API key"),
  AI_PROVIDER: z.string().default("opencode"),
  OPENCODE_BASE_URL: z.string().url().default("http://127.0.0.1:4096"),
  OPENCODE_SERVER_USERNAME: z.string().default(""),
  OPENCODE_SERVER_PASSWORD: z.string().default(""),
  // Optional model pin as "provider/model" (e.g. opencode/big-pickle).
  // Empty means the server default. Malformed values fail fast: silently
  // falling back to the server default would bill or behave unexpectedly.
  OPENCODE_MODEL: z
    .string()
    .default("")
    .refine((s) => {
      if (!s.trim()) return true;
      const slash = s.indexOf("/");
      return slash > 0 && slash < s.trim().length - 1;
    }, "must be empty or provider/model"),
  DEFAULT_PARALLEL_AGENTS: z.coerce.number().int().min(1).max(16).default(4),
  MAX_PARALLEL_AGENTS: z.coerce.number().int().min(1).max(16).default(16),
  DEFAULT_LEAD_TARGET: z.coerce.number().int().min(1).default(50),
  MAX_LEADS_PER_CAMPAIGN: z.coerce.number().int().min(1).default(500),
  AI_JOB_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300000),
  AI_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  WARMBLY_API_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  WARMBLY_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  // Outbound email transport. "none" (default) means unconfigured: the bridge
  // boots and serves, but anything needing delivery reports unconfigured.
  // "brevo" requires the full Brevo relay credentials below; "local" points
  // at Mailpit for safe local testing. Unknown values fail fast at startup.
  EMAIL_PROVIDER: z.string().default("none"),
  BREVO_SMTP_HOST: z.string().default("smtp-relay.brevo.com"),
  BREVO_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  BREVO_SMTP_USER: z.string().default(""),
  BREVO_SMTP_PASSWORD: z.string().default(""),
  BREVO_FROM_EMAIL: z.string().default(""),
  BREVO_FROM_NAME: z.string().default(""),
  SMTP_SECURITY: z.string().default("starttls"),
  LOCAL_SMTP_HOST: z.string().default("127.0.0.1"),
  LOCAL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(11025),
  // Outbound send gate. "disabled" (default) refuses every send; "local"
  // allows single sends through Warmbly's test-email path into Mailpit;
  // "live" allows single sends through the configured EmailTransport.
  // Missing or unknown means disabled: fail closed, never fail open.
  SEND_MODE: z.enum(["disabled", "local", "live"]).default("disabled"),
  // Bulk campaign sending (Phase 8). Daily pacing per queue, bounded
  // concurrency, explicit timezone for day boundaries, deterministic
  // follow-up offsets, and a lifetime live-send cap per queue. Defaults are
  // deliberately conservative: raise explicitly per deployment.
  DEFAULT_DAILY_SEND_LIMIT: z.coerce.number().int().min(1).max(300).default(50),
  MAX_DAILY_SEND_LIMIT: z.coerce.number().int().min(1).max(300).default(300),
  SEND_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  SEND_TIMEZONE: z.string().min(1).default("UTC"),
  FOLLOWUP_DAY_OFFSETS: z.string().default("3,7,12"),
  MAX_LIVE_SENDS: z.coerce.number().int().min(1).default(3),
  SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // Reply sync: distinct recipient addresses polled per pass. Bounds the
  // Warmbly unibox read fan-out on large queues.
  REPLY_POLL_BATCH: z.coerce.number().int().min(1).max(100).default(25),
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid bridge configuration: ${details.join("; ")}`);
  }
  if (parsed.data.DEFAULT_PARALLEL_AGENTS > parsed.data.MAX_PARALLEL_AGENTS) {
    throw new Error("Invalid bridge configuration: DEFAULT_PARALLEL_AGENTS exceeds MAX_PARALLEL_AGENTS");
  }
  return parsed.data;
}
