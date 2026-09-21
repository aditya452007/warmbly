import { serve } from "@hono/node-server";
import { buildOrchestrator, closeDb } from "./app.js";
import { log } from "./log.js";
import { createBridgeApp } from "./server.js";

async function main(): Promise<void> {
  const { config, db, orchestrator } = buildOrchestrator();
  const resumed = orchestrator.recover();
  if (resumed.length > 0) {
    log("info", "recovered stale leases", { count: resumed.length });
  }
  const app = createBridgeApp(orchestrator);
  const server = serve({ fetch: app.fetch, port: config.BRIDGE_PORT, hostname: config.BRIDGE_HOST }, (info) => {
    log("info", `bridge listening on ${info.address}:${info.port}`);
  });

  const shutdown = async (signal: string) => {
    log("info", `received ${signal}, shutting down`);
    await orchestrator.shutdown();
    server.close();
    closeDb(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  process.stderr.write(`bridge failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
