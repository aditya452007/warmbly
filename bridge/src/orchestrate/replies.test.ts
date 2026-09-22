import { describe, expect, it } from "vitest";
import { openBridgeDb, closeDb, type BridgeDb } from "../db.js";
import { loadConfig, type BridgeConfig } from "../config.js";
import { CampaignRuns, Drafts, Events, Leads, Research, Sends } from "../store/repositories.js";
import { ContactSignals, DayCounters, FollowupDrafts, SendItems, SendQueues } from "../store/sendQueue.js";
import { InboundReplies, ReplyPolls, ResponseDrafts } from "../store/replies.js";
import { WarmblyClient, type UniboxThreadMessage, type UniboxFullMessage } from "../warmbly/client.js";
import { BulkSender } from "./bulkSend.js";
import { ReplySync, matchInbound, normalizeMessageId } from "./replies.js";
import { renderOutreach } from "../email/render.js";
import type { EmailMessage, EmailTransport } from "../email/transport/types.js";
import type { AgentRuntime } from "../ai/types.js";

const OFFERS = ["https://example.com/offer-one"];
const INIT_ID = "<init-1@bridge.test>";

interface Fixture {
  db: BridgeDb;
  bulk: BulkSender;
  replies: ReplySync;
  unibox: { threads: Record<string, UniboxThreadMessage[]>; emails: Record<string, UniboxFullMessage>; previews: Array<{ thread_id: string }>; calls: string[]; failWith?: number };
  transports: { sent: EmailMessage[] };
  ai: { mode: string; calls: number };
  autoPoll: { calls: number };
  runId: string;
  queueId: string;
}

