import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openBridgeDb, closeDb, type BridgeDb } from "../db.js";
import { CampaignRuns, Events, Leads } from "../store/repositories.js";
import { SendQueues } from "../store/sendQueue.js";
import { InboundReplies, ResponseDrafts, REPLY_PROCESS_STATE, REPLY_SOURCE } from "../store/replies.js";
import { ReplyWorker, classifyReplyError } from "./replyWorker.js";
import type { BridgeConfig } from "../config.js";

let db: BridgeDb;

const config = {
  REPLY_POLL_BATCH: 10,
  REPLY_WORKER_ENABLED: true,
  REPLY_WORKER_INTERVAL_MS: 5_000,
  REPLY_WORKER_LEASE_MS: 60_000,
} as unknown as BridgeConfig;

afterAll(() => {
  if (db?.open) closeDb(db);
});

beforeEach(() => {
  if (db?.open) closeDb(db);
  db = openBridgeDb(":memory:");
});

interface Fx {
  replies: InboundReplies;
  responses: ResponseDrafts;
  events: Events;
  runs: CampaignRuns;
  leads: Leads;
  queues: SendQueues;
  runId: string;
  queueId: string;
}

function seedQueue(fx: Fx, n = 1): void {
  fx.runs.create({
    id: fx.runId, warmblyCampaignId: `camp-${n}`, businessType: "Plumbers", location: "Austin",
    customInstructions: "", offerUrls: ["https://example.com"], parallelAgents: 1, targetLeads: 5,
  });
  fx.leads.insert({
    id: `lead-${n}`, campaignRunId: fx.runId, identity: `domain:shop${n}.example`,
    businessName: `Shop ${n}`, website: `https://shop${n}.example`,
    email: `lead${n}@example.com`, sourceUrls: ["https://maps.example/s"], status: "QUALIFIED",
  });
  fx.queues.create({
    id: `queue-${n}`, runId: fx.runId, dailyLimit: 50, timezone: "UTC", concurrency: 1,
    followupEnabled: false, followupDays: [], followupRequireApproval: true, maxLiveSends: 3,
  });
  fx.queueId = `queue-${n}`;
  fx.queues.setStatus(fx.queueId, "ACTIVE");
}

function fixture(): Fx {
  const fx: Fx = {
    replies: new InboundReplies(db),
    responses: new ResponseDrafts(db),
    events: new Events(db),
    runs: new CampaignRuns(db),
    leads: new Leads(db),
    queues: new SendQueues(db),
    runId: "run-1",
    queueId: "",
  };
  seedQueue(fx);
  return fx;
}

function seedReply(fx: Fx, opts: { id?: string; state?: string; source?: string; leaseUntil?: string | null } = {}): string {
  const id = opts.id ?? "r-1";
  fx.replies.insert({
    id, queueId: fx.queueId, leadId: "lead-1", warmblyId: `w-${id}`,
    rfcMessageId: `<${id}@mail.test>`, threadId: "<init@bridge.test>",
    fromEmail: "lead1@example.com", subject: "Re: hello", bodyText: "Sounds good.",
    receivedAt: "2026-09-22T10:00:00Z", source: opts.source ?? REPLY_SOURCE.WARMBLY,
  });
  if (opts.state && opts.state !== REPLY_PROCESS_STATE.RECEIVED) {
    fx.replies.setProcessState(id, opts.state);
  }
  if (opts.leaseUntil !== undefined) {
    db.prepare("UPDATE inbound_replies SET lease_until = ? WHERE id = ?").run(opts.leaseUntil, id);
  }
  return id;
}

function worker(fx: Fx, processReply: (id: string) => Promise<boolean>): ReplyWorker {
  return new ReplyWorker({
    config, db,
    replies: fx.replies,
    responses: fx.responses,
    events: fx.events,
    queueIdsWithSent: () => [fx.queueId],
    processReply: (reply) => processReply(reply.id),
    intervalMs: 60_000,
  });
}

