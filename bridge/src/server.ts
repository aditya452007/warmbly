import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BridgeOrchestrator } from "./orchestrate/orchestrator.js";
import { RunRequestSchema } from "./domain/validate.js";

// Small local control plane. No auth: it binds localhost only (see index.ts)
// and only accepts browser calls from the local Warmbly dashboard origins.
// No secrets in responses; errors are short machine-safe messages.
export interface BridgeServerDeps {
  // Optional transport probe. Reports provider identity and reachability
  // only: never usernames, passwords, or SMTP responses.
  checkEmail?: () => Promise<{ provider: string; configured: boolean; connection: "ok" | "error" | "unconfigured" }>;
}

export function createBridgeApp(orchestrator: BridgeOrchestrator, deps?: BridgeServerDeps): Hono {
  const app = new Hono();
  app.use(
    cors({
      origin: ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => {
    return c.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/health/dependencies", async (c) => {
    const warmblyUp = await orchestrator.pingWarmbly();
    const warmbly = warmblyUp ? "ok" : "down";
    let email: { provider: string; configured: boolean; connection: string } = {
      provider: "none",
      configured: false,
      connection: "unconfigured",
    };
    if (deps?.checkEmail) {
      try {
        email = await deps.checkEmail();
      } catch {
        email = { provider: "unknown", configured: false, connection: "error" };
      }
    }
    const degraded = !warmblyUp || email.connection === "error";
    return c.json({
      status: degraded ? "degraded" : "ok",
      database: "ok",
      warmbly,
      opencode: "unknown",
      email_provider: email.provider,
      email_transport: email.configured ? "configured" : "unconfigured",
      email_connection: email.connection,
    });
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

  // Runs for one Warmbly campaign (a campaign can own several runs).
  app.get("/api/warmbly/:campaignId/runs", (c) => {
    try {
      return c.json({ runs: orchestrator.listRunsForCampaign(c.req.param("campaignId")) });
    } catch {
      return c.json({ error: "lookup failed" }, 400);
    }
  });

  // Draft review surface. Reads are plain queries; writes validate, render,
  // and persist without touching any send path.
  app.get("/api/campaigns/:campaignId/drafts", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    try {
      return c.json({ drafts: orchestrator.listDrafts(c.req.param("campaignId"), limit, offset) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "unknown campaign run" }, 404);
    }
  });

  app.get("/api/drafts/:draftId", (c) => {
    try {
      return c.json({ draft: orchestrator.getDraft(c.req.param("draftId")) });
    } catch {
      return c.json({ error: "draft not found" }, 404);
    }
  });

  // Stored snapshot preview: the exact HTML a send phase would use, served
  // for sandboxed display. Never re-renders, never sends.
  app.get("/api/drafts/:draftId/preview", (c) => {
    try {
      const draft = orchestrator.getDraft(c.req.param("draftId")) as { subject?: string; rendered_html?: string | null };
      if (!draft.rendered_html) return c.json({ error: "draft has no rendered email yet" }, 409);
      return c.json({ subject: draft.subject, html: draft.rendered_html });
    } catch {
      return c.json({ error: "draft not found" }, 404);
    }
  });

  app.patch("/api/drafts/:draftId", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const record = (body ?? {}) as Record<string, unknown>;
    if (typeof record.subject !== "string" || typeof record.body !== "string" || typeof record.version !== "number") {
      return c.json({ error: "subject, body and version are required" }, 400);
    }
    try {
      const draft = await orchestrator.saveDraft(c.req.param("draftId"), {
        subject: record.subject,
        body: record.body,
        version: record.version,
      });
      return c.json({ draft });
    } catch (err) {
      const message = err instanceof Error ? err.message : "could not save draft";
      const code = (err as { code?: string }).code === "draft_conflict" ? 409 : 400;
      return c.json({ error: message }, code as 400 | 409);
    }
  });

  app.post("/api/drafts/:draftId/approve", (c) => {
    try {
      return c.json({ draft: orchestrator.approveDraft(c.req.param("draftId")) });
    } catch {
      return c.json({ error: "draft not found" }, 404);
    }
  });

  app.post("/api/drafts/:draftId/reject", (c) => {
    try {
      return c.json({ draft: orchestrator.rejectDraft(c.req.param("draftId")) });
    } catch {
      return c.json({ error: "draft not found" }, 404);
    }
  });

  app.post("/api/drafts/:draftId/regenerate", async (c) => {
    try {
      const draft = await orchestrator.regenerateDraft(c.req.param("draftId"));
      return c.json({ draft });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not regenerate" }, 502);
    }
  });

  // Single controlled send. Body: { recipient, confirmConsent?, force? }.
  // Refusals (gate) are 400s with a machine-safe message; a stale-version
  // conflict is 409. Never invokes AI; never starts anything.
  app.post("/api/drafts/:draftId/send", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const record = (body ?? {}) as Record<string, unknown>;
    if (typeof record.recipient !== "string") {
      return c.json({ error: "recipient is required" }, 400);
    }
    try {
      const result = await orchestrator.sendDraft(c.req.param("draftId"), {
        recipient: record.recipient,
        confirmConsent: record.confirmConsent === true,
        force: record.force === true,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "could not send";
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/drafts/:draftId/sends", (c) => {
    try {
      return c.json({ sends: orchestrator.listSends(c.req.param("draftId")) });
    } catch {
      return c.json({ error: "draft not found" }, 404);
    }
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
