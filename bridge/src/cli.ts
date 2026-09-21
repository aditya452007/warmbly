import { loadConfig } from "./config.js";
import { openBridgeDb, closeDb } from "./db.js";
import { buildOrchestrator } from "./app.js";
import { WarmblyClient } from "./warmbly/client.js";

// Minimal operator CLI: no framework, argv parsing only.
// Usage: bridge doctor | run <warmblyCampaignId> [flags] | status <runId> | recover
async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === "doctor") {
    return doctor();
  }
  if (command === "recover") {
    const { db, orchestrator } = buildOrchestrator();
    try {
      const resumed = orchestrator.recover();
      console.log(`recovered ${resumed.length} stale lease(s)`);
    } finally {
      closeDb(db);
    }
    return;
  }
  if (command === "status") {
    const runId = rest[0];
    if (!runId) throw new Error("usage: bridge status <runId>");
    const { db, orchestrator } = buildOrchestrator();
    try {
      console.log(JSON.stringify(orchestrator.getStatus(runId), null, 2));
    } finally {
      closeDb(db);
    }
    return;
  }
  if (command === "run") {
    const warmblyCampaignId = rest[0];
    if (!warmblyCampaignId) throw new Error("usage: bridge run <warmblyCampaignId> [--business-type X --location Y --offers a,b --agents 4 --target 50]");
    const flags = parseFlags(rest.slice(1));
    const { db, orchestrator } = buildOrchestrator();
    try {
      const runId = await orchestrator.startRun({
        warmblyCampaignId,
        businessType: flags["business-type"] ?? "",
        location: flags.location ?? "",
        customInstructions: flags.instructions ?? "",
        offerUrls: (flags.offers ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        parallelAgents: Number(flags.agents ?? 4),
        targetLeads: Number(flags.target ?? 50),
      });
      console.log(`run started: ${runId}`);
    } finally {
      // The run executes in background; the process stays alive via timers.
      void db;
    }
    return;
  }
  throw new Error("usage: bridge doctor|run|status|recover");
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key.startsWith("--")) out[key.slice(2)] = args[i + 1] ?? "";
    if (key.startsWith("--")) i++;
  }
  return out;
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  const db = openBridgeDb(config.BRIDGE_DB_PATH);
  try {
    db.prepare("SELECT 1").get();
    console.log("database: ok");
  } finally {
    closeDb(db);
  }
  const warmbly = new WarmblyClient({
    baseUrl: config.WARMBLY_API_BASE_URL,
    apiKey: config.WARMBLY_API_KEY,
    timeoutMs: 5000,
    maxAttempts: 1,
  });
  console.log(`warmbly: ${(await warmbly.ping()) ? "ok" : "down"}`);
  try {
    const res = await fetch(`${config.OPENCODE_BASE_URL}/global/health`, { signal: AbortSignal.timeout(5000) });
    console.log(`opencode: ${res.ok ? "ok" : "down"}`);
  } catch {
    console.log("opencode: down");
  }
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