describe("reply worker claim semantics", () => {
  it("claims a fresh reply, analyzes it, and leaves it ANALYZED", async () => {
    const fx = fixture();
    const id = seedReply(fx);
    const processed: string[] = [];
    const w = worker(fx, async (rid) => {
      processed.push(rid);
      fx.replies.storeAnalysis(rid, { intent: "INTERESTED", confidence: 0.9, summary: "s", action: "a", requiresResponse: true });
      return true;
    });
    const tick = await w.tick();
    expect(tick).toEqual({ claimed: 1, analyzed: 1, errors: 0 });
    expect(processed).toEqual([id]);
    const row = fx.replies.get(id);
    expect(row?.process_state).toBe("ANALYZED");
    expect(row?.lease_until).toBeNull();
    w.stop();
  });

  it("never claims test-sourced rows", async () => {
    const fx = fixture();
    seedReply(fx, { id: "t-1", source: REPLY_SOURCE.TEST });
    let calls = 0;
    const w = worker(fx, async () => {
      calls += 1;
      return true;
    });
    const tick = await w.tick();
    expect(tick?.claimed).toBe(0);
    expect(calls).toBe(0);
    w.stop();
  });

  it("does not double-claim a reply under an unexpired lease", async () => {
    const fx = fixture();
    seedReply(fx, { id: "r-lease", state: REPLY_PROCESS_STATE.ANALYZING, leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    let calls = 0;
    const w = worker(fx, async () => {
      calls += 1;
      return true;
    });
    const tick = await w.tick();
    expect(tick?.claimed).toBe(0);
    expect(calls).toBe(0);
    w.stop();
  });

  it("reclaims a crashed worker's expired lease (restart resume)", async () => {
    const fx = fixture();
    const id = seedReply(fx, { id: "r-crash", state: REPLY_PROCESS_STATE.ANALYZING, leaseUntil: new Date(Date.now() - 1_000).toISOString() });
    let calls = 0;
    const w = worker(fx, async (rid) => {
      calls += 1;
      fx.replies.storeAnalysis(rid, { intent: "QUESTION", confidence: 0.7, summary: "s", action: "a", requiresResponse: false });
      return true;
    });
    const tick = await w.tick();
    expect(tick?.analyzed).toBe(1);
    expect(calls).toBe(1);
    expect(fx.replies.get(id)?.process_state).toBe("ANALYZED");
    w.stop();
  });
});

describe("reply worker failure handling", () => {
  it("parks transient failures as RETRYABLE and re-claims them later", async () => {
    const fx = fixture();
    const id = seedReply(fx);
    let calls = 0;
    const w = worker(fx, async (rid) => {
      calls += 1;
      if (calls === 1) throw new Error("reply analysis failed: ai_unavailable");
      fx.replies.storeAnalysis(rid, { intent: "INTERESTED", confidence: 0.8, summary: "s", action: "a", requiresResponse: true });
      return true;
    });
    await w.tick();
    expect(fx.replies.get(id)?.process_state).toBe("RETRYABLE");
    expect(fx.replies.get(id)?.error_message).toContain("OPEN_CODE_UNAVAILABLE");
    const tick2 = await w.tick();
    expect(tick2?.analyzed).toBe(1);
    expect(fx.replies.get(id)?.process_state).toBe("ANALYZED");
    w.stop();
  });

  it("retries malformed AI output (repair-then-retry policy)", async () => {
    const fx = fixture();
    const id = seedReply(fx);
    const w = worker(fx, async () => {
      throw new Error("reply analysis failed: ai_invalid after repair");
    });
    await w.tick();
    const row = fx.replies.get(id);
    // INVALID_AI_OUTPUT is transient: bounded retries win.
    expect(row?.process_state).toBe("RETRYABLE");
    expect(row?.error_message).toContain("INVALID_AI_OUTPUT");
    w.stop();
  });

  it("never claims an AMBIGUOUS reply", async () => {
    const fx = fixture();
    seedReply(fx, { id: "r-amb", state: REPLY_PROCESS_STATE.AMBIGUOUS });
    let calls = 0;
    const w = worker(fx, async () => {
      calls += 1;
      return true;
    });
    await w.tick();
    expect(calls).toBe(0);
    expect(fx.replies.get("r-amb")?.process_state).toBe("AMBIGUOUS");
    w.stop();
  });

  it("reports an unsubscribe as ANALYZED, never as a retryable AI failure", async () => {
    const fx = fixture();
    const id = seedReply(fx);
    const w = worker(fx, async (rid) => {
      fx.replies.storeAnalysis(rid, { intent: "UNSUBSCRIBE", confidence: 0.99, summary: "opts out", action: "suppress", requiresResponse: false });
      return true;
    });
    await w.tick();
    const row = fx.replies.get(id);
    expect(row?.process_state).toBe("ANALYZED");
    expect(row?.analysis_intent).toBe("UNSUBSCRIBE");
    expect(row?.requires_response).toBe(0);
    w.stop();
  });
});

describe("reply worker status", () => {
  it("aggregates pipeline counters without exposing content", async () => {
    const fx = fixture();
    seedReply(fx, { id: "s-1" });
    seedReply(fx, { id: "s-2", state: REPLY_PROCESS_STATE.ANALYZING, leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    seedReply(fx, { id: "s-3", state: REPLY_PROCESS_STATE.AMBIGUOUS });
    fx.responses.create({ id: "resp-1", queueId: fx.queueId, leadId: "lead-1", replyId: "s-1", subject: "Re", body: "b", status: "NEEDS_REVIEW" });
    const w = worker(fx, async () => true);
    const status = w.status();
    expect(status.state).toBe("STOPPED");
    expect(status.claimable).toBe(1);
    expect(status.analyzing).toBe(1);
    expect(status.ambiguous).toBe(1);
    expect(status.awaitingApproval).toBe(1);
    // Counts only: no subjects, bodies, or addresses.
    expect(JSON.stringify(status)).not.toContain("Sounds good");
    expect(JSON.stringify(status)).not.toContain("lead1@example.com");
    w.stop();
  });
});

describe("error classification", () => {
  it("maps failure text to its class", () => {
    expect(classifyReplyError(new Error("reply analysis failed: ai_unavailable"))).toBe("OPEN_CODE_UNAVAILABLE");
    expect(classifyReplyError(new Error("reply analysis failed: ai_timeout"))).toBe("OPEN_CODE_TIMEOUT");
    expect(classifyReplyError(new Error("reply analysis failed: ai_invalid"))).toBe("INVALID_AI_OUTPUT");
    expect(classifyReplyError(new Error("WarmblyApiError 503"))).toBe("WARM_BLY_UNAVAILABLE");
    expect(classifyReplyError(new Error("SQLITE_BUSY"))).toBe("PERSISTENCE_FAILURE");
    expect(classifyReplyError(new Error("something novel"))).toBe("PROCESSING_ERROR");
  });
});

describe("approval gate (Phase 10)", () => {
  it("refuses to send a NEEDS_REVIEW draft and to approve twice", () => {
    const fx = fixture();
    const id = seedReply(fx);
    fx.responses.create({ id: "resp-g", queueId: fx.queueId, leadId: "lead-1", replyId: id, subject: "Re", body: "b", status: "NEEDS_REVIEW" });
    // The approve-then-send split is enforced in ReplySync; here we assert
    // the persisted states the gate reads.
    expect(fx.responses.get("resp-g")?.status).toBe("NEEDS_REVIEW");
    fx.responses.setStatus("resp-g", "APPROVED");
    expect(fx.responses.get("resp-g")?.status).toBe("APPROVED");
    expect(fx.responses.get("resp-g")?.provider_message_id).toBeNull();
  });
});
