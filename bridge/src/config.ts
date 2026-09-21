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
  DEFAULT_PARALLEL_AGENTS: z.coerce.number().int().min(1).max(16).default(4),
  MAX_PARALLEL_AGENTS: z.coerce.number().int().min(1).max(16).default(16),
  DEFAULT_LEAD_TARGET: z.coerce.number().int().min(1).default(50),
  MAX_LEADS_PER_CAMPAIGN: z.coerce.number().int().min(1).default(500),
  AI_JOB_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300000),
  AI_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  WARMBLY_API_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  WARMBLY_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
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
