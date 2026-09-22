import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import type { AgentRuntime } from "../ai/types.js";
import type { BridgeDb } from "../db.js";
import { OutreachSchema } from "../domain/validate.js";
import { renderOutreach } from "../email/render.js";
import { AI_BODY_VAR } from "../email/template.js";
import { escapeHtml } from "../domain/validate.js";
import { log } from "../log.js";
import { runBounded } from "./pool.js";
import type { CampaignRuns, Drafts, Events, Leads, Research, Sends } from "../store/repositories.js";
import {
  ITEM_STATUS,
  FOLLOWUP_STATUS,
  QUEUE_STATUS,
  type ContactSignals,
  type DayCounters,
  type FollowupDrafts,
  type FollowupRow,
  type SendItemRow,
  type SendItems,
  type SendQueueRow,
  type SendQueues,
} from "../store/sendQueue.js";
import type { WarmblyClient } from "../warmbly/client.js";
import type { EmailTransport } from "../email/transport/types.js";
import { SmtpError } from "../email/transport/types.js";
import { WarmblyApiError } from "../warmbly/errors.js";

export interface BulkSendDeps {
  config: BridgeConfig;
  db: BridgeDb;
  runs: CampaignRuns;
  leads: Leads;
  research: Research;
  drafts: Drafts;
  events: Events;
  sends: Sends;
  queues: SendQueues;
  items: SendItems;
  followups: FollowupDrafts;
  counters: DayCounters;
  signals: ContactSignals;
  warmbly: WarmblyClient;
  createRuntime?: (provider: string) => AgentRuntime;
  getEmailTransport?: () => EmailTransport | null;
  // Overridable in tests. Production default backs off 30s doubling.
  retryBaseMs?: number;
  // Post-pump hook (reply sync). Wired in app.ts; absent in most tests.
  afterPump?: (queue: SendQueueRow) => Promise<void>;
}

export type SendErrorCode =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "SAFETY_BLOCK"
  | "SUPPRESSION"
  | "UNSUBSCRIBED"
  | "RATE_LIMIT"
  | "NETWORK"
  | "TIMEOUT"
  | "PROVIDER_4XX"
  | "PROVIDER_5XX"
  | "UNKNOWN";

const TERMINAL_CODES: ReadonlySet<SendErrorCode> = new Set([
  "CONFIGURATION",
  "AUTHENTICATION",
  "SAFETY_BLOCK",
  "SUPPRESSION",
  "UNSUBSCRIBED",
  "UNKNOWN",
]);

