import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BridgeOrchestrator } from "./orchestrate/orchestrator.js";
import type { BulkSender } from "./orchestrate/bulkSend.js";
import type { ReplySync } from "./orchestrate/replies.js";
import { RunRequestSchema } from "./domain/validate.js";

// Small local control plane. No auth: it binds localhost only (see index.ts)
// and only accepts browser calls from the local Warmbly dashboard origins.
// No secrets in responses; errors are short machine-safe messages.
export interface BridgeServerDeps {
  // Optional transport probe. Reports provider identity and reachability
  // only: never usernames, passwords, or SMTP responses.
  checkEmail?: () => Promise<{ provider: string; configured: boolean; connection: "ok" | "error" | "unconfigured" }>;
  bulkSender?: BulkSender;
  replySync?: ReplySync;
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

  // Bulk campaign sending (Phase 8). Queue creation is inert; only an
  // explicit confirmed + consent-attested start enqueues and pumps.
  app.post("/api/campaigns/:campaignId/send-queue", async (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    let body: unknown = null;
    try {
      body = await c.req.json().catch(() => ({}));
    } catch {
      body = {};
    }
    const record = (body ?? {}) as Record<string, unknown>;
    try {
      const queue = bulk.createQueue(c.req.param("campaignId"), {
        ...(typeof record.dailyLimit === "number" ? { dailyLimit: record.dailyLimit } : {}),
        ...(typeof record.timezone === "string" ? { timezone: record.timezone } : {}),
        ...(typeof record.concurrency === "number" ? { concurrency: record.concurrency } : {}),
        ...(typeof record.followupEnabled === "boolean" ? { followupEnabled: record.followupEnabled } : {}),
        ...(Array.isArray(record.followupDays) ? { followupDays: record.followupDays as number[] } : {}),
        ...(typeof record.followupRequireApproval === "boolean" ? { followupRequireApproval: record.followupRequireApproval } : {}),
        ...(typeof record.maxLiveSends === "number" ? { maxLiveSends: record.maxLiveSends } : {}),
      });
      return c.json({ queue }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not create queue" }, 400);
    }
  });

  app.get("/api/campaigns/:campaignId/send-queue/preview", async (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ preview: await bulk.previewQueue(c.req.param("campaignId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "no send queue" }, 404);
    }
  });

  app.post("/api/campaigns/:campaignId/send-queue/start", async (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const record = (body ?? {}) as Record<string, unknown>;
    try {
      const out = await bulk.startQueue(c.req.param("campaignId"), {
        confirmed: record.confirmed === true,
        consentAttested: record.consentAttested === true,
      });
      return c.json(out, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not start queue" }, 400);
    }
  });

  app.post("/api/campaigns/:campaignId/send-queue/pause", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ queue: bulk.pauseQueue(c.req.param("campaignId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot pause" }, 400);
    }
  });

  app.post("/api/campaigns/:campaignId/send-queue/resume", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ queue: bulk.resumeQueue(c.req.param("campaignId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot resume" }, 400);
    }
  });

  app.post("/api/campaigns/:campaignId/send-queue/cancel", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ queue: bulk.cancelQueue(c.req.param("campaignId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot cancel" }, 400);
    }
  });

  app.post("/api/campaigns/:campaignId/send-queue/limit", async (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const maxLiveSends = (body as Record<string, unknown>)?.maxLiveSends;
    if (typeof maxLiveSends !== "number") return c.json({ error: "maxLiveSends is required" }, 400);
    try {
      return c.json({ queue: bulk.setMaxLiveSends(c.req.param("campaignId"), maxLiveSends) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot raise limit" }, 400);
    }
  });

  app.get("/api/campaigns/:campaignId/send-queue", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ metrics: bulk.metrics(c.req.param("campaignId")) });
    } catch {
      return c.json({ error: "no send queue" }, 404);
    }
  });

  app.get("/api/campaigns/:campaignId/send-queue/items", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    try {
      return c.json({ items: bulk.listItems(c.req.param("campaignId"), limit, offset) });
    } catch {
      return c.json({ error: "no send queue" }, 404);
    }
  });

  app.get("/api/campaigns/:campaignId/send-queue/followups", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    try {
      return c.json({ followups: bulk.listFollowups(c.req.param("campaignId"), limit, offset) });
    } catch {
      return c.json({ error: "no send queue" }, 404);
    }
  });

  app.post("/api/followups/:followupId/approve", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ followup: bulk.approveFollowup(c.req.param("followupId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot approve" }, 400);
    }
  });

  app.post("/api/followups/:followupId/reject", (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    try {
      return c.json({ followup: bulk.rejectFollowup(c.req.param("followupId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot reject" }, 400);
    }
  });

  // Inbound-signal seam: replies, unsubscribes, complaints halt future sends
  // for that address. Reply-sync automation writes here when it lands.
  app.post("/api/campaigns/:campaignId/signals", async (c) => {
    const bulk = deps?.bulkSender;
    if (!bulk) return c.json({ error: "bulk sending is not wired" }, 501);
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const record = (body ?? {}) as Record<string, unknown>;
    if (typeof record.email !== "string" || typeof record.kind !== "string") {
      return c.json({ error: "email and kind are required" }, 400);
    }
    try {
      bulk.recordSignal(c.req.param("campaignId"), {
        email: record.email,
        kind: record.kind,
        ...(typeof record.leadId === "string" ? { leadId: record.leadId } : {}),
      });
      return c.json({ recorded: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot record signal" }, 400);
    }
  });

  // Reply handling (Phase 9). Polling reads Warmbly unibox (needs READ_UNIBOX
  // on the bridge key and the reply mailbox connected); analysis and response
  // drafting run through OpenCode; only an explicit approval sends.
  app.post("/api/campaigns/:campaignId/send-queue/poll-replies", async (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    try {
      return c.json({ poll: await replies.pollRunReplies(c.req.param("campaignId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot poll replies" }, 400);
    }
  });

  app.get("/api/campaigns/:campaignId/send-queue/replies", (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    try {
      return c.json({
        replies: replies.listReplies(c.req.param("campaignId"), limit, offset),
        metrics: replies.replyMetrics(c.req.param("campaignId")),
      });
    } catch {
      return c.json({ error: "no send queue" }, 404);
    }
  });

  app.get("/api/campaigns/:campaignId/send-queue/responses", (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    try {
      return c.json({ responses: replies.listResponses(c.req.param("campaignId"), limit, offset) });
    } catch {
      return c.json({ error: "no send queue" }, 404);
    }
  });

  app.post("/api/replies/:replyId/analyze", async (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    try {
      const record = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return c.json({ reply: await replies.analyzeReply(c.req.param("replyId"), { force: record.force === true }) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot analyze" }, 400);
    }
  });

  app.post("/api/replies/:replyId/draft-response", async (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    try {
      const record = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return c.json({
        response: await replies.draftResponse(c.req.param("replyId"), {
          ...(typeof record.instruction === "string" ? { instruction: record.instruction } : {}),
        }),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot draft response" }, 400);
    }
  });

  app.post("/api/responses/:responseId/approve", async (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    try {
      return c.json({ response: await replies.approveResponse(c.req.param("responseId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot approve response" }, 400);
    }
  });

  app.post("/api/responses/:responseId/reject", (c) => {
    const replies = deps?.replySync;
    if (!replies) return c.json({ error: "reply sync is not wired" }, 501);
    try {
      return c.json({ response: replies.rejectResponse(c.req.param("responseId")) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "cannot reject response" }, 400);
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