function testConfig(overrides: Record<string, unknown> = {}): BridgeConfig {
  return loadConfig({
    WARMBLY_API_BASE_URL: "http://localhost:8080",
    WARMBLY_API_KEY: "wmbly_testkey",
    SEND_MODE: "local",
    EMAIL_PROVIDER: "local",
    DEFAULT_DAILY_SEND_LIMIT: "50",
    MAX_DAILY_SEND_LIMIT: "300",
    SEND_CONCURRENCY: "1",
    SEND_TIMEZONE: "UTC",
    FOLLOWUP_DAY_OFFSETS: "3,7,12",
    MAX_LIVE_SENDS: "3",
    SEND_MAX_ATTEMPTS: "3",
    REPLY_POLL_BATCH: "25",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

function setup(opts: { mode?: string; provider?: string; transportName?: string | null; aiMode?: string } = {}): Fixture {
  const db = openBridgeDb(":memory:");
  const config = testConfig({ ...(opts.mode ? { SEND_MODE: opts.mode } : {}), ...(opts.provider ? { EMAIL_PROVIDER: opts.provider } : {}) });
  const sent: EmailMessage[] = [];
  const transport = {
    name: opts.transportName ?? "local",
    verify: async () => undefined,
    send: async (message: EmailMessage) => {
      sent.push(message);
      return { messageId: `<resp-${sent.length}@bridge.test>` };
    },
    close: async () => undefined,
    defaultFrom: () => ({ email: "hello@example.com", name: "Bridge" }),
  } as unknown as EmailTransport;
  const unibox: Fixture["unibox"] = { threads: {}, emails: {}, previews: [], calls: [], failWith: undefined };
  const warmbly = {
    isSuppressed: async () => false,
    lookupContactByEmail: async () => ({ id: "c1" }),
    getContact: async () => ({ id: "c1", email: "lead1@example.com", subscribed: true, custom_fields: {} }),
    updateContact: async () => undefined,
    searchUniboxThreads: async (args: { address: string }) => {
      unibox.calls.push(`search:${args.address}`);
      if (unibox.failWith) {
        const { WarmblyApiError } = await import("../warmbly/errors.js");
        throw new WarmblyApiError(unibox.failWith, "forbidden", "no unibox permission");
      }
      return unibox.previews.map((p) => ({ thread_id: p.thread_id }));
    },
    getUniboxThread: async (threadId: string) => {
      unibox.calls.push(`thread:${threadId}`);
      return unibox.threads[threadId] ?? [];
    },
    getUniboxEmail: async (id: string) => {
      unibox.calls.push(`email:${id}`);
      const full = unibox.emails[id];
      if (!full) throw new Error(`no such message ${id}`);
      return full;
    },
  } as unknown as WarmblyClient;
  const ai: Fixture["ai"] = { mode: opts.aiMode ?? "positive", calls: 0 };
  const autoPoll = { calls: 0 };
  const createRuntime = ((_provider: string) => ({
    executeStructured: async (req: { title: string }) => {
      ai.calls += 1;
      if (ai.mode === "fail") return { ok: false as const, error: { code: "boom" } };
      if (req.title.startsWith("reply-analyze")) {
        if (ai.mode === "unsubscribe") {
          return { ok: true as const, sessionId: "s", data: { intent: "unsubscribe", confidence: 0.95, summary: "Wants off the list.", suggested_action: "Suppress and stop." } };
        }
        if (ai.mode === "negative") {
          return { ok: true as const, sessionId: "s", data: { intent: "negative", confidence: 0.8, summary: "Not interested.", suggested_action: "Back off." } };
        }
        return { ok: true as const, sessionId: "s", data: { intent: "positive", confidence: 0.9, summary: "Interested, asks for pricing.", suggested_action: "Answer with pricing." } };
      }
      if (ai.mode === "draftfail") return { ok: false as const, error: { code: "boom" } };
      return { ok: true as const, sessionId: "s", data: { subject: "Re: pricing", body: "Thanks for asking, here are the details in plain words." } };
    },
    executeText: async () => ({ ok: true as const, sessionId: "s", text: "ok" }),
    close: async () => undefined,
  }) as unknown as () => AgentRuntime);
  const shared = {
    runs: new CampaignRuns(db),
    leads: new Leads(db),
    research: new Research(db),
    drafts: new Drafts(db),
    events: new Events(db),
    sends: new Sends(db),
    queues: new SendQueues(db),
    items: new SendItems(db),
    signals: new ContactSignals(db),
  };
  const bulk = new BulkSender({
    config, db, ...shared,
    followups: new FollowupDrafts(db),
    counters: new DayCounters(db),
    warmbly,
    createRuntime: () => { throw new Error("AI must not run during sends"); },
    getEmailTransport: () => (opts.transportName === null ? null : transport),
    retryBaseMs: 5,
    afterPump: async (queue) => {
      autoPoll.calls += 1;
      await replies.pollQueueReplies(queue.id);
    },
  });
  const replies = new ReplySync({
    config, db, ...shared,
    followups: new FollowupDrafts(db),
    counters: new DayCounters(db),
    replies: new InboundReplies(db),
    responses: new ResponseDrafts(db),
    polls: new ReplyPolls(db),
    warmbly,
    createRuntime,
    sendThreaded: (queueId, msg) => bulk.sendThreadedReply(queueId, msg),
    retryBaseMs: 5,
  });
  const runId = "run-1";
  shared.runs.create({
    id: runId, warmblyCampaignId: "camp-1", businessType: "Plumbers", location: "Austin",
    customInstructions: "", offerUrls: OFFERS, parallelAgents: 1, targetLeads: 5,
  });
  const queue = bulk.createQueue(runId, { followupEnabled: false });
  return { db, bulk, replies, unibox, transports: { sent }, ai, autoPoll, runId, queueId: queue.id };
}

async function seedSentInitial(fx: Fixture, n = 1, messageId = INIT_ID): Promise<void> {
  const leads = new Leads(fx.db);
  const drafts = new Drafts(fx.db);
  leads.insert({
    id: `lead-${n}`, campaignRunId: fx.runId, identity: `domain:shop${n}.example`,
    businessName: `Shop ${n}`, website: `https://shop${n}.example`,
    email: `lead${n}@example.com`, sourceUrls: ["https://maps.example/s"], status: "QUALIFIED",
  });
  const rendered = await renderOutreach({ aiSubject: `Hello Shop ${n}`, aiBodyText: `Concrete body text for shop ${n} with enough words.`, offers: OFFERS });
  drafts.upsert({
    id: `draft-${n}`, leadId: `lead-${n}`, subject: rendered.subject, body: `Concrete body text for shop ${n} with enough words.`,
    templateName: "warmbly-outreach", templateVersion: "1", renderedHtml: rendered.snapshot,
    offerSnapshot: OFFERS, status: "APPROVED",
  });
  const queues = new SendQueues(fx.db);
  queues.attestConsent(fx.queueId);
  queues.setStatus(fx.queueId, "ACTIVE");
  const d = drafts.get(`draft-${n}`);
  // Deterministic SENT row with a known provider Message-ID (as if pumped).
  const items = new SendItems(fx.db);
  items.enqueue({
    id: `item-${n}`, queueId: fx.queueId, draftId: `draft-${n}`, draftVersion: d?.version ?? 1,
    kind: "initial", seq: 0, recipient: `lead${n}@example.com`, idempotencyKey: `k-${n}`, provider: "local",
  });
  fx.db.prepare("UPDATE send_items SET status = 'SENT', provider_message_id = ?, sent_at = ? WHERE id = ?").run(messageId, new Date().toISOString(), `item-${n}`);
}

function inboundPreview(overrides: Partial<UniboxThreadMessage> = {}): UniboxThreadMessage {
  return {
    id: "w-1", thread_id: "t-1", from_addr: ["lead1@example.com"], to_addr: ["hello@example.com"],
    subject: "Re: Hello Shop 1", snippet: "Sounds good", internal_date: "2026-09-22T10:00:00Z",
    ...overrides,
  } as UniboxThreadMessage;
}

function inboundEmail(overrides: Partial<UniboxFullMessage> = {}): UniboxFullMessage {
  return {
    id: "w-1", thread_id: "t-1", from: ["lead1@example.com"], to: ["hello@example.com"],
    subject: "Re: Hello Shop 1", body_plain: "Sounds good, send pricing please.",
    message_id: "<reply-1@mail.test>", in_reply_to: [INIT_ID], internal_date: "2026-09-22T10:00:00Z",
    ...overrides,
  } as UniboxFullMessage;
}

describe("thread matching", () => {
  it("matches ancestry, thread root, and normalizes ids", () => {
    const sent = new Set(["init-1@bridge.test"]);
    expect(matchInbound({ fromEmail: "lead1@example.com", rfcMessageId: "<r@x>", threadId: "t", inReplyTo: ["<INIT-1@BRIDGE.TEST>"] }, "Lead1@Example.com", sent)).toBe(true);
    expect(matchInbound({ fromEmail: "lead1@example.com", rfcMessageId: null, threadId: "<init-1@bridge.test>", inReplyTo: [] }, "lead1@example.com", sent)).toBe(true);
    expect(matchInbound({ fromEmail: "stranger@example.com", rfcMessageId: null, threadId: null, inReplyTo: [INIT_ID] }, "lead1@example.com", sent)).toBe(false);
    expect(matchInbound({ fromEmail: "lead1@example.com", rfcMessageId: null, threadId: null, inReplyTo: ["<other@mail>"] }, "lead1@example.com", sent)).toBe(false);
    expect(normalizeMessageId("<A@B.c>")).toBe("a@b.c");
    expect(normalizeMessageId("warmbly-test:abc")).toBeNull();
  });
});

describe("reply polling", () => {
  it("ingests a matched reply, dedupes re-polls, and records the replied signal", async () => {
    const fx = setup();
    try {
      await seedSentInitial(fx);
      fx.unibox.previews = [{ thread_id: "t-1" }];
      fx.unibox.threads = { "t-1": [inboundPreview()] };
      fx.unibox.emails = { "w-1": inboundEmail() };
      const s1 = await fx.replies.pollQueueReplies(fx.queueId);
      expect(s1.ingested).toBe(1);
      expect(s1.analyzed).toBe(1);
      const rows = new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0].analysis_intent).toBe("positive");
      expect(new ContactSignals(fx.db).has(fx.queueId, "lead1@example.com", "replied")).toBe(true);
      // Re-poll: same message dedupes, cursor advances, nothing new.
      const s2 = await fx.replies.pollQueueReplies(fx.queueId);
      expect(s2.ingested).toBe(0);
      expect(new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0)).toHaveLength(1);
      // Replied leads leave the poll set.
      expect(fx.unibox.calls.filter((c) => c.startsWith("search:")).length).toBe(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("ignores own sends and unrelated threads", async () => {
    const fx = setup();
    try {
      await seedSentInitial(fx);
      fx.unibox.previews = [{ thread_id: "t-own" }, { thread_id: "t-other" }];
      fx.unibox.threads = {
        "t-own": [inboundPreview({ id: "w-own", thread_id: "t-own", from_addr: ["hello@example.com"] })],
        "t-other": [inboundPreview({ id: "w-other", thread_id: "t-other" })],
      };
      fx.unibox.emails = {
        "w-own": inboundEmail({ id: "w-own", thread_id: "t-own", from: ["hello@example.com"], message_id: "<echo@bridge.test>" }),
        "w-other": inboundEmail({ id: "w-other", thread_id: "t-other", message_id: "<x@mail>", in_reply_to: ["<unknown@mail>"] }),
      };
      const s = await fx.replies.pollQueueReplies(fx.queueId);
      expect(s.ingested).toBe(0);
      expect(new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0)).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("treats a forbidden unibox as unavailable: error counted, cursor kept, nothing fabricated", async () => {
    const fx = setup();
    try {
      await seedSentInitial(fx);
      fx.unibox.failWith = 403;
      const s = await fx.replies.pollQueueReplies(fx.queueId);
      expect(s.errors).toBe(1);
      expect(s.ingested).toBe(0);
      expect(new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0)).toHaveLength(0);
      expect(new ContactSignals(fx.db).has(fx.queueId, "lead1@example.com", "replied")).toBe(false);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("reply analysis", () => {
  it("records unsubscribe as a suppression signal", async () => {
    const fx = setup({ aiMode: "unsubscribe" });
    try {
      await seedSentInitial(fx);
      fx.unibox.previews = [{ thread_id: "t-1" }];
      fx.unibox.threads = { "t-1": [inboundPreview()] };
      fx.unibox.emails = { "w-1": inboundEmail({ body_plain: "Remove me from your list." }) };
      await fx.replies.pollQueueReplies(fx.queueId);
      expect(new ContactSignals(fx.db).has(fx.queueId, "lead1@example.com", "unsubscribed")).toBe(true);
      const rows = new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0);
      expect(rows[0].analysis_intent).toBe("unsubscribe");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("response drafting policy", () => {
  async function polledPositive(fx: Fixture) {
    await seedSentInitial(fx);
    fx.unibox.previews = [{ thread_id: "t-1" }];
    fx.unibox.threads = { "t-1": [inboundPreview()] };
    fx.unibox.emails = { "w-1": inboundEmail() };
    await fx.replies.pollQueueReplies(fx.queueId);
    return new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0)[0];
  }

  it("drafts positive replies for review and sends on approval, threaded", async () => {
    const fx = setup();
    try {
      const reply = await polledPositive(fx);
      const draft = await fx.replies.draftResponse(reply.id);
      expect(draft.status).toBe("NEEDS_REVIEW");
      // Nothing sent by drafting alone.
      expect(fx.transports.sent).toHaveLength(0);
      const sent = await fx.replies.approveResponse(draft.id);
      expect(sent.status).toBe("SENT");
      expect(fx.transports.sent).toHaveLength(1);
      const msg = fx.transports.sent[0];
      expect(msg.to).toEqual([{ email: "lead1@example.com" }]);
      expect(msg.inReplyTo).toBe("<reply-1@mail.test>");
      expect(msg.references).toContain("init-1@bridge.test");
      expect(msg.subject).toMatch(/^Re: /);
      expect(msg.html).toContain(OFFERS[0]);
      // Daily slot consumed by the response.
      const metrics = fx.bulk.metrics(fx.runId) as { sent_today: number };
      expect(metrics.sent_today).toBe(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("refuses negative replies without an explicit instruction, allows with one", async () => {
    const fx = setup({ aiMode: "negative" });
    try {
      const reply = await polledPositive(fx);
      await expect(fx.replies.draftResponse(reply.id)).rejects.toThrow(/explicit instruction/);
      const draft = await fx.replies.draftResponse(reply.id, { instruction: "Apologize briefly and offer to reconnect next quarter." });
      expect(draft.status).toBe("NEEDS_REVIEW");
      expect(fx.transports.sent).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("never drafts unsubscribe or automated replies, even with instruction", async () => {
    const fx = setup({ aiMode: "unsubscribe" });
    try {
      const reply = await polledPositive(fx);
      await expect(fx.replies.draftResponse(reply.id, { instruction: "Try anyway." })).rejects.toThrow(/never receive/);
      expect(new ResponseDrafts(fx.db).listByQueue(fx.queueId, 10, 0)).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("blocks approval when a newer reply arrived or the lead unsubscribed", async () => {
    const fx = setup();
    try {
      const reply = await polledPositive(fx);
      const draft = await fx.replies.draftResponse(reply.id);
      // A newer inbound message lands before approval.
      new InboundReplies(fx.db).insert({
        id: "reply-new", queueId: fx.queueId, leadId: "lead-1", warmblyId: "w-2",
        rfcMessageId: "<reply-2@mail.test>", fromEmail: "lead1@example.com",
        subject: "Re: wait", bodyText: "Actually one more question.", receivedAt: "2026-09-22T11:00:00Z",
      });
      await expect(fx.replies.approveResponse(draft.id)).rejects.toThrow(/newer reply/);
      expect(fx.transports.sent).toHaveLength(0);
      expect(new ResponseDrafts(fx.db).get(draft.id)?.status).toBe("BLOCKED");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("parks generation failures without touching queue state, then recovers", async () => {
    const fx = setup({ aiMode: "draftfail" });
    try {
      const reply = await polledPositive(fx);
      await expect(fx.replies.draftResponse(reply.id)).rejects.toThrow(/boom/);
      const parked = new ResponseDrafts(fx.db).getByReply(reply.id);
      expect(parked?.status).toBe("GENERATION_RETRYABLE");
      // Retry with a working model updates the same row.
      fx.ai.mode = "positive";
      const draft = await fx.replies.draftResponse(reply.id);
      expect(draft.status).toBe("NEEDS_REVIEW");
      expect(draft.id).toBe(parked?.id);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("rejecting a response never sends", async () => {
    const fx = setup();
    try {
      const reply = await polledPositive(fx);
      const draft = await fx.replies.draftResponse(reply.id);
      const rejected = fx.replies.rejectResponse(draft.id);
      expect(rejected.status).toBe("REJECTED");
      expect(fx.transports.sent).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("live-cap integration", () => {
  it("an approved response honors the live cap instead of sending", async () => {
    const fx = setup({ mode: "live", provider: "brevo", transportName: "brevo" });
    try {
      await seedSentInitial(fx);
      // Queue cap is 3; burn it with SENT brevo rows.
      fx.db.prepare("UPDATE send_queues SET max_live_sends = 0 WHERE id = ?").run(fx.queueId);
      fx.unibox.previews = [{ thread_id: "t-1" }];
      fx.unibox.threads = { "t-1": [inboundPreview()] };
      fx.unibox.emails = { "w-1": inboundEmail() };
      await fx.replies.pollQueueReplies(fx.queueId);
      const reply = new InboundReplies(fx.db).listByQueue(fx.queueId, 10, 0)[0];
      const draft = await fx.replies.draftResponse(reply.id);
      await expect(fx.replies.approveResponse(draft.id)).rejects.toThrow(/live cap/);
      expect(new ResponseDrafts(fx.db).get(draft.id)?.status).toBe("BLOCKED");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("post-pump auto-poll", () => {
  it("a bulk pump triggers a bounded reply poll", async () => {
    const fx = setup();
    try {
      // Seed an approved draft and drive it through the real pump: the send
      // lands SENT, then afterPump polls the (empty) unibox stub.
      const leads = new Leads(fx.db);
      const drafts = new Drafts(fx.db);
      leads.insert({
        id: "lead-9", campaignRunId: fx.runId, identity: "domain:auto.example",
        businessName: "Auto", website: "https://auto.example",
        email: "auto@example.com", sourceUrls: ["https://maps.example/s"], status: "QUALIFIED",
      });
      const rendered = await renderOutreach({ aiSubject: "Hello Auto", aiBodyText: "Concrete body text here for the auto poll case.", offers: OFFERS });
      drafts.upsert({
        id: "draft-9", leadId: "lead-9", subject: rendered.subject, body: "Concrete body text here for the auto poll case.",
        templateName: "warmbly-outreach", templateVersion: "1", renderedHtml: rendered.snapshot,
        offerSnapshot: OFFERS, status: "APPROVED",
      });
      const queues = new SendQueues(fx.db);
      queues.attestConsent(fx.queueId);
      queues.setStatus(fx.queueId, "ACTIVE");
      new SendItems(fx.db).enqueue({
        id: "item-9", queueId: fx.queueId, draftId: "draft-9", draftVersion: 1,
        kind: "initial", seq: 0, recipient: "auto@example.com", idempotencyKey: "k-9", provider: "local",
      });
      await fx.bulk.pump(fx.queueId);
      expect(new SendItems(fx.db).get("item-9")?.status).toBe("SENT");
      expect(fx.autoPoll.calls).toBe(1);
      expect(fx.unibox.calls).toContain("search:auto@example.com");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});
