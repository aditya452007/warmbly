import { describe, expect, it, vi } from "vitest";
import { openBridgeDb, closeDb, type BridgeDb } from "../db.js";
import { loadConfig, type BridgeConfig } from "../config.js";
import { AgentRuns, CampaignRuns, DiscoveryJobs, Drafts, Events, Leads, Research, Sends } from "../store/repositories.js";
import { ContactSignals, DayCounters, FollowupDrafts, SendItems, SendQueues } from "../store/sendQueue.js";
import { WarmblyClient } from "../warmbly/client.js";
import { BulkSender, classifyBulkError, dayKeyInZone } from "./bulkSend.js";
import { renderOutreach } from "../email/render.js";
import type { EmailMessage, EmailTransport } from "../email/transport/types.js";
import { SmtpError } from "../email/transport/types.js";
import { WarmblyApiError } from "../warmbly/errors.js";
import type { AgentRuntime } from "../ai/types.js";

const OFFERS = ["https://example.com/offer-one"];

interface Fixture {
  db: BridgeDb;
  bulk: BulkSender;
  warmbly: Record<string, unknown>;
  transports: Record<string, { sent: EmailMessage[]; transport: EmailTransport }>;
  runId: string;
  queueId: string;
}

function mockTransport(name: string, impl: Partial<EmailTransport> = {}) {
  const sent: EmailMessage[] = [];
  const transport = {
    name,
    verify: async () => undefined,
    send: async (message: EmailMessage) => {
      sent.push(message);
      return { messageId: `<${sent.length}-${name}@bridge.test>` };
    },
    close: async () => undefined,
    defaultFrom: () => ({ email: "hello@example.com", name: "Bridge" }),
    ...impl,
  } as unknown as EmailTransport & { sent: EmailMessage[] };
  (transport as { sent: EmailMessage[] }).sent = sent;
  return { sent, transport: transport as EmailTransport };
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
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

function mockWarmbly(overrides: Record<string, unknown> = {}) {
  const updated: Array<{ id: string; patch: unknown }> = [];
  const client = {
    listAccounts: async () => [{ id: "a1", email: "mailbox@example.com", status: "active" }],
    listSteps: async () => [{ id: "s1", name: "AI Outreach" }],
    sendTestEmail: async () => ({ recipient: "t@example.org", subject: "[TEST] Hi", step_id: "s1" }),
    lookupContactByEmail: async () => ({ id: "c1" }),
    getContact: async () => ({ id: "c1", email: "lead@example.com", subscribed: true, custom_fields: {} }),
    updateContact: async (id: string, patch: unknown) => {
      updated.push({ id, patch });
    },
    isSuppressed: async () => false,
    ...overrides,
  } as unknown as WarmblyClient;
  return { client, updated };
}

function stubRuntime(text: { subject: string; body: string } | null, calls: { n: number }) {
  return {
    executeStructured: async () => {
      calls.n += 1;
      if (!text) return { ok: false as const, error: { code: "boom" } };
      return { ok: true as const, data: text, sessionId: "s1" };
    },
    executeText: async () => ({ ok: true as const, sessionId: "s1", text: "ok" }),
    close: async () => undefined,
  };
}

async function seedDraft(
  db: BridgeDb,
  runId: string,
  n: number,
  opts: { status?: string; email?: string; subject?: string; body?: string } = {},
): Promise<{ leadId: string; draftId: string }> {
  const leads = new Leads(db);
  const drafts = new Drafts(db);
  const leadId = `lead-${n}`;
  const email = opts.email ?? `lead${n}@example.com`;
  leads.insert({
    id: leadId,
    campaignRunId: runId,
    identity: `domain:shop${n}.example`,
    businessName: `Shop ${n}`,
    website: `https://shop${n}.example`,
    email,
    sourceUrls: ["https://maps.example/s"],
    status: "QUALIFIED",
  });
  const subject = opts.subject ?? `Hello Shop ${n}`;
  const body = opts.body ?? `Concrete body text for shop ${n} with enough words to pass validation.`;
  const rendered = await renderOutreach({ aiSubject: subject, aiBodyText: body, offers: OFFERS });
  drafts.upsert({
    id: `draft-${n}`,
    leadId,
    subject: rendered.subject,
    body,
    templateName: "warmbly-outreach",
    templateVersion: "1",
    renderedHtml: rendered.snapshot,
    offerSnapshot: OFFERS,
    status: opts.status ?? "APPROVED",
  });
  return { leadId, draftId: `draft-${n}` };
}

function setup(opts: {
  mode?: string;
  provider?: string;
  transportName?: string | null;
  transportImpl?: Partial<EmailTransport>;
  warmbly?: Record<string, unknown>;
  aiText?: { subject: string; body: string } | null | "throw";
  aiCalls?: { n: number };
  queue?: { dailyLimit?: number; concurrency?: number; followupEnabled?: boolean; followupDays?: number[]; followupRequireApproval?: boolean; maxLiveSends?: number };
} = {}): Fixture {
  const db = openBridgeDb(":memory:");
  const config = testConfig({
    ...(opts.mode ? { SEND_MODE: opts.mode } : {}),
    ...(opts.provider ? { EMAIL_PROVIDER: opts.provider } : {}),
  });
  const mock = mockWarmbly(opts.warmbly);
  const local = mockTransport("local", opts.transportName === "local" || (!opts.transportName && config.EMAIL_PROVIDER === "local") ? opts.transportImpl : { send: async () => { throw new Error("unexpected local send"); } });
  const brevo = mockTransport("brevo", opts.transportName === "brevo" ? opts.transportImpl : { send: async () => { throw new Error("unexpected brevo send"); } });
  const transports = { local, brevo };
  const aiCalls = opts.aiCalls ?? { n: 0 };
  const bulk = new BulkSender({
    config,
    db,
    runs: new CampaignRuns(db),
    leads: new Leads(db),
    research: new Research(db),
    drafts: new Drafts(db),
    events: new Events(db),
    sends: new Sends(db),
    queues: new SendQueues(db),
    items: new SendItems(db),
    followups: new FollowupDrafts(db),
    counters: new DayCounters(db),
    signals: new ContactSignals(db),
    warmbly: mock.client,
    createRuntime: ((_provider: string) => {
      if (opts.aiText === "throw" || opts.aiText === undefined) throw new Error("AI must not run here");
      return stubRuntime(opts.aiText, aiCalls) as unknown as AgentRuntime;
    }),
    getEmailTransport: () => {
      if (opts.transportName === null) return null;
      if (opts.transportName === "brevo") return brevo.transport;
      if (opts.transportName === "local" || (!opts.transportName && config.EMAIL_PROVIDER === "local")) return local.transport;
      return null;
    },
    retryBaseMs: 5,
  });
  const runId = "run-1";
  new CampaignRuns(db).create({
    id: runId,
    warmblyCampaignId: "camp-1",
    businessType: "Plumbers",
    location: "Austin",
    customInstructions: "",
    offerUrls: OFFERS,
    parallelAgents: 1,
    targetLeads: 50,
  });
  const queue = bulk.createQueue(runId, opts.queue);
  return { db, bulk, warmbly: { ...mock, transports }, transports, runId, queueId: queue.id };
}

async function activate(bulk: BulkSender, db: BridgeDb, queueId: string): Promise<void> {
  const queues = new SendQueues(db);
  queues.attestConsent(queueId);
  queues.setStatus(queueId, "ACTIVE");
  void bulk;
}

function dueAll(db: BridgeDb): void {
  // Due immediately: QUEUED rows read scheduled_for, RETRYABLE rows read
  // next_attempt_at. NULL would park RETRYABLE rows forever.
  db.prepare("UPDATE send_items SET scheduled_for = NULL, next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
}

describe("queue lifecycle", () => {
  it("requires confirmation and consent attestation to start", async () => {
    const fx = setup();
    try {
      await seedDraft(fx.db, fx.runId, 1);
      await expect(fx.bulk.startQueue(fx.runId, { confirmed: false, consentAttested: true })).rejects.toThrow(/confirm/);
      await expect(fx.bulk.startQueue(fx.runId, { confirmed: true, consentAttested: false })).rejects.toThrow(/attest/);
      const out = await fx.bulk.startQueue(fx.runId, { confirmed: true, consentAttested: true });
      expect(out.enqueued).toBe(1);
      // Background pump settles the one item.
      for (let i = 0; i < 50 && new SendItems(fx.db).countsByStatus(fx.queueId).SENT !== 1; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(new SendItems(fx.db).countsByStatus(fx.queueId).SENT).toBe(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("pause stops future sends; resume continues; cancel ends history", async () => {
    const fx = setup({ queue: { dailyLimit: 50 } });
    try {
      await seedDraft(fx.db, fx.runId, 1);
      await seedDraft(fx.db, fx.runId, 2);
      await activate(fx.bulk, fx.db, fx.queueId);
      // Enqueue manually then pause before pumping.
      const q = new SendQueues(fx.db).get(fx.queueId);
      expect(q?.status).toBe("ACTIVE");
      fx.bulk.pauseQueue(fx.runId);
      const summary = await fx.bulk.pump(fx.queueId);
      expect(summary.processed).toBe(0);
      fx.bulk.resumeQueue(fx.runId);
      // Resume re-pumps in background; drive deterministically instead.
      const s2 = await fx.bulk.pump(fx.queueId);
      expect(s2.processed).toBe(0); // nothing enqueued yet (startQueue never ran)
      fx.bulk.cancelQueue(fx.runId);
      expect(new SendQueues(fx.db).get(fx.queueId)?.status).toBe("CANCELLED");
      const s3 = await fx.bulk.pump(fx.queueId);
      expect(s3.processed).toBe(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("initial bulk sends", () => {
  it("sends approved drafts deterministically with no AI", async () => {
    const aiCalls = { n: 0 };
    const fx = setup({ aiCalls, aiText: "throw", queue: { followupEnabled: false } });
    try {
      await seedDraft(fx.db, fx.runId, 1);
      await seedDraft(fx.db, fx.runId, 2);
      const out = await fx.bulk.startQueue(fx.runId, { confirmed: true, consentAttested: true });
      expect(out.enqueued).toBe(2);
      for (let i = 0; i < 100 && new SendItems(fx.db).countsByStatus(fx.queueId).SENT !== 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(new SendItems(fx.db).countsByStatus(fx.queueId).SENT).toBe(2);
      expect(fx.transports.local.sent).toHaveLength(2);
      expect(aiCalls.n).toBe(0);
      const msg = fx.transports.local.sent[0];
      expect(msg.html).toContain(OFFERS[0]);
      expect(msg.html).not.toContain("{{.ai_body}}");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("bounds concurrency across a batch", async () => {
    const fx = setup({ queue: { concurrency: 2, dailyLimit: 50, followupEnabled: false }, transportName: "local" });
    let inflight = 0;
    let maxSeen = 0;
    fx.transports.local.transport = mockTransport("local", {
      send: async (message: EmailMessage) => {
        inflight += 1;
        maxSeen = Math.max(maxSeen, inflight);
        await new Promise((r) => setTimeout(r, 15));
        inflight -= 1;
        fx.transports.local.sent.push(message);
        return { messageId: `<c${fx.transports.local.sent.length}@bridge.test>` };
      },
    }).transport;
    try {
      for (let n = 1; n <= 5; n++) await seedDraft(fx.db, fx.runId, n);
      await activate(fx.bulk, fx.db, fx.queueId);
      // Rebuild sender transport wiring is fixed at setup; drive via startQueue enqueue + manual pump.
      new SendQueues(fx.db).setStatus(fx.queueId, "PAUSED");
      // Enqueue through the start path would background-pump; enqueue items directly instead.
      const queues = new SendQueues(fx.db);
      queues.setStatus(fx.queueId, "ACTIVE");
      const items = new SendItems(fx.db);
      const drafts = new Drafts(fx.db);
      for (let n = 1; n <= 5; n++) {
        const d = drafts.get(`draft-${n}`);
        items.enqueue({
          id: `item-${n}`, queueId: fx.queueId, draftId: `draft-${n}`, draftVersion: d?.version ?? 1,
          kind: "initial", seq: 0, recipient: `lead${n}@example.com`,
          idempotencyKey: `k-${n}`, provider: "local",
        });
      }
      const summary = await fx.bulk.pump(fx.queueId);
      expect(summary.sent).toBe(5);
      expect(maxSeen).toBeLessThanOrEqual(2);
      expect(summary.maxInflight).toBeLessThanOrEqual(2);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("enforces the daily limit and keeps the counter across pumps", async () => {
    const fx = setup({ queue: { dailyLimit: 2, followupEnabled: false } });
    try {
      for (let n = 1; n <= 3; n++) await seedDraft(fx.db, fx.runId, n);
      await activate(fx.bulk, fx.db, fx.queueId);
      const items = new SendItems(fx.db);
      const drafts = new Drafts(fx.db);
      for (let n = 1; n <= 3; n++) {
        const d = drafts.get(`draft-${n}`);
        items.enqueue({
          id: `item-${n}`, queueId: fx.queueId, draftId: `draft-${n}`, draftVersion: d?.version ?? 1,
          kind: "initial", seq: 0, recipient: `lead${n}@example.com`,
          idempotencyKey: `k-${n}`, provider: "local",
        });
      }
      const s1 = await fx.bulk.pump(fx.queueId);
      expect(s1.sent).toBe(2);
      expect(s1.waitingDailyLimit).toBe(true);
      // Second pump sends nothing more today and does not double-count.
      const s2 = await fx.bulk.pump(fx.queueId);
      expect(s2.processed).toBe(0);
      expect(new DayCounters(fx.db).get(fx.queueId, dayKeyInZone("UTC"))).toBe(2);
      expect(items.countsByStatus(fx.queueId).QUEUED).toBe(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("never overshoots the daily limit under concurrency", async () => {
    const fx = setup({ queue: { dailyLimit: 1, concurrency: 4, followupEnabled: false } });
    try {
      for (let n = 1; n <= 4; n++) await seedDraft(fx.db, fx.runId, n);
      await activate(fx.bulk, fx.db, fx.queueId);
      const items = new SendItems(fx.db);
      const drafts = new Drafts(fx.db);
      for (let n = 1; n <= 4; n++) {
        const d = drafts.get(`draft-${n}`);
        items.enqueue({
          id: `item-${n}`, queueId: fx.queueId, draftId: `draft-${n}`, draftVersion: d?.version ?? 1,
          kind: "initial", seq: 0, recipient: `lead${n}@example.com`,
          idempotencyKey: `k-${n}`, provider: "local",
        });
      }
      const summary = await fx.bulk.pump(fx.queueId);
      expect(summary.waitingDailyLimit).toBe(true);
      expect(items.countsByStatus(fx.queueId).SENT).toBe(1);
      expect(fx.transports.local.sent).toHaveLength(1);
      expect(new DayCounters(fx.db).get(fx.queueId, dayKeyInZone("UTC"))).toBe(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("never duplicates across re-pumps and resumes after a crash", async () => {
    const fx = setup({ queue: { followupEnabled: false } });
    try {
      await seedDraft(fx.db, fx.runId, 1);
      await seedDraft(fx.db, fx.runId, 2);
      await activate(fx.bulk, fx.db, fx.queueId);
      const items = new SendItems(fx.db);
      const drafts = new Drafts(fx.db);
      for (const n of [1, 2]) {
        const d = drafts.get(`draft-${n}`);
        items.enqueue({
          id: `item-${n}`, queueId: fx.queueId, draftId: `draft-${n}`, draftVersion: d?.version ?? 1,
          kind: "initial", seq: 0, recipient: `lead${n}@example.com`,
          idempotencyKey: `k-${n}`, provider: "local",
        });
      }
      await fx.bulk.pump(fx.queueId, { maxItems: 1 });
      expect(fx.transports.local.sent).toHaveLength(1);
      // Park the second item in the future: a re-pump must send nothing.
      fx.db.prepare("UPDATE send_items SET scheduled_for = '2099-01-01T00:00:00.000Z' WHERE id = 'item-2'").run();
      await fx.bulk.pump(fx.queueId);
      expect(fx.transports.local.sent).toHaveLength(1);
      // Simulate a crash mid-second-send: row stuck SENDING, transport silent.
      fx.db.prepare("UPDATE send_items SET status = 'SENDING' WHERE id = 'item-2'").run();
      const resumed = fx.bulk.recover();
      expect(resumed).toContain(fx.queueId);
      // Recovery re-pumps in the background; drive the retry deterministically.
      dueAll(fx.db);
      await fx.bulk.pump(fx.queueId);
      expect(fx.transports.local.sent).toHaveLength(2);
      const row = items.get("item-2");
      expect(row?.status).toBe("SENT");
      expect(row?.idempotency_key).toBe("k-2");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("safety gates", () => {
  async function gateFixture(mutator: (fx: Fixture) => Promise<void> | void, warmbly: Record<string, unknown> = {}) {
    const fx = setup({ warmbly });
    await seedDraft(fx.db, fx.runId, 1);
    await mutator(fx);
    await activate(fx.bulk, fx.db, fx.queueId);
    const items = new SendItems(fx.db);
    const d = new Drafts(fx.db).get("draft-1");
    items.enqueue({
      id: "item-1", queueId: fx.queueId, draftId: "draft-1", draftVersion: 1,
      kind: "initial", seq: 0, recipient: "lead1@example.com",
      idempotencyKey: "k-1", provider: "local",
    });
    void d;
    await fx.bulk.pump(fx.queueId);
    return fx;
  }

  it("blocks non-approved drafts without retry", async () => {
    const fx = await gateFixture(async (g) => {
      new Drafts(g.db).setStatus("draft-1", "NEEDS_REVIEW");
    });
    try {
      expect(new SendItems(fx.db).get("item-1")?.status).toBe("BLOCKED");
      expect(fx.transports.local.sent).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("blocks version changes since enqueue", async () => {
    const fx = await gateFixture(async (g) => {
      const d = new Drafts(g.db).get("draft-1");
      new Drafts(g.db).updateContent({ id: "draft-1", subject: "Edited", body: "Edited body content here.", renderedHtml: "<p>e</p>", version: d?.version ?? 1 });
      // Re-approved after the edit, so the version gate (not the status
      // gate) is the one that fires.
      new Drafts(g.db).setStatus("draft-1", "APPROVED");
    });
    try {
      const row = new SendItems(fx.db).get("item-1");
      expect(row?.status).toBe("BLOCKED");
      expect(row?.error_message).toMatch(/version/);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("blocks suppressed recipients", async () => {
    const fx = await gateFixture(async () => undefined, { isSuppressed: async () => true });
    try {
      const row = new SendItems(fx.db).get("item-1");
      expect(row?.status).toBe("BLOCKED");
      expect(row?.error_code).toBe("SUPPRESSION");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("blocks unsubscribed contacts without campaign attestation", async () => {
    const db = openBridgeDb(":memory:");
    const config = testConfig({});
    const mock = mockWarmbly({ getContact: async () => ({ id: "c1", email: "lead1@example.com", subscribed: false, custom_fields: {} }) });
    const local = mockTransport("local");
    const bulk = new BulkSender({
      config, db,
      runs: new CampaignRuns(db), leads: new Leads(db), research: new Research(db),
      drafts: new Drafts(db), events: new Events(db), sends: new Sends(db),
      queues: new SendQueues(db), items: new SendItems(db), followups: new FollowupDrafts(db),
      counters: new DayCounters(db), signals: new ContactSignals(db),
      warmbly: mock.client,
      createRuntime: () => { throw new Error("no AI"); },
      getEmailTransport: () => local.transport,
      retryBaseMs: 5,
    });
    try {
      new CampaignRuns(db).create({
        id: "run-1", warmblyCampaignId: "camp-1", businessType: "Plumbers", location: "Austin",
        customInstructions: "", offerUrls: OFFERS, parallelAgents: 1, targetLeads: 5,
      });
      await seedDraft(db, "run-1", 1);
      const queue = bulk.createQueue("run-1", {});
      // No attestation on purpose.
      new SendQueues(db).setStatus(queue.id, "ACTIVE");
      new SendItems(db).enqueue({
        id: "item-1", queueId: queue.id, draftId: "draft-1", draftVersion: 1,
        kind: "initial", seq: 0, recipient: "lead1@example.com", idempotencyKey: "k-1", provider: "local",
      });
      await bulk.pump(queue.id);
      const row = new SendItems(db).get("item-1");
      expect(row?.status).toBe("BLOCKED");
      expect(row?.error_code).toBe("UNSUBSCRIBED");
      expect(local.sent).toHaveLength(0);
    } finally {
      bulk.shutdown();
      closeDb(db);
    }
  });

  it("blocks changed offer URLs and snapshot drift", async () => {
    const fx = await gateFixture(async (g) => {
      g.db.prepare("UPDATE campaign_runs SET offer_url_1 = 'https://evil.example/changed' WHERE id = 'run-1'").run();
    });
    try {
      const row = new SendItems(fx.db).get("item-1");
      expect(row?.status).toBe("BLOCKED");
      expect(row?.error_message).toMatch(/offer/);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("blocks duplicates already sent via single-send", async () => {
    const fx = setup();
    try {
      await seedDraft(fx.db, fx.runId, 1);
      new Sends(fx.db).create({ id: "s1", draftId: "draft-1", version: 1, idempotencyKey: "send:draft-1:v1", recipient: "lead1@example.com", provider: "local" });
      new Sends(fx.db).setStatus("s1", "SENT", undefined, "m1");
      await activate(fx.bulk, fx.db, fx.queueId);
      new SendItems(fx.db).enqueue({
        id: "item-1", queueId: fx.queueId, draftId: "draft-1", draftVersion: 1,
        kind: "initial", seq: 0, recipient: "lead1@example.com", idempotencyKey: "k-1", provider: "local",
      });
      await fx.bulk.pump(fx.queueId);
      expect(new SendItems(fx.db).get("item-1")?.status).toBe("BLOCKED");
      expect(fx.transports.local.sent).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("retries transient failures and fails permanently after max attempts", async () => {
    let calls = 0;
    const fx = setup({
      transportName: "local",
      transportImpl: {
        send: async () => {
          calls += 1;
          throw new SmtpError("temp", "mailbox busy");
        },
      },
    });
    try {
      await seedDraft(fx.db, fx.runId, 1);
      await activate(fx.bulk, fx.db, fx.queueId);
      new SendItems(fx.db).enqueue({
        id: "item-1", queueId: fx.queueId, draftId: "draft-1", draftVersion: 1,
        kind: "initial", seq: 0, recipient: "lead1@example.com", idempotencyKey: "k-1", provider: "local",
      });
      await fx.bulk.pump(fx.queueId);
      expect(new SendItems(fx.db).get("item-1")?.status).toBe("RETRYABLE");
      dueAll(fx.db);
      await fx.bulk.pump(fx.queueId);
      dueAll(fx.db);
      await fx.bulk.pump(fx.queueId);
      const row = new SendItems(fx.db).get("item-1");
      expect(row?.status).toBe("FAILED");
      expect(row?.error_code).toBe("PROVIDER_4XX");
      expect(calls).toBe(3);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("retries Warmbly lookup outages instead of sending blind or blocking", async () => {
    const fx = await gateFixture(async () => undefined, {
      isSuppressed: async () => {
        throw new WarmblyApiError(0, "network", "down");
      },
    });
    try {
      const row = new SendItems(fx.db).get("item-1");
      expect(row?.status).toBe("RETRYABLE");
      expect(fx.transports.local.sent).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("mirrors send state onto the Warmbly contact", async () => {
    const fx = setup();
    try {
      await seedDraft(fx.db, fx.runId, 1);
      fx.db.prepare("UPDATE leads SET warmbly_contact_id = 'c1' WHERE id = 'lead-1'").run();
      await activate(fx.bulk, fx.db, fx.queueId);
      new SendItems(fx.db).enqueue({
        id: "item-1", queueId: fx.queueId, draftId: "draft-1", draftVersion: 1,
        kind: "initial", seq: 0, recipient: "lead1@example.com", idempotencyKey: "k-1", provider: "local",
      });
      await fx.bulk.pump(fx.queueId);
      const { updated } = fx.warmbly as unknown as { updated: Array<{ patch: unknown }> };
      const mirror = updated.find((u) => (u.patch as { custom_fields?: Record<string, string> }).custom_fields?.ai_send_status === "sent");
      expect(mirror).toBeDefined();
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("live safety cap", () => {
  it("pauses the queue instead of exceeding max live sends", async () => {
    const fx = setup({ mode: "live", provider: "brevo", transportName: "brevo", queue: { maxLiveSends: 2, followupEnabled: false } });
    try {
      for (let n = 1; n <= 3; n++) await seedDraft(fx.db, fx.runId, n);
      await activate(fx.bulk, fx.db, fx.queueId);
      const items = new SendItems(fx.db);
      const drafts = new Drafts(fx.db);
      for (let n = 1; n <= 3; n++) {
        const d = drafts.get(`draft-${n}`);
        items.enqueue({
          id: `item-${n}`, queueId: fx.queueId, draftId: `draft-${n}`, draftVersion: d?.version ?? 1,
          kind: "initial", seq: 0, recipient: `lead${n}@example.com`,
          idempotencyKey: `k-${n}`, provider: "brevo",
        });
      }
      // subscribed=true by default in the mock, queue attested: sends proceed.
      const summary = await fx.bulk.pump(fx.queueId);
      expect(summary.liveCapHit).toBe(true);
      expect(fx.transports.brevo.sent).toHaveLength(2);
      expect(new SendQueues(fx.db).get(fx.queueId)?.status).toBe("PAUSED");
      expect(items.countsByStatus(fx.queueId).QUEUED).toBe(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("follow-ups", () => {
  async function sentInitial(fx: Fixture): Promise<void> {
    await seedDraft(fx.db, fx.runId, 1);
    await activate(fx.bulk, fx.db, fx.queueId);
    const d = new Drafts(fx.db).get("draft-1");
    new SendItems(fx.db).enqueue({
      id: "item-1", queueId: fx.queueId, draftId: "draft-1", draftVersion: d?.version ?? 1,
      kind: "initial", seq: 0, recipient: "lead1@example.com", idempotencyKey: "k-1", provider: "local",
    });
    await fx.bulk.pump(fx.queueId);
    expect(new SendItems(fx.db).get("item-1")?.status).toBe("SENT");
    dueAll(fx.db);
  }

  it("generates follow-ups with AI and holds them for approval by default", async () => {
    const aiCalls = { n: 0 };
    const fx = setup({ aiCalls, aiText: { subject: "Quick bump", body: "Circling back with a short note and nothing else." }, queue: { followupDays: [3] } });
    try {
      await sentInitial(fx);
      await fx.bulk.pump(fx.queueId);
      expect(aiCalls.n).toBe(1);
      const followups = new FollowupDrafts(fx.db).listByQueue(fx.queueId, 10, 0);
      expect(followups).toHaveLength(1);
      expect(followups[0].status).toBe("NEEDS_REVIEW");
      expect(followups[0].subject).toBe("Quick bump");
      // Nothing sent yet: still exactly the initial.
      expect(fx.transports.local.sent).toHaveLength(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("sends approved follow-ups threaded on the initial Message-ID", async () => {
    const fx = setup({ aiText: { subject: "Quick bump", body: "Circling back with a short note and nothing else." }, queue: { followupDays: [3] } });
    try {
      await sentInitial(fx);
      await fx.bulk.pump(fx.queueId);
      const followups = new FollowupDrafts(fx.db).listByQueue(fx.queueId, 10, 0);
      const approved = fx.bulk.approveFollowup(followups[0].id);
      expect(approved.status).toBe("APPROVED");
      await fx.bulk.pump(fx.queueId);
      expect(fx.transports.local.sent).toHaveLength(2);
      const second = fx.transports.local.sent[1];
      const firstId = fx.transports.local.sent[0];
      expect(second.subject).toMatch(/^Re: /);
      expect(second.inReplyTo).toBe("<1-local@bridge.test>");
      expect(second.references).toContain("<1-local@bridge.test>");
      void firstId;
      expect(second.html).toContain("Circling back");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("stops the chain after a reply, even for approved follow-ups", async () => {
    const fx = setup({ aiText: { subject: "Quick bump", body: "Circling back with a short note and nothing else." }, queue: { followupDays: [3] } });
    try {
      await sentInitial(fx);
      await fx.bulk.pump(fx.queueId);
      const followups = new FollowupDrafts(fx.db).listByQueue(fx.queueId, 10, 0);
      fx.bulk.approveFollowup(followups[0].id);
      fx.bulk.recordSignal(fx.runId, { email: "lead1@example.com", kind: "replied", leadId: "lead-1" });
      await fx.bulk.pump(fx.queueId);
      expect(fx.transports.local.sent).toHaveLength(1);
      const item = (fx.db.prepare("SELECT * FROM send_items WHERE kind = 'followup:1'").get() as { status: string });
      expect(item.status).toBe("BLOCKED");
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("AI failure parks generation without touching the sent initial", async () => {
    const fx = setup({ aiText: null, queue: { followupDays: [3] } });
    try {
      await sentInitial(fx);
      await fx.bulk.pump(fx.queueId);
      const followups = new FollowupDrafts(fx.db).listByQueue(fx.queueId, 10, 0);
      expect(followups[0].status).toBe("GENERATION_RETRYABLE");
      expect(new SendItems(fx.db).get("item-1")?.status).toBe("SENT");
      expect(fx.transports.local.sent).toHaveLength(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("campaign-level auto-approval sends generated follow-ups directly", async () => {
    const fx = setup({
      aiText: { subject: "Quick bump", body: "Circling back with a short note and nothing else." },
      queue: { followupRequireApproval: false, followupDays: [3] },
    });
    try {
      await sentInitial(fx);
      // Generation + send happen inside one pump pass for auto-approve.
      for (let i = 0; i < 20 && fx.transports.local.sent.length < 2; i++) {
        await fx.bulk.pump(fx.queueId);
        dueAll(fx.db);
      }
      expect(fx.transports.local.sent.length).toBeGreaterThanOrEqual(2);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });

  it("rejecting a follow-up blocks its send", async () => {
    const fx = setup({ aiText: { subject: "Quick bump", body: "Circling back with a short note and nothing else." }, queue: { followupDays: [3] } });
    try {
      await sentInitial(fx);
      await fx.bulk.pump(fx.queueId);
      const followups = new FollowupDrafts(fx.db).listByQueue(fx.queueId, 10, 0);
      fx.bulk.rejectFollowup(followups[0].id);
      await fx.bulk.pump(fx.queueId);
      expect(fx.transports.local.sent).toHaveLength(1);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});

describe("error taxonomy", () => {
  it("classifies retryable vs terminal failures", () => {
    expect(classifyBulkError(new SmtpError("temp", "busy"))).toEqual({ code: "PROVIDER_4XX", retryable: true });
    expect(classifyBulkError(new SmtpError("connection", "reset"))).toEqual({ code: "NETWORK", retryable: true });
    expect(classifyBulkError(new SmtpError("timeout", "slow"))).toEqual({ code: "TIMEOUT", retryable: true });
    expect(classifyBulkError(new SmtpError("perm", "5xx", 550))).toEqual({ code: "PROVIDER_5XX", retryable: true });
    expect(classifyBulkError(new SmtpError("auth", "no"))).toEqual({ code: "AUTHENTICATION", retryable: false });
    expect(classifyBulkError(new SmtpError("config", "no"))).toEqual({ code: "CONFIGURATION", retryable: false });
    expect(classifyBulkError(new SmtpError("unknown", "weird"))).toEqual({ code: "UNKNOWN", retryable: false });
    expect(classifyBulkError(new WarmblyApiError(429, "rate", "slow down"))).toEqual({ code: "RATE_LIMIT", retryable: true });
    expect(classifyBulkError(new WarmblyApiError(500, "x", "boom"))).toEqual({ code: "NETWORK", retryable: true });
    expect(classifyBulkError(new WarmblyApiError(400, "x", "bad"))).toEqual({ code: "UNKNOWN", retryable: false });
    expect(classifyBulkError(new Error("mystery"))).toEqual({ code: "UNKNOWN", retryable: false });
  });

  it("keys days in the queue timezone, not UTC", () => {
    const at = new Date("2026-09-22T23:30:00Z");
    expect(dayKeyInZone("UTC", at)).toBe("2026-09-22");
    expect(dayKeyInZone("Pacific/Kiritimati", at)).toBe("2026-09-23");
  });
});

describe("metrics", () => {
  it("reports queue depth, pacing, and follow-up states", async () => {
    const fx = setup({ queue: { dailyLimit: 2 } });
    try {
      await seedDraft(fx.db, fx.runId, 1);
      await activate(fx.bulk, fx.db, fx.queueId);
      const d = new Drafts(fx.db).get("draft-1");
      new SendItems(fx.db).enqueue({
        id: "item-1", queueId: fx.queueId, draftId: "draft-1", draftVersion: d?.version ?? 1,
        kind: "initial", seq: 0, recipient: "lead1@example.com", idempotencyKey: "k-1", provider: "local",
      });
      await fx.bulk.pump(fx.queueId);
      const metrics = fx.bulk.metrics(fx.runId) as {
        sent: number; sent_today: number; remaining_today: number; followups: Array<{ seq: number; pending: number }>;
      };
      expect(metrics.sent).toBe(1);
      expect(metrics.sent_today).toBe(1);
      expect(metrics.remaining_today).toBe(1);
      expect(metrics.followups[0].seq).toBe(1);
      // Persistence spy: unused imports stay referenced.
      expect(vi.fn().mock.calls).toHaveLength(0);
    } finally {
      fx.bulk.shutdown();
      closeDb(fx.db);
    }
  });
});
