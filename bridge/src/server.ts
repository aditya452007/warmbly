import { Hono } from "hono";
import type { BridgeOrchestrator } from "./orchestrate/orchestrator.js";
import { RunRequestSchema } from "./domain/validate.js";

// Small local control plane. No auth: it binds localhost only (see index.ts).
// No secrets in responses; errors are short machine-safe messages.
export function createBridgeApp(orchestrator: BridgeOrchestrator): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/health/dependencies", async (c) => {
    const warmblyUp = await orchestrator.pingWarmbly();
    const warmbly = warmblyUp ? "ok" : "down";
    return c.json({ status: warmblyUp ? "ok" : "degraded", database: "ok", warmbly, opencode: "unknown" });
  });

  app.post("/api/campaigns/:campaignId/run", async (c) => {
    const warmblyCampaignId = c.req.param("campaignId");
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = RunRequestSchema.safeParse({
      warmblyCampaignId,
      businessType: pick(body, "businessType", "business_type"),
      location: pick(body, "location"),
      customInstructions: pick(body, "customInstructions", "custom_instructions") ?? "",
      offerUrls: pick(body, "offerUrls", "offer_urls"),
      parallelAgents: pick(body, "parallelAgents", "parallel_agents"),
      targetLeads: pick(body, "targetLeads", "target_leads"),
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid run request" }, 400);
    }
    try {
      const runId = await orchestrator.startRun({
        warmblyCampaignId,
        businessType: parsed.data.businessType,
        location: parsed.data.location,
        customInstructions: parsed.data.customInstructions,
        offerUrls: parsed.data.offerUrls,
        parallelAgents: parsed.data.parallelAgents,
        targetLeads: parsed.data.targetLeads,
      });
      return c.json({ runId }, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not start run" }, 400);
    }
  });

  app.get("/api/campaigns/:campaignId/status", (c) => {
    try {
      return c.json(orchestrator.getStatus(c.req.param("campaignId")));
    } catch {
      return c.json({ error: "unknown campaign run" }, 404);
    }
  });

  app.get("/api/campaigns/:campaignId/agents", (c) => {
    try {
      return c.json({ agents: orchestrator.listAgents(c.req.param("campaignId")) });
    } catch {
      return c.json({ error: "unknown campaign run" }, 404);
    }
  });

  app.get("/api/campaigns/:campaignId/leads", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    try {
      return c.json({ leads: orchestrator.listLeads(c.req.param("campaignId"), limit, offset) });
    } catch {
      return c.json({ error: "unknown campaign run" }, 404);
    }
  });

  app.post("/api/campaigns/:campaignId/pause", (c) => {
    orchestrator.pauseRun(c.req.param("campaignId"));
    return c.json({ status: "PAUSED" });
  });

  app.post("/api/campaigns/:campaignId/resume", (c) => {
    try {
      orchestrator.resumeRun(c.req.param("campaignId"));
      return c.json({ status: "DISCOVERING" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot resume" }, 400);
    }
  });

  app.post("/api/campaigns/:campaignId/cancel", (c) => {
    orchestrator.cancelRun(c.req.param("campaignId"));
    return c.json({ status: "CANCELLED" });
  });

  return app;
}

function pick(body: unknown, ...keys: string[]): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}
