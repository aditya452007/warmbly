import { serve } from "@hono/node-server";
import { buildOrchestrator, closeDb } from "./app.js";
import { log } from "./log.js";
import { createBridgeApp } from "./server.js";
import { createEmailTransport } from "./email/transport/factory.js";
import { SmtpError } from "./email/transport/types.js";

async function main(): Promise<void> {
  const { config, db, orchestrator } = buildOrchestrator();
  // The transport is built (and validated) at startup but never used by
  // campaign execution in this phase: connectivity only, no sending.
  let emailTransport: ReturnType<typeof createEmailTransport> = null;
  try {
    emailTransport = createEmailTransport(config);
  } catch (err) {
    process.stderr.write(
      `email transport misconfigured: ${err instanceof Error ? err.message : String(err)} (delivery disabled)\n`,
    );
  }
  const resumed = orchestrator.recover();
  if (resumed.length > 0) {
    log("info", "recovered stale leases", { count: resumed.length });
  }
  const app = createBridgeApp(orchestrator, {
    checkEmail: async () => {
      if (!emailTransport) {
        return { provider: config.EMAIL_PROVIDER.trim().toLowerCase() || "none", configured: false, connection: "unconfigured" as const };
      }
      try {
        await emailTransport.verify();
        return { provider: emailTransport.name, configured: true, connection: "ok" as const };
      } catch (err) {
        if (!(err instanceof SmtpError)) throw err;
        return { provider: emailTransport.name, configured: true, connection: "error" as const };
      }
    },
  });
  const server = serve({ fetch: app.fetch, port: config.BRIDGE_PORT, hostname: config.BRIDGE_HOST }, (info) => {
    log("info", `bridge listening on ${info.address}:${info.port}`);
  });

  const shutdown = async (signal: string) => {
    log("info", `received ${signal}, shutting down`);
    await orchestrator.shutdown();
    try {
      await emailTransport?.close();
    } catch {
      // Transport close is best effort.
    }
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