function utcNow(): string {
  return new Date().toISOString();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Explicit timezone day key. Never assumes UTC: the queue row names its zone
// and every daily-boundary decision reads through it.
export function dayKeyInZone(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid SEND timezone: ${timezone}`);
  }
}

export function parseDayOffsets(raw: string): number[] {
  const offsets = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (offsets.length === 0) throw new Error("FOLLOWUP_DAY_OFFSETS must list at least one positive day offset");
  return offsets;
}

function backoffAt(baseMs: number, attempts: number): string {
  const wait = Math.min(6 * 3600_000, baseMs * 2 ** Math.min(attempts, 8)) + Math.floor(Math.random() * 250);
  return new Date(Date.now() + wait).toISOString();
}

// Fixed error taxonomy. Only transient failures retry; everything safety or
// credential shaped is terminal. Unknown provider output maps to UNKNOWN and
// never retries, so a novel failure parks instead of burning sends.
export function classifyBulkError(err: unknown): { code: SendErrorCode; retryable: boolean } {
  if (err instanceof SmtpError) {
    switch (err.code) {
      case "temp":
        return { code: "PROVIDER_4XX", retryable: true };
      case "connection":
        return { code: "NETWORK", retryable: true };
      case "timeout":
        return { code: "TIMEOUT", retryable: true };
      case "perm":
        return { code: "PROVIDER_5XX", retryable: true };
      case "auth":
        return { code: "AUTHENTICATION", retryable: false };
      case "config":
      case "sender":
      case "tls":
        return { code: "CONFIGURATION", retryable: false };
      default:
        return { code: "UNKNOWN", retryable: false };
    }
  }
  if (err instanceof WarmblyApiError) {
    if (err.status === 429) return { code: "RATE_LIMIT", retryable: true };
    if (err.status >= 500 || err.status === 0) return { code: "NETWORK", retryable: true };
    return { code: "UNKNOWN", retryable: false };
  }
  const message = String((err as { message?: unknown })?.message ?? err).toLowerCase();
  if (/429|rate.?limit|too many/.test(message)) return { code: "RATE_LIMIT", retryable: true };
  if (/timeout|timed out|econn|enotfound|eai_again|socket hang up/.test(message)) {
    return { code: "TIMEOUT", retryable: true };
  }
  return { code: "UNKNOWN", retryable: false };
}

export interface QueuePreview {
  recipients: number;
  approvedDrafts: number;
  dailyLimit: number;
  sender: string;
  mode: string;
  provider: string;
  followupBehavior: string;
  timezone: string;
}

export interface PumpSummary {
  processed: number;
  sent: number;
  blocked: number;
  failed: number;
  retried: number;
  waitingDailyLimit: boolean;
  liveCapHit: boolean;
  maxInflight: number;
}

// Bounded, paced bulk delivery of APPROVED drafts. Initial sends are fully
// deterministic from stored state and never invoke AI; the model only ever
// generates follow-up text, which carries no credentials, no offer URLs, and
// no sending authority.
export class BulkSender {
  private readonly retryBaseMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(private readonly deps: BulkSendDeps) {
    this.retryBaseMs = deps.retryBaseMs ?? 30_000;
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  createQueue(
    runId: string,
    opts?: { dailyLimit?: number; timezone?: string; concurrency?: number; followupEnabled?: boolean; followupDays?: number[]; followupRequireApproval?: boolean; maxLiveSends?: number },
  ): SendQueueRow {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error("unknown campaign run");
    const existing = this.deps.queues.getByRun(runId);
    if (existing) return existing;
    const dailyLimit = opts?.dailyLimit ?? this.deps.config.DEFAULT_DAILY_SEND_LIMIT;
    if (dailyLimit < 1 || dailyLimit > this.deps.config.MAX_DAILY_SEND_LIMIT) {
      throw new Error(`daily limit must be 1-${this.deps.config.MAX_DAILY_SEND_LIMIT}`);
    }
    const timezone = opts?.timezone ?? this.deps.config.SEND_TIMEZONE;
    assertTimezone(timezone);
    const concurrency = Math.max(1, Math.min(16, opts?.concurrency ?? this.deps.config.SEND_CONCURRENCY));
    const followupDays = opts?.followupDays ?? parseDayOffsets(this.deps.config.FOLLOWUP_DAY_OFFSETS);
    const queue = this.deps.queues.create({
      id: randomUUID(),
      runId,
      dailyLimit,
      timezone,
      concurrency,
      followupEnabled: opts?.followupEnabled ?? true,
      followupDays,
      followupRequireApproval: opts?.followupRequireApproval ?? true,
      maxLiveSends: opts?.maxLiveSends ?? this.deps.config.MAX_LIVE_SENDS,
    });
    this.deps.events.append({ kind: "queue.created", campaignRunId: runId, message: `daily=${dailyLimit} tz=${timezone}` });
    return queue;
  }

  async previewQueue(runId: string): Promise<QueuePreview> {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    const approved = this.approvedDrafts(runId);
    return {
      recipients: approved.length,
      approvedDrafts: approved.length,
      dailyLimit: queue.daily_limit,
      sender: await this.senderLabel(queue),
      mode: this.deps.config.SEND_MODE,
      provider: this.providerFor(queue),
      followupBehavior:
        queue.followup_enabled === 1
          ? `day offsets ${queue.followup_days} (${queue.followup_require_approval === 1 ? "human approval required" : "campaign-level auto-approval"})`
          : "disabled",
      timezone: queue.timezone,
    };
  }

  // Explicit two-key start: the operator confirms the preview AND attests
  // campaign-level sending authorization. Approving drafts alone never starts
  // anything.
  async startQueue(runId: string, input: { confirmed: boolean; consentAttested: boolean }): Promise<{ queue: SendQueueRow; enqueued: number }> {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    if (queue.status === QUEUE_STATUS.ACTIVE) throw new Error("send queue is already active");
    if (queue.status === QUEUE_STATUS.CANCELLED) throw new Error("cancelled queues cannot restart; create a new one");
    if (!input.confirmed) throw new Error("confirm the send preview to start bulk sending");
    if (!input.consentAttested) throw new Error("attest campaign-level sending authorization to start");
    if (this.deps.config.SEND_MODE !== "local" && this.deps.config.SEND_MODE !== "live") {
      throw new Error("sending is disabled (SEND_MODE must be local or live)");
    }
    this.deps.queues.attestConsent(queue.id);
    const enqueued = this.enqueueApproved(queue);
    // A resume re-evaluates operator-reversible blocks instead of stranding
    // rows that were refused only because the mode was off.
    this.requeueModeBlocked(queue.id);
    this.deps.queues.setStatus(queue.id, QUEUE_STATUS.ACTIVE);
    this.deps.events.append({ kind: "queue.started", campaignRunId: runId, message: `enqueued=${enqueued}` });
    void this.pump(queue.id).catch((err) => {
      log("error", "bulk pump failed", { queueId: queue.id, error: err instanceof Error ? err.message : String(err) });
    });
    return { queue: this.deps.queues.get(queue.id) as SendQueueRow, enqueued };
  }

  pauseQueue(runId: string): SendQueueRow {
    const queue = this.requireQueue(runId);
    this.deps.queues.setStatus(queue.id, QUEUE_STATUS.PAUSED);
    this.deps.events.append({ kind: "queue.paused", campaignRunId: runId });
    return this.deps.queues.get(queue.id) as SendQueueRow;
  }

  resumeQueue(runId: string): SendQueueRow {
    const queue = this.requireQueue(runId);
    if (queue.status !== QUEUE_STATUS.PAUSED) throw new Error(`cannot resume a queue in status ${queue.status}`);
    this.requeueModeBlocked(queue.id);
    this.deps.queues.setStatus(queue.id, QUEUE_STATUS.ACTIVE);
    this.deps.events.append({ kind: "queue.resumed", campaignRunId: runId });
    void this.pump(queue.id).catch((err) => {
      log("error", "bulk pump failed", { queueId: queue.id, error: err instanceof Error ? err.message : String(err) });
    });
    return this.deps.queues.get(queue.id) as SendQueueRow;
  }

  cancelQueue(runId: string): SendQueueRow {
    const queue = this.requireQueue(runId);
    this.deps.queues.setStatus(queue.id, QUEUE_STATUS.CANCELLED);
    this.deps.events.append({ kind: "queue.cancelled", campaignRunId: runId, message: "future sends stopped; history untouched" });
    return this.deps.queues.get(queue.id) as SendQueueRow;
  }

  setMaxLiveSends(runId: string, maxLiveSends: number): SendQueueRow {
    const queue = this.requireQueue(runId);
    if (!Number.isInteger(maxLiveSends) || maxLiveSends < 1) throw new Error("max live sends must be a positive integer");
    this.deps.queues.setMaxLiveSends(queue.id, maxLiveSends);
    this.deps.events.append({ kind: "queue.limit_raised", campaignRunId: runId, message: `max_live_sends=${maxLiveSends}` });
    return this.deps.queues.get(queue.id) as SendQueueRow;
  }

  metrics(runId: string): Record<string, unknown> {
    const queue = this.requireQueue(runId);
    const counts = this.deps.items.countsByStatus(queue.id);
    const today = dayKeyInZone(queue.timezone);
    const sentToday = this.deps.counters.get(queue.id, today);
    const followupCounts = this.deps.followups.countsByStatus(queue.id);
    const offsets = this.followupOffsets(queue);
    return {
      status: queue.status,
      queued: counts[ITEM_STATUS.QUEUED] ?? 0,
      sending: counts[ITEM_STATUS.SENDING] ?? 0,
      sent: counts[ITEM_STATUS.SENT] ?? 0,
      failed: counts[ITEM_STATUS.FAILED] ?? 0,
      blocked: counts[ITEM_STATUS.BLOCKED] ?? 0,
      sent_today: sentToday,
      remaining_today: Math.max(0, queue.daily_limit - sentToday),
      daily_limit: queue.daily_limit,
      timezone: queue.timezone,
      followups: offsets.map((offset, i) => ({
        seq: i + 1,
        day_offset: offset,
        pending: (followupCounts[FOLLOWUP_STATUS.NEEDS_REVIEW] ?? 0) + (followupCounts[FOLLOWUP_STATUS.GENERATION_RETRYABLE] ?? 0),
        sent: followupCounts[FOLLOWUP_STATUS.SENT] ?? 0,
        blocked: (followupCounts[FOLLOWUP_STATUS.BLOCKED] ?? 0) + (followupCounts[FOLLOWUP_STATUS.GENERATION_FAILED] ?? 0),
      })),
    };
  }

  // Crash recovery: stuck SENDING rows become RETRYABLE with an explicit
  // ambiguous marker (same idempotency key, audit trail), then ACTIVE queues
  // resume pumping from persisted state. Daily counters are stored rows, so
  // they are already correct.
  recover(): string[] {
    const resumed: string[] = [];
    for (const queue of this.deps.queues.listActive()) {
      const stuck = this.deps.items.resetStuckSending(queue.id, backoffAt(this.retryBaseMs, 0));
      if (stuck > 0) {
        this.deps.events.append({ kind: "queue.recovered", campaignRunId: queue.run_id, message: `ambiguous=${stuck}` });
      }
      if (this.deps.items.hasUnfinished(queue.id)) {
        resumed.push(queue.id);
        void this.pump(queue.id).catch((err) => {
          log("error", "resumed bulk pump failed", { queueId: queue.id, error: err instanceof Error ? err.message : String(err) });
        });
      }
    }
    return resumed;
  }

  // Bounded pump: at most `concurrency` deliveries in flight, daily pacing
  // enforced before every claim, queue status re-read every iteration so a
  // pause/cancel lands between items, never mid-send.
  async pump(queueId: string, opts?: { maxItems?: number }): Promise<PumpSummary> {
    const summary: PumpSummary = { processed: 0, sent: 0, blocked: 0, failed: 0, retried: 0, waitingDailyLimit: false, liveCapHit: false, maxInflight: 0 };
    let inflight = 0;
    const mode = this.deps.config.SEND_MODE;
    for (;;) {
      if (this.shuttingDown) break;
      const queue = this.deps.queues.get(queueId);
      if (!queue || queue.status !== QUEUE_STATUS.ACTIVE) break;
      if (mode !== "local" && mode !== "live") break;
      const today = dayKeyInZone(queue.timezone);
      if (this.deps.counters.get(queueId, today) >= queue.daily_limit) {
        summary.waitingDailyLimit = true;
        this.scheduleWakeup(queue, this.nextDayBoundary(queue.timezone));
        break;
      }
      if (mode === "live" && this.liveSentCount(queueId) >= queue.max_live_sends) {
        summary.liveCapHit = true;
        this.deps.queues.setStatus(queueId, QUEUE_STATUS.PAUSED);
        this.deps.events.append({ kind: "queue.live_cap_reached", campaignRunId: queue.run_id, message: `cap=${queue.max_live_sends}` });
        break;
      }
      const take = opts?.maxItems ? Math.min(opts.maxItems, queue.concurrency) : queue.concurrency;
      const batch = this.deps.items.claimDue(queueId, utcNow(), take);
      if (batch.length === 0) {
        if (this.maybeComplete(queue)) break;
        this.scheduleWakeup(queue, this.nextWakeup(queueId));
        break;
      }
      const outcomes: Array<"sent" | "deferred" | "settled"> = [];
      const tasks = batch.map((item) => async () => {
        inflight += 1;
        summary.maxInflight = Math.max(summary.maxInflight, inflight);
        try {
          outcomes.push(await this.processItem(queue, item));
          summary.processed += 1;
        } finally {
          inflight -= 1;
        }
      });
      await runBounded(queue.concurrency, tasks);
      const fresh = this.deps.items.countsByStatus(queueId);
      summary.sent = fresh[ITEM_STATUS.SENT] ?? 0;
      summary.blocked = fresh[ITEM_STATUS.BLOCKED] ?? 0;
      summary.failed = fresh[ITEM_STATUS.FAILED] ?? 0;
      summary.retried = fresh[ITEM_STATUS.RETRYABLE] ?? 0;
      if (outcomes.includes("deferred")) {
        // A worker lost the day's last slot race: stop claiming, wait for the
        // next window. Deferred items are QUEUED again, never lost.
        summary.waitingDailyLimit = true;
        this.scheduleWakeup(queue, this.nextDayBoundary(queue.timezone));
        break;
      }
      if (opts?.maxItems && summary.processed >= opts.maxItems) break;
    }
    // Bounded reply sync after bulk work: one best-effort poll pass for this
    // queue. Poll failures are logged inside and never fail the pump. Runs
    // for finished queues too (a completed send still earns replies); only a
    // cancelled queue is left alone.
    if (summary.processed > 0 && this.deps.afterPump) {
      try {
        const queue = this.deps.queues.get(queueId);
        if (queue && queue.status !== QUEUE_STATUS.CANCELLED) await this.deps.afterPump(queue);
      } catch (err) {
        log("warn", "post-pump reply poll failed", { queueId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return summary;
  }

  private async processItem(queue: SendQueueRow, item: SendItemRow): Promise<"sent" | "deferred" | "settled"> {
    try {
      if (item.kind === "initial") {
        return await this.sendInitial(queue, item);
      }
      return await this.sendFollowup(queue, item);
    } catch (err) {
      // processItem never throws: every outcome lands on the item row.
      log("error", "bulk item processing fault", { itemId: item.id, error: err instanceof Error ? err.message : String(err) });
      this.deps.items.markTerminal(item.id, "FAILED", "UNKNOWN", "internal processing fault");
      return "settled";
    }
  }

  private async sendInitial(queue: SendQueueRow, item: SendItemRow): Promise<"sent" | "deferred" | "settled"> {
    const gate = this.evaluateInitialGates(queue, item);
    if (!gate.ok) {
      this.refuse(item, gate.code, gate.message);
      return "settled";
    }
    const { draft, recipient, contactId } = gate;
    try {
      const providerMessageId = await this.deliverInitial(queue, draft, recipient, contactId);
      this.deps.items.markSent(item.id, providerMessageId);
      this.deps.events.append({ kind: "send.succeeded", campaignRunId: queue.run_id, leadId: draft.lead_id, message: `bulk:${item.id}` });
      this.mirrorToWarmbly(queue, draft, recipient, providerMessageId);
      this.scheduleFollowups(queue, item, draft, recipient, providerMessageId);
      return "sent";
    } catch (err) {
      if (err instanceof SlotDeferred) {
        // Lost the last slot of the day to a sibling worker: back to QUEUED
        // for the next window, and the pump stops claiming.
        this.sql("UPDATE send_items SET status = 'QUEUED', updated_at = ? WHERE id = ?").run(utcNow(), item.id);
        return "deferred";
      }
      this.failSend(queue, item, err);
      return "settled";
    }
  }

  // All fourteen gates, evaluated on fresh reads at send time. Any failure is
  // terminal (BLOCKED) except Warmbly lookup outages, which retry: a send
  // must never proceed without a passing suppression check.
  private evaluateInitialGates(
    queue: SendQueueRow,
    item: SendItemRow,
  ): { ok: false; code: SendErrorCode; message: string } | { ok: true; draft: { id: string; lead_id: string; subject: string; body: string; version: number; rendered_html_snapshot: string | null; offer_snapshot: string }; recipient: string; contactId: string | null } {
    const fail = (code: SendErrorCode, message: string) => ({ ok: false as const, code, message });
    const draft = this.deps.drafts.get(item.draft_id);
    if (!draft) return fail("SAFETY_BLOCK", "draft not found");
    if (draft.status !== "APPROVED") return fail("SAFETY_BLOCK", `draft is ${draft.status}, not APPROVED`);
    if (draft.version !== item.draft_version) {
      return fail("SAFETY_BLOCK", "draft version changed since enqueue; re-approval required");
    }
    const lead = this.deps.leads.get(draft.lead_id);
    if (!lead) return fail("SAFETY_BLOCK", "lead not found");
    const recipient = item.recipient.trim().toLowerCase();
    if (!isValidEmail(recipient)) return fail("CONFIGURATION", "invalid recipient email");
    return { ok: true, draft, recipient, contactId: lead.warmbly_contact_id };
  }

  private async sendFollowup(queue: SendQueueRow, item: SendItemRow): Promise<"sent" | "deferred" | "settled"> {
    const followup = item.followup_id ? this.deps.followups.get(item.followup_id) : undefined;
    if (!followup) {
      await this.generateFollowup(queue, item);
      return "settled";
    }
    if (followup.status === FOLLOWUP_STATUS.NEEDS_REVIEW) {
      // Awaiting a human: park until recheck instead of spinning the pump.
      this.deps.items.markRetryable(item.id, "SAFETY_BLOCK", "follow-up awaiting human approval", new Date(Date.now() + 3600_000).toISOString());
      return "settled";
    }
    if (followup.status !== FOLLOWUP_STATUS.APPROVED) {
      this.refuse(item, "SAFETY_BLOCK", `follow-up is ${followup.status.toLowerCase()}`);
      return "settled";
    }
    let stop: { code: SendErrorCode; message: string } | null;
    try {
      stop = await this.followupStopReason(queue, item, followup);
    } catch (err) {
      this.deps.items.markRetryable(item.id, "NETWORK", err instanceof Error ? err.message : String(err), backoffAt(this.retryBaseMs, item.attempts));
      return "settled";
    }
    if (stop) {
      this.refuse(item, stop.code, stop.message);
      this.deps.followups.setStatus(followup.id, FOLLOWUP_STATUS.BLOCKED, stop.message);
      return "settled";
    }
    try {
      const providerMessageId = await this.deliverFollowup(queue, item, followup);
      this.deps.items.markSent(item.id, providerMessageId);
      this.deps.followups.setStatus(followup.id, FOLLOWUP_STATUS.SENT);
      this.deps.events.append({ kind: "send.succeeded", campaignRunId: queue.run_id, leadId: followup.lead_id, message: `followup:${followup.seq}` });
      this.mirrorFollowupToWarmbly(queue, followup, item.recipient, providerMessageId);
      return "sent";
    } catch (err) {
      if (err instanceof SlotDeferred) {
        this.sql("UPDATE send_items SET status = 'QUEUED', updated_at = ? WHERE id = ?").run(utcNow(), item.id);
        return "deferred";
      }
      this.failSend(queue, item, err);
      return "settled";
    }
  }

  private async generateFollowup(queue: SendQueueRow, item: SendItemRow): Promise<void> {
    const draft = this.deps.drafts.get(item.draft_id);
    const lead = draft ? this.deps.leads.get(draft.lead_id) : undefined;
    if (!draft || !lead) {
      this.refuse(item, "SAFETY_BLOCK", "parent draft or lead missing");
      return;
    }
    const stop = await this.stoppableFollowupStop(queue, item);
    if (stop === "parked") return;
    if (stop) {
      this.refuse(item, stop.code, stop.message);
      return;
    }
    if (!this.deps.createRuntime) {
      this.parkGeneration(item, draft, lead, "no AI runtime configured");
      return;
    }
    try {
      const runtime = this.deps.createRuntime(this.deps.config.AI_PROVIDER);
      try {
        const research = this.deps.research.get(lead.id);
        const prior = await this.priorThreadText(queue, item, draft);
        // AI context is strictly outreach material: lead facts, prior sent
        // copy, custom instructions. Never credentials, keys, or offer URLs;
        // the template layer inserts the protected URLs at render time.
        const prompt = [
          `Write follow-up email #${item.seq} for a cold outreach thread.`,
          `Business: ${lead.business_name} (${lead.website ?? "no website"})`,
          `Location: ${lead.city ?? lead.country ?? ""}`,
          `Research: ${research?.summary ?? "none"}`,
          `Pain points: ${(research?.painPoints ?? []).join("; ") || "none"}`,
          `Prior sent subject: ${prior.subject}`,
          `Prior sent body: ${prior.body}`,
          `Custom instructions: ${this.runInstructions(queue)}`,
          "Return exactly: subject (max 120 chars) and body (plain text, no HTML, no URLs, no signature, no footer).",
        ].join("\n");
        const result = await runtime.executeStructured(
          {
            systemPrompt: "You write short, human follow-up sales emails. Reply with exactly the requested JSON shape.",
            prompt,
            timeoutMs: this.deps.config.AI_JOB_TIMEOUT_MS,
            title: `followup:${lead.id}:${item.seq}`,
          },
          OutreachSchema,
        );
        if (!result.ok || !result.data) throw new Error(`follow-up generation failed: ${result.error?.code ?? "unknown"}`);
        const status = queue.followup_require_approval === 1 ? FOLLOWUP_STATUS.NEEDS_REVIEW : FOLLOWUP_STATUS.APPROVED;
        const priorRow = this.deps.followups.getByLeadSeq(queue.id, lead.id, item.seq);
        const id = priorRow?.id ?? randomUUID();
        if (priorRow) {
          this.deps.followups.storeGenerated(id, result.data.subject, result.data.body, status);
        } else {
          this.deps.followups.create({
            id,
            queueId: queue.id,
            leadId: lead.id,
            parentDraftId: draft.id,
            seq: item.seq,
            subject: result.data.subject,
            body: result.data.body,
            renderedHtml: null,
            status,
          });
        }
        this.sql("UPDATE send_items SET followup_id = ?, updated_at = ? WHERE id = ?").run(id, utcNow(), item.id);
        this.deps.events.append({ kind: "followup.generated", campaignRunId: queue.run_id, leadId: lead.id, message: `seq=${item.seq} status=${status}` });
        if (status === FOLLOWUP_STATUS.NEEDS_REVIEW) {
          this.deps.items.markRetryable(item.id, "SAFETY_BLOCK", "follow-up awaiting human approval", new Date(Date.now() + 3600_000).toISOString());
        } else {
          this.deps.items.setSending(item.id);
          await this.sendFollowup(queue, { ...item, followup_id: id, status: ITEM_STATUS.SENDING });
        }
      } finally {
        try {
          await runtime.close();
        } catch {
          // Provider close is best effort.
        }
      }
    } catch (err) {
      this.parkGeneration(item, draft, lead, err instanceof Error ? err.message : String(err));
    }
  }

  private parkGeneration(item: SendItemRow, draft: { id: string; lead_id: string }, lead: { id: string }, error: string): void {
    const existing = this.deps.followups.getByLeadSeq(item.queue_id, lead.id, item.seq);
    if (existing) {
      if (existing.attempts + 1 >= this.deps.config.SEND_MAX_ATTEMPTS) {
        this.deps.followups.setStatus(existing.id, FOLLOWUP_STATUS.GENERATION_FAILED, error);
        this.refuse(item, "UNKNOWN", `follow-up generation failed permanently: ${error.slice(0, 160)}`);
      } else {
        this.deps.followups.markGenerationRetryable(existing.id, error);
        this.deps.items.markRetryable(item.id, "UNKNOWN", `follow-up generation retryable: ${error.slice(0, 160)}`, backoffAt(this.retryBaseMs, existing.attempts));
      }
      return;
    }
    const id = randomUUID();
    this.deps.followups.create({
      id,
      queueId: item.queue_id,
      leadId: lead.id,
      parentDraftId: draft.id,
      seq: item.seq,
      subject: "",
      body: "",
      renderedHtml: null,
      status: FOLLOWUP_STATUS.GENERATION_RETRYABLE,
    });
    this.sql("UPDATE send_items SET followup_id = ?, updated_at = ? WHERE id = ?").run(id, utcNow(), item.id);
    this.deps.items.markRetryable(item.id, "UNKNOWN", `follow-up generation retryable: ${error.slice(0, 160)}`, backoffAt(this.retryBaseMs, 0));
    this.deps.events.append({ kind: "followup.generation_failed", campaignRunId: this.queueRun(item.queue_id), leadId: lead.id, message: error.slice(0, 200) });
  }

  // Generation-time stop check that converts a Warmbly outage into a parked
  // generation instead of a terminal refusal.
  private async stoppableFollowupStop(queue: SendQueueRow, item: SendItemRow): Promise<"parked" | { code: SendErrorCode; message: string } | null> {
    try {
      return await this.followupStopReason(queue, item, null);
    } catch (err) {
      this.deps.items.markRetryable(item.id, "NETWORK", err instanceof Error ? err.message : String(err), backoffAt(this.retryBaseMs, item.attempts));
      return "parked";
    }
  }

  // Stop conditions, checked at due time before every follow-up. A reply wins
  // over everything: the chain halts even for an approved, generated draft.
  private async followupStopReason(
    queue: SendQueueRow,
    item: SendItemRow,
    followup: FollowupRow | null,
  ): Promise<{ code: SendErrorCode; message: string } | null> {
    const email = item.recipient.trim().toLowerCase();
    if (this.deps.signals.has(queue.id, email, "replied")) {
      return { code: "SAFETY_BLOCK", message: "recipient replied; follow-up chain halted" };
    }
    if (this.deps.signals.has(queue.id, email, "unsubscribed")) {
      return { code: "UNSUBSCRIBED", message: "recipient unsubscribed" };
    }
    try {
      if (await this.deps.warmbly.isSuppressed(email)) return { code: "SUPPRESSION", message: "recipient is suppressed" };
    } catch (err) {
      // A failed suppression check fails closed as a retry, never a send.
      throw err;
    }
    const draft = this.deps.drafts.get(item.draft_id);
    if (!draft || draft.status !== "APPROVED") return { code: "SAFETY_BLOCK", message: "parent draft is no longer APPROVED" };
    if (draft.version !== item.draft_version) {
      return { code: "SAFETY_BLOCK", message: "parent draft version changed; re-approval required" };
    }
    void followup;
    return null;
  }

  private async priorThreadText(
    queue: SendQueueRow,
    item: SendItemRow,
    draft: { lead_id: string; subject: string; body: string },
  ): Promise<{ subject: string; body: string }> {
    if (item.seq <= 1) return { subject: draft.subject, body: draft.body };
    const prev = this.deps.followups.getByLeadSeq(queue.id, draft.lead_id, item.seq - 1);
    if (prev && prev.status === FOLLOWUP_STATUS.SENT) return { subject: prev.subject, body: prev.body };
    return { subject: draft.subject, body: draft.body };
  }

  private runInstructions(queue: SendQueueRow): string {
    const run = this.deps.runs.get(queue.run_id);
    return run?.custom_instructions ?? "";
  }

  private queueRun(queueId: string): string {
    return this.deps.queues.get(queueId)?.run_id ?? "";
  }

  private refuse(item: SendItemRow, code: SendErrorCode, message: string): void {
    this.deps.items.markTerminal(item.id, "BLOCKED", code, message);
    this.deps.events.append({ kind: "send.refused", campaignRunId: this.queueRun(item.queue_id), message: `${item.id}: ${message.slice(0, 160)}` });
  }

  private failSend(queue: SendQueueRow, item: SendItemRow, err: unknown): void {
    // Gate refusals are terminal operator/safety decisions, never retries.
    // They carry their own taxonomy code straight onto the BLOCKED row.
    if (err instanceof GateError) {
      this.refuse(item, err.code, err.message);
      return;
    }
    // they retry until Warmbly answers.
    if (this.isGateLookupOutage(err)) {
      const { code } = classifyBulkError(err);
      this.deps.items.markRetryable(item.id, code, err instanceof Error ? err.message : String(err), backoffAt(this.retryBaseMs, item.attempts));
      return;
    }
    const { code, retryable } = classifyBulkError(err);
    const message = err instanceof Error ? err.message : String(err);
    if (retryable && item.attempts + 1 < this.deps.config.SEND_MAX_ATTEMPTS) {
      this.deps.items.markRetryable(item.id, code, message, backoffAt(this.retryBaseMs, item.attempts));
      this.deps.events.append({ kind: "send.failed", campaignRunId: queue.run_id, message: `${item.id} retryable:${code}` });
    } else {
      this.deps.items.markTerminal(item.id, "FAILED", code, message);
      this.deps.events.append({ kind: "send.failed", campaignRunId: queue.run_id, message: `${item.id} failed:${code}` });
    }
  }

  private isGateLookupOutage(err: unknown): boolean {
    return err instanceof Error && err.message.startsWith("gate-lookup:");
  }

  // Full delivery for an initial send: every gate that needs Warmbly or the
  // approved bytes runs here, on fresh reads, immediately before the provider
  // call. Lookup failures throw gate-lookup errors (retryable); content and
  // consent failures throw terminal gate errors (blocked).
  private async deliverInitial(
    queue: SendQueueRow,
    draft: { id: string; lead_id: string; subject: string; body: string; version: number; rendered_html_snapshot: string | null; offer_snapshot: string },
    recipient: string,
    contactId: string | null,
  ): Promise<string> {
    const mode = this.deps.config.SEND_MODE;
    const lead = this.deps.leads.get(draft.lead_id);
    if (!lead) throw new GateError("SAFETY_BLOCK", "lead not found");
    const runOffers = this.runOffers(queue.run_id);
    if (!this.sameStrings(runOffers, this.parseOffers(draft.offer_snapshot))) {
      throw new GateError("SAFETY_BLOCK", "offer URLs changed since approval; re-approval required");
    }
    let rendered: { subject: string; stepHtml: string; snapshot: string };
    try {
      rendered = await renderOutreach({ aiSubject: draft.subject, aiBodyText: draft.body, offers: runOffers });
    } catch (err) {
      throw new GateError("SAFETY_BLOCK", `approved content no longer renders: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (normalizeHtml(rendered.snapshot) !== normalizeHtml(draft.rendered_html_snapshot ?? "")) {
      throw new GateError("SAFETY_BLOCK", "rendered HTML differs from the approved snapshot; re-approval required");
    }
    const subscribed = await this.contactSubscribed(queue, lead, contactId);
    const consentSource = subscribed ? "subscribed" : queue.consent_attested === 1 ? "campaign_attestation" : null;
    if (!consentSource) {
      throw new GateError("UNSUBSCRIBED", "contact has no recorded consent and the campaign attests none");
    }
    let suppressed: boolean;
    try {
      suppressed = await this.deps.warmbly.isSuppressed(recipient);
    } catch (err) {
      throw new Error(`gate-lookup: suppression check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (suppressed) throw new GateError("SUPPRESSION", "recipient is on the workspace suppression list");
    const single = this.deps.sends.getByDraftVersion(draft.id, draft.version);
    if (single?.status === "SENT") throw new GateError("SAFETY_BLOCK", "already sent via single-send; refusing duplicate");
    // Record the consent basis before the provider call so the audit trail
    // shows why an unsubscribed-flagged contact was mailed.
    const items = this.deps.items.listByDraft(queue.id, draft.id);
    for (const row of items) {
      if (row.kind === "initial" && row.status === "SENDING") this.deps.items.setConsentSource(row.id, consentSource);
    }
    // The day slot is reserved atomically AFTER all gates pass and BEFORE the
    // provider call, and released when the provider call fails: sibling pump
    // workers can never jointly overshoot the daily limit, and failures do
    // not burn slots. Only provider-accepted sends consume the day.
    this.reserveSlot(queue);
    try {
      if (mode === "live") {
        const transport = this.deps.getEmailTransport?.();
        if (!transport || transport.name !== "brevo") throw new GateError("CONFIGURATION", "live sending requires EMAIL_PROVIDER=brevo");
        const from = readDefaultFrom(transport);
        if (!from.email) throw new GateError("CONFIGURATION", "no approved sender address configured");
        const html = rendered.stepHtml.split(AI_BODY_VAR).join(escapeHtml(draft.body));
        const result = await transport.send({
          from,
          to: [{ email: recipient }],
          subject: rendered.subject,
          html,
          text: draft.body,
          headers: { "X-Bridge-Draft": draft.id, "X-Bridge-Queue": queue.id },
        });
        return result.messageId || `brevo:${draft.id}:v${draft.version}`;
      }
      const direct = this.deps.getEmailTransport?.();
      if (direct && direct.name === "local") {
        const html = rendered.stepHtml.split(AI_BODY_VAR).join(escapeHtml(draft.body));
        const result = await direct.send({
          from: { email: "bridge@localhost", name: "Bridge" },
          to: [{ email: recipient }],
          subject: rendered.subject,
          html,
          text: draft.body,
          headers: { "X-Bridge-Draft": draft.id, "X-Bridge-Queue": queue.id },
        });
        return result.messageId || `local:${draft.id}:v${draft.version}`;
      }
      return await this.sendViaWarmblyTestEmail(queue, lead, draft, recipient, contactId);
    } catch (err) {
      if (!(err instanceof GateError)) this.releaseSlot(queue);
      throw err;
    }
  }

  // Atomic check-and-reserve of one daily slot. Synchronous transaction: no
  // async interleave can split the read from the increment, so N concurrent
  // pump workers hold at most `daily_limit` slots together.
  private reserveSlot(queue: SendQueueRow): void {
    const take = this.deps.db.transaction((queueId: string, day: string, limit: number): boolean => {
      const row = this.deps.db.prepare("SELECT count FROM send_day_counters WHERE queue_id = ? AND day = ?").get(queueId, day) as { count: number } | undefined;
      if ((row?.count ?? 0) >= limit) return false;
      this.deps.db
        .prepare(
          `INSERT INTO send_day_counters (queue_id, day, count) VALUES (?, ?, 1)
           ON CONFLICT(queue_id, day) DO UPDATE SET count = count + 1`,
        )
        .run(queueId, day);
      return true;
    });
    if (!take(queue.id, dayKeyInZone(queue.timezone), queue.daily_limit)) {
      throw new SlotDeferred();
    }
  }

  private releaseSlot(queue: SendQueueRow): void {
    this.deps.db
      .prepare("UPDATE send_day_counters SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE queue_id = ? AND day = ?")
      .run(queue.id, dayKeyInZone(queue.timezone));
  }

  private async contactSubscribed(
    queue: SendQueueRow,
    lead: { email: string | null; warmbly_contact_id: string | null },
    contactId: string | null,
  ): Promise<boolean> {
    void queue;
    let id = contactId;
    if (!id && lead.email) {
      try {
        const found = await this.deps.warmbly.lookupContactByEmail(lead.email);
        id = found?.id ?? null;
      } catch (err) {
        throw new Error(`gate-lookup: contact lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!id) return false;
    try {
      const contact = await this.deps.warmbly.getContact(id);
      return contact.subscribed;
    } catch (err) {
      throw new Error(`gate-lookup: contact read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sendViaWarmblyTestEmail(
    queue: SendQueueRow,
    lead: { email: string | null; warmbly_contact_id: string | null },
    draft: { id: string; lead_id: string },
    recipient: string,
    contactId: string | null,
  ): Promise<string> {
    void lead;
    void draft;
    let accounts: Array<{ id: string; email: string; status: string }>;
    try {
      accounts = await this.deps.warmbly.listAccounts();
    } catch (err) {
      throw new Error(`gate-lookup: mailbox list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (accounts.length === 0) throw new GateError("CONFIGURATION", "no sending mailbox connected in Warmbly");
    if (["blocked", "suspended", "invalid"].includes(accounts[0].status.toLowerCase())) {
      throw new GateError("CONFIGURATION", "sending mailbox is not healthy");
    }
    const run = this.deps.runs.get(queue.run_id);
    if (!run) throw new GateError("SAFETY_BLOCK", "campaign run missing");
    let steps: Array<{ id: string; name?: string | null }>;
    try {
      steps = await this.deps.warmbly.listSteps(run.warmbly_campaign_id);
    } catch (err) {
      throw new Error(`gate-lookup: step list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const step = steps.find((s) => s.name === "AI Outreach") ?? steps[0];
    if (!step) throw new GateError("CONFIGURATION", "campaign has no prepared step to send");
    const sent = await this.deps.warmbly.sendTestEmail({
      campaignId: run.warmbly_campaign_id,
      accountId: accounts[0].id,
      recipient,
      stepId: step.id,
      ...(contactId ? { contactId } : {}),
    });
    return `warmbly-test:${sent.step_id}`;
  }

  private async deliverFollowup(queue: SendQueueRow, item: SendItemRow, followup: FollowupRow): Promise<string> {
    const mode = this.deps.config.SEND_MODE;
    const runOffers = this.runOffers(queue.run_id);
    let rendered: { subject: string; stepHtml: string; snapshot: string };
    try {
      rendered = await renderOutreach({ aiSubject: followup.subject, aiBodyText: followup.body, offers: runOffers });
    } catch (err) {
      throw new GateError("SAFETY_BLOCK", `follow-up content no longer renders: ${err instanceof Error ? err.message : String(err)}`);
    }
    const html = rendered.stepHtml.split(AI_BODY_VAR).join(escapeHtml(followup.body));
    const subject = followup.subject.toLowerCase().startsWith("re:") ? followup.subject : `Re: ${followup.subject}`;
    const thread = await this.threadHeaders(queue, item);
    this.reserveSlot(queue);
    try {
      if (mode === "live") {
        const transport = this.deps.getEmailTransport?.();
        if (!transport || transport.name !== "brevo") throw new GateError("CONFIGURATION", "live sending requires EMAIL_PROVIDER=brevo");
        const from = readDefaultFrom(transport);
        if (!from.email) throw new GateError("CONFIGURATION", "no approved sender address configured");
        const result = await transport.send({
          from,
          to: [{ email: item.recipient }],
          subject,
          html,
          text: followup.body,
          inReplyTo: thread.inReplyTo,
          references: thread.references,
          headers: { "X-Bridge-Followup": followup.id, "X-Bridge-Queue": queue.id },
        });
        return result.messageId || `brevo:${followup.id}`;
      }
      const direct = this.deps.getEmailTransport?.();
      if (!direct || direct.name !== "local") throw new GateError("CONFIGURATION", "local follow-ups need EMAIL_PROVIDER=local or a Warmbly mailbox");
      const result = await direct.send({
        from: { email: "bridge@localhost", name: "Bridge" },
        to: [{ email: item.recipient }],
        subject,
        html,
        text: followup.body,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
        headers: { "X-Bridge-Followup": followup.id, "X-Bridge-Queue": queue.id },
      });
      return result.messageId || `local:${followup.id}`;
    } catch (err) {
      if (!(err instanceof GateError)) this.releaseSlot(queue);
      throw err;
    }
  }

  // Threading reuses the provider Message-IDs the queue itself recorded. The
  // chain is only as real as those IDs: genuine on SMTP paths (nodemailer
  // Message-ID headers), opaque on the Warmbly test path.
  private async threadHeaders(queue: SendQueueRow, item: SendItemRow): Promise<{ inReplyTo?: string; references?: string }> {
    const draft = this.deps.drafts.get(item.draft_id);
    if (!draft) return {};
    const chain = this.deps.items.listByDraft(queue.id, draft.id);
    const sentThread = chain.filter((r) => r.status === "SENT" && r.provider_message_id);
    if (sentThread.length === 0) return {};
    const ids = sentThread.map((r) => r.provider_message_id as string).filter((id) => id.includes("@"));
    if (ids.length === 0) return {};
    const parent = ids[ids.length - 1];
    return { inReplyTo: parent, references: ids.join(" ") };
  }

  // One threaded answer inside an existing conversation (reply responses).
  // Consumes a daily slot and the live cap like any other real send, but skips
  // the draft-approval gates: the human approved this exact response. The
  // Warmbly test path cannot set threading headers, so responses need a real
  // SMTP transport (local Mailpit or live Brevo).
  async sendThreadedReply(
    queueId: string,
    msg: { to: string; subject: string; html: string; text: string; inReplyTo?: string; references?: string; headerKey: string },
  ): Promise<string> {
    const queue = this.deps.queues.get(queueId);
    if (!queue) throw new GateError("SAFETY_BLOCK", "send queue missing");
    if (queue.status === QUEUE_STATUS.CANCELLED) throw new GateError("SAFETY_BLOCK", "queue is cancelled");
    const mode = this.deps.config.SEND_MODE;
    if (mode !== "local" && mode !== "live") throw new GateError("CONFIGURATION", "sending is disabled (SEND_MODE must be local or live)");
    if (mode === "live" && this.liveSentCount(queueId) >= queue.max_live_sends) {
      throw new GateError("CONFIGURATION", `live cap reached (${queue.max_live_sends}); raise it explicitly to send more`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(msg.to.trim())) throw new GateError("CONFIGURATION", "invalid recipient email");
    let suppressed: boolean;
    try {
      suppressed = await this.deps.warmbly.isSuppressed(msg.to.trim().toLowerCase());
    } catch (err) {
      throw new Error(`gate-lookup: suppression check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (suppressed) throw new GateError("SUPPRESSION", "recipient is on the workspace suppression list");
    const transport = this.deps.getEmailTransport?.();
    // Local mode is Mailpit-only for responses: accepting the brevo relay
    // here would send real mail while the operator believes nothing can
    // leave. Matches the follow-up path, which also refuses anything but
    // the local transport outside live mode.
    const usable = mode === "live" ? transport?.name === "brevo" : transport?.name === "local";
    if (!transport || !usable) {
      throw new GateError("CONFIGURATION", mode === "live" ? "live responses require EMAIL_PROVIDER=brevo" : "local responses need EMAIL_PROVIDER=local");
    }
    const from = readDefaultFrom(transport);
    // Live mode needs the approved sender (the relay rejects anything
    // else); local Mailpit accepts the bridge fallback address.
    const resolvedFrom = from.email ? from : mode === "live" ? { email: "" } : { email: "bridge@localhost", name: "Bridge" };
    if (!resolvedFrom.email) throw new GateError("CONFIGURATION", "no approved sender address configured");
    if (!resolvedFrom.email) throw new GateError("CONFIGURATION", "no approved sender address configured");
    this.reserveSlot(queue);
    try {
      const result = await transport.send({
        from: resolvedFrom,
        to: [{ email: msg.to.trim().toLowerCase() }],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        inReplyTo: msg.inReplyTo,
        references: msg.references,
        headers: { "X-Bridge-Response": msg.headerKey, "X-Bridge-Queue": queueId },
      });
      return result.messageId || `${transport.name}:${msg.headerKey}`;
    } catch (err) {
      if (!(err instanceof GateError)) this.releaseSlot(queue);
      throw err;
    }
  }

  private scheduleFollowups(queue: SendQueueRow, item: SendItemRow, draft: { id: string }, recipient: string, providerMessageId: string): void {
    void providerMessageId;
    if (queue.followup_enabled !== 1) return;
    const offsets = this.followupOffsets(queue);
    const base = Date.parse(item.sent_at ?? "") || Date.now();
    offsets.forEach((days, i) => {
      const seq = i + 1;
      const due = new Date(base + days * 86400_000).toISOString();
      this.deps.items.enqueue({
        id: randomUUID(),
        queueId: queue.id,
        draftId: draft.id,
        draftVersion: item.draft_version,
        kind: `followup:${seq}`,
        seq,
        recipient,
        idempotencyKey: `queue:${queue.id}:draft:${draft.id}:v${item.draft_version}:followup:${seq}`,
        provider: this.providerFor(queue),
        scheduledFor: due,
      });
    });
  }

  private enqueueApproved(queue: SendQueueRow): number {
    let enqueued = 0;
    for (const draft of this.approvedDrafts(queue.run_id)) {
      if (!draft.email) continue;
      const { duplicate } = this.deps.items.enqueue({
        id: randomUUID(),
        queueId: queue.id,
        draftId: draft.id,
        draftVersion: draft.version,
        kind: "initial",
        seq: 0,
        recipient: draft.email.trim().toLowerCase(),
        idempotencyKey: `queue:${queue.id}:draft:${draft.id}:v${draft.version}:initial`,
        provider: this.providerFor(queue),
      });
      if (!duplicate) enqueued += 1;
    }
    return enqueued;
  }

  private approvedDrafts(runId: string): Array<{ id: string; version: number; email: string | null }> {
    return this.deps.drafts
      .listByRun(runId, 10000, 0)
      .filter((d) => d.status === "APPROVED")
      .map((d) => ({ id: d.id, version: d.version, email: (d as { email?: string | null }).email ?? null }));
  }

  private requeueModeBlocked(queueId: string): void {
    this.sql(
      `UPDATE send_items SET status = 'QUEUED', error_code = NULL, error_message = NULL, updated_at = ?
       WHERE queue_id = ? AND status = 'BLOCKED' AND error_code = 'CONFIGURATION'`,
    ).run(utcNow(), queueId);
  }

  private maybeComplete(queue: SendQueueRow): boolean {
    if (!this.deps.items.hasUnfinished(queue.id)) {
      this.deps.queues.setStatus(queue.id, QUEUE_STATUS.COMPLETED);
      this.deps.events.append({ kind: "queue.completed", campaignRunId: queue.run_id });
      return true;
    }
    return false;
  }

  private nextWakeup(queueId: string): number {
    const row = this.sql(
      `SELECT MIN(COALESCE(next_attempt_at, scheduled_for)) AS at FROM send_items
       WHERE queue_id = ? AND status IN ('QUEUED','RETRYABLE')`,
    ).get(queueId) as { at: string | null };
    const at = row?.at ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at)) return 3600_000;
    return Math.max(1000, Math.min(6 * 3600_000, at - Date.now()));
  }

  private nextDayBoundary(timezone: string): number {
    void timezone;
    // The pump re-reads the timezone day key every iteration, so this only
    // sets the recheck cost: hourly until the counter window rolls over.
    return 3600_000;
  }

  private scheduleWakeup(queue: SendQueueRow, delayMs: number): void {
    if (this.shuttingDown) return;
    if (this.timers.has(queue.id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(queue.id);
      const fresh = this.deps.queues.get(queue.id);
      if (fresh?.status === QUEUE_STATUS.ACTIVE) {
        void this.pump(queue.id).catch((err) => {
          log("error", "scheduled bulk pump failed", { queueId: queue.id, error: err instanceof Error ? err.message : String(err) });
        });
      }
    }, Math.max(1000, Math.min(6 * 3600_000, delayMs)));
    this.timers.set(queue.id, timer);
  }

  private requireQueue(runId: string): SendQueueRow {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    return queue;
  }

  private followupOffsets(queue: SendQueueRow): number[] {
    try {
      const parsed: unknown = JSON.parse(queue.followup_days);
      if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n) && (n as number) > 0)) {
        return parsed as number[];
      }
    } catch {
      // Corrupt row falls back to config rather than failing the queue.
    }
    return parseDayOffsets(this.deps.config.FOLLOWUP_DAY_OFFSETS);
  }

  private runOffers(runId: string): string[] {
    const run = this.deps.runs.get(runId);
    if (!run) return [];
    return [run.offer_url_1, run.offer_url_2, run.offer_url_3].filter((u): u is string => !!u);
  }

  private parseOffers(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  private sameStrings(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  private providerFor(queue: SendQueueRow): string {
    void queue;
    if (this.deps.config.SEND_MODE === "live") return "brevo";
    const transport = this.deps.getEmailTransport?.();
    if (transport && transport.name === "local") return "local";
    return "warmbly-test";
  }

  private async senderLabel(queue: SendQueueRow): Promise<string> {
    void queue;
    if (this.deps.config.SEND_MODE === "live") {
      const transport = this.deps.getEmailTransport?.();
      return readDefaultFrom(transport ?? null).email || "(unconfigured)";
    }
    const direct = this.deps.getEmailTransport?.();
    if (direct && direct.name === "local") return "Mailpit (local)";
    try {
      const accounts = await this.deps.warmbly.listAccounts();
      return accounts[0]?.email ?? "(no mailbox)";
    } catch {
      return "(mailbox lookup failed)";
    }
  }

  private liveSentCount(queueId: string): number {
    const row = this.sql("SELECT COUNT(*) AS n FROM send_items WHERE queue_id = ? AND status = 'SENT' AND provider = 'brevo'").get(queueId) as { n: number };
    return row.n;
  }

  // The reconciliation mirror: send state lands on the Warmbly contact as
  // flat custom fields, merged with whatever is already there. Best effort
  // by design: a mirror failure is logged, never allowed to fail the send.
  private async mirrorToWarmbly(
    queue: SendQueueRow,
    draft: { id: string; lead_id: string },
    recipient: string,
    providerMessageId: string,
  ): Promise<void> {
    try {
      const lead = this.deps.leads.get(draft.lead_id);
      const contactId = lead?.warmbly_contact_id;
      if (!contactId) return;
      let existing: Record<string, string> = {};
      try {
        existing = (await this.deps.warmbly.getContact(contactId)).custom_fields ?? {};
      } catch {
        existing = {};
      }
      await this.deps.warmbly.updateContact(contactId, {
        custom_fields: {
          ...existing,
          ai_send_status: "sent",
          ai_sent_at: utcNow(),
          ai_message_id: providerMessageId.slice(0, 200),
          ai_send_queue: queue.id,
        },
      });
    } catch (err) {
      log("warn", "warmbly send mirror failed", { draftId: draft.id, recipient, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async mirrorFollowupToWarmbly(queue: SendQueueRow, followup: FollowupRow, recipient: string, providerMessageId: string): Promise<void> {
    try {
      const lead = this.deps.leads.get(followup.lead_id);
      const contactId = lead?.warmbly_contact_id;
      if (!contactId) return;
      let existing: Record<string, string> = {};
      try {
        existing = (await this.deps.warmbly.getContact(contactId)).custom_fields ?? {};
      } catch {
        existing = {};
      }
      await this.deps.warmbly.updateContact(contactId, {
        custom_fields: {
          ...existing,
          ai_send_status: `followup-${followup.seq}-sent`,
          ai_sent_at: utcNow(),
          ai_message_id: providerMessageId.slice(0, 200),
          ai_send_queue: queue.id,
        },
      });
    } catch (err) {
      log("warn", "warmbly followup mirror failed", { followupId: followup.id, recipient, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Test/operator hook: record an inbound signal (reply, unsubscribe) that
  // halts future sends for that address. Reply sync automation is out of
  // scope; this is the seam it will write through.
  recordSignal(runId: string, input: { email: string; kind: string; leadId?: string }): void {
    const queue = this.requireQueue(runId);
    if (!isValidEmail(input.email)) throw new Error("valid email required");
    if (!["replied", "unsubscribed", "complained"].includes(input.kind)) throw new Error("unknown signal kind");
    this.deps.signals.record(queue.id, randomUUID(), input.email, input.kind, input.leadId ?? null);
    this.deps.events.append({ kind: "signal.recorded", campaignRunId: runId, message: `${input.kind}:${input.email}` });
  }

  approveFollowup(followupId: string): FollowupRow {
    const row = this.deps.followups.get(followupId);
    if (!row) throw new Error("follow-up not found");
    if (row.status !== FOLLOWUP_STATUS.NEEDS_REVIEW) throw new Error(`cannot approve a follow-up in status ${row.status}`);
    // Approval re-renders through the template layer so what sends is exactly
    // what was reviewed; the item becomes due immediately.
    const queue = this.deps.queues.get(row.queue_id);
    if (!queue) throw new Error("send queue missing");
    if (queue.status === QUEUE_STATUS.CANCELLED) throw new Error("queue is cancelled");
    this.deps.followups.setStatus(followupId, FOLLOWUP_STATUS.APPROVED);
    const item = this.sql("SELECT * FROM send_items WHERE followup_id = ?").get(followupId) as SendItemRow | undefined;
    if (item && (item.status === ITEM_STATUS.QUEUED || item.status === ITEM_STATUS.RETRYABLE)) {
      // Back to QUEUED with no dates: RETRYABLE rows with a cleared
      // next_attempt_at would never be claimed again.
      this.sql("UPDATE send_items SET status = 'QUEUED', scheduled_for = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(utcNow(), item.id);
    }
    this.deps.events.append({ kind: "followup.approved", campaignRunId: queue.run_id, leadId: row.lead_id, message: `seq=${row.seq}` });
    return this.deps.followups.get(followupId) as FollowupRow;
  }

  rejectFollowup(followupId: string): FollowupRow {
    const row = this.deps.followups.get(followupId);
    if (!row) throw new Error("follow-up not found");
    this.deps.followups.setStatus(followupId, FOLLOWUP_STATUS.REJECTED);
    const item = this.sql("SELECT * FROM send_items WHERE followup_id = ?").get(followupId) as SendItemRow | undefined;
    if (item) this.deps.items.markTerminal(item.id, "BLOCKED", "SAFETY_BLOCK", "follow-up rejected by reviewer");
    return this.deps.followups.get(followupId) as FollowupRow;
  }

  listItems(runId: string, limit: number, offset: number): SendItemRow[] {
    const queue = this.requireQueue(runId);
    return this.deps.items.list(queue.id, limit, offset);
  }

  listFollowups(runId: string, limit: number, offset: number): FollowupRow[] {
    const queue = this.requireQueue(runId);
    return this.deps.followups.listByQueue(queue.id, limit, offset);
  }

  // Queue-scoped joins too small for their own repository methods run here
  // against the shared connection. better-sqlite3 statements are untyped at
  // the call site; rows are cast where they are read.
  private sql(sql: string): { run(...params: unknown[]): { changes: number }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] } {
    return this.deps.db.prepare(sql) as unknown as { run(...params: unknown[]): { changes: number }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  }
}

export class GateError extends Error {
  readonly code: SendErrorCode;
  constructor(code: SendErrorCode, message: string) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
}

// Internal flow control, never surfaced: a worker that lost the day-slot
// race returns its item to QUEUED and the pump waits for the next window.
class SlotDeferred extends Error {
  constructor() {
    super("daily slot exhausted");
    this.name = "SlotDeferred";
  }
}

function readDefaultFrom(transport: EmailTransport | null): { email: string; name?: string } {
  if (!transport) return { email: "" };
  const fn = (transport as unknown as { defaultFrom?: () => { email: string; name?: string } }).defaultFrom;
  if (typeof fn === "function") {
    try {
      return fn.call(transport);
    } catch {
      return { email: "" };
    }
  }
  return { email: "" };
}

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

// Follow-up render helper shared by approval-time checks: AI plain text plus
// the run's protected offers through the fixed template.
export async function renderFollowup(subject: string, body: string, offers: string[]): Promise<string> {
  const rendered = await renderOutreach({ aiSubject: subject, aiBodyText: body, offers });
  return rendered.stepHtml.split(AI_BODY_VAR).join(escapeHtml(body));
}
