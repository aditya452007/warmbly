import { loadConfig, type BridgeConfig } from "./config.js";
import { openBridgeDb, closeDb, type BridgeDb } from "./db.js";
import { registerProvider } from "./ai/factory.js";
import { OpenCodeAiProvider } from "./ai/opencodeProvider.js";
import { StubAiProvider } from "./ai/stubProvider.js";
import { AgentRuns, CampaignRuns, DiscoveryJobs, Drafts, Events, Leads, Research, Sends } from "./store/repositories.js";
import { WarmblyClient } from "./warmbly/client.js";
import { BridgeOrchestrator } from "./orchestrate/orchestrator.js";
import { createEmailTransport } from "./email/transport/factory.js";
import type { EmailTransport } from "./email/transport/types.js";

registerProvider("opencode", (deps) => new OpenCodeAiProvider(deps));
registerProvider("stub", () => new StubAiProvider([]));

export interface BridgeApp {
  config: BridgeConfig;
  db: BridgeDb;
  orchestrator: BridgeOrchestrator;
  getEmailTransport: () => EmailTransport | null;
}

// Shared composition root. Importing this module registers providers but
// starts nothing; index.ts serves, cli.ts runs one-shot commands.
export function buildOrchestrator(): BridgeApp {
  const config = loadConfig();
  const db = openBridgeDb(config.BRIDGE_DB_PATH);
  const warmbly = new WarmblyClient({
    baseUrl: config.WARMBLY_API_BASE_URL,
    apiKey: config.WARMBLY_API_KEY,
    timeoutMs: config.WARMBLY_API_TIMEOUT_MS,
    maxAttempts: config.WARMBLY_RETRY_ATTEMPTS,
  });
  // Transport construction is lazy and side-effect free (no I/O until
  // verify/send), so one shared instance serves health checks and sends.
  // Misconfiguration disables delivery but never breaks boot.
  let emailTransport: EmailTransport | null = null;
  try {
    const built = createEmailTransport(config);
    if (built) emailTransport = built;
  } catch {
    emailTransport = null;
  }
  const getEmailTransport = (): EmailTransport | null => emailTransport;
  const orchestrator = new BridgeOrchestrator({
    config,
    runs: new CampaignRuns(db),
    agents: new AgentRuns(db),
    jobs: new DiscoveryJobs(db),
    leads: new Leads(db),
    research: new Research(db),
    drafts: new Drafts(db),
    events: new Events(db),
    sends: new Sends(db),
    warmbly,
    getEmailTransport,
  });
  return { config, db, orchestrator, getEmailTransport };
}

export { closeDb };
