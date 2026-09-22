import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import type { BridgeDb } from "../db.js";
import type { AgentRuntime } from "../ai/types.js";
import { OutreachSchema, ReplyAnalysisSchema } from "../domain/validate.js";
import { renderOutreach } from "../email/render.js";
import { AI_BODY_VAR } from "../email/template.js";
import { escapeHtml } from "../domain/validate.js";
import { log } from "../log.js";
import type { CampaignRuns, Drafts, Events, Leads, Research, Sends } from "../store/repositories.js";
import type { ContactSignals, DayCounters, FollowupDrafts, SendItems, SendQueues } from "../store/sendQueue.js";
import {
  InboundReplies,
  ReplyPolls,
  ResponseDrafts,
  REPLY_INTENT,
  RESPONSE_STATUS,
  type InboundReplyRow,
  type ResponseDraftRow,
} from "../store/replies.js";
import type { WarmblyClient, UniboxThreadMessage, UniboxFullMessage } from "../warmbly/client.js";
import { GateError } from "./bulkSend.js";

export interface ReplySyncDeps {
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
  replies: InboundReplies;
  responses: ResponseDrafts;
  polls: ReplyPolls;
  warmbly: WarmblyClient;
  createRuntime?: (provider: string) => AgentRuntime;
  // Threaded delivery through the queue's normal send path (daily slot,
  // live cap, suppression). Injected to avoid a bulkSend import cycle.
  sendThreaded?: (
    queueId: string,
    msg: { to: string; subject: string; html: string; text: string; inReplyTo?: string; references?: string; headerKey: string },
  ) => Promise<string>;
  retryBaseMs?: number;
}

// Source-agnostic inbound message. Warmbly unibox rows and Mailpit rows both
// normalize to this before matching, so the ingest pipeline is identical and
// only the fetcher differs per source.
export interface NormalizedInbound {
  key: string;
  warmblyId: string;
  rfcMessageId: string | null;
  threadId: string | null;
  fromEmail: string;
  subject: string;
  bodyText: string;
  receivedAt: string | null;
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.trim().toLowerCase().replace(/^<+|>+$/g, "").trim();
  return clean.includes("@") ? clean : null;
}

export function normalizeUniboxMessage(m: UniboxThreadMessage): NormalizedInbound {
  const from = (m.from_addr ?? []).map((a) => extractEmail(a)).find((a) => a.includes("@")) ?? "";
  return {
    key: `warmbly:${m.id}`,
    warmblyId: m.id,
    rfcMessageId: m.message_id ?? null,
    threadId: m.thread_id ?? null,
    fromEmail: from,
    subject: m.subject ?? "",
    bodyText: m.body_text ?? m.snippet ?? "",
    receivedAt: m.internal_date ?? null,
  };
}

// Full-message shape (GET /unibox/:id): different field names from the list
// rows, plus real bodies. Addresses may carry display names ("A <a@b>").
export function normalizeUniboxFull(m: UniboxFullMessage): NormalizedInbound {
  const from = (m.from ?? []).map((a) => extractEmail(a)).find((a) => a.includes("@")) ?? "";
  return {
    key: `warmbly:${m.id}`,
    warmblyId: m.id,
    rfcMessageId: m.message_id ?? null,
    threadId: m.thread_id ?? null,
    fromEmail: from,
    subject: m.subject ?? "",
    bodyText: m.body_plain ?? m.snippet ?? "",
    receivedAt: m.internal_date ?? null,
  };
}

function extractEmail(raw: string): string {
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

// Pure thread matching: the sender must be the lead, and the message must
// descend from something the queue actually sent (In-Reply-To ancestry hit)
// or share a recorded thread root. Our own sends never match: they fail the
// from==lead requirement, and the isOwnSend belt-and-braces below.
export interface MatchableInbound {
  fromEmail: string;
  rfcMessageId: string | null;
  threadId: string | null;
  inReplyTo: string[];
}

export function matchInbound(msg: MatchableInbound, leadEmail: string, sentIds: ReadonlySet<string>): boolean {
  if (!msg.fromEmail || msg.fromEmail !== leadEmail.trim().toLowerCase()) return false;
  for (const raw of msg.inReplyTo) {
    const n = normalizeMessageId(raw);
    if (n && sentIds.has(n)) return true;
  }
  const thread = normalizeMessageId(msg.threadId);
  if (thread && sentIds.has(thread)) return true;
  return false;
}

export function matchAncestry(msg: Pick<NormalizedInbound, "rfcMessageId" | "threadId"> & { inReplyTo?: string[] }, sentIds: ReadonlySet<string>): boolean {
  for (const raw of msg.inReplyTo ?? []) {
    const n = normalizeMessageId(raw);
    if (n && sentIds.has(n)) return true;
  }
  const thread = normalizeMessageId(msg.threadId);
  if (thread && sentIds.has(thread)) return true;
  return false;
}

// Minimum analysis confidence before a response may be drafted without an
// explicit operator instruction. Below it the reply waits for a human read.
const RESPONSE_CONFIDENCE_MIN = 0.5;

// Full-message opens per thread per poll. Threads can be long; only
// lead-sent messages newer than the cursor are ever opened.
const REPLY_THREAD_OPEN_MAX = 10;

function utcNow(): string {
  return new Date().toISOString();
}

export interface ReplyPollSummary {
  addresses: number;
  threads: number;
  ingested: number;
  analyzed: number;
  errors: number;
}

// Reply synchronization + analysis + human-gated responses for bridge-sent
// threads. Warmbly owns native-thread replies (its own draft/approve flow);
// this module touches only threads the queue can prove it started, matched by
// recorded Message-ID ancestry. Nothing here ever sends without an explicit
// human approval.
export class ReplySync {
  private readonly retryBaseMs: number;

  constructor(private readonly deps: ReplySyncDeps) {
    this.retryBaseMs = deps.retryBaseMs ?? 30_000;
  }

  // Incremental poll for one queue: distinct SENT-initial recipients without
  // a replied signal yet, bounded per pass. Cursor advances per address only
  // on success, so a failed poll retries the same window instead of skipping.
  async pollRunReplies(runId: string): Promise<ReplyPollSummary> {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    return this.pollQueueReplies(queue.id);
  }

  async pollQueueReplies(queueId: string): Promise<ReplyPollSummary> {
    const summary: ReplyPollSummary = { addresses: 0, threads: 0, ingested: 0, analyzed: 0, errors: 0 };
    const queue = this.deps.queues.get(queueId);
    if (!queue || queue.status === "CANCELLED") return summary;
    const batch = Math.max(1, this.deps.config.REPLY_POLL_BATCH);
    const addresses = this.pollAddresses(queueId, batch);
    summary.addresses = addresses.length;
    for (const { address, leadId } of addresses) {
      try {
        const seen = await this.pollAddress(queue, address, leadId, summary);
        this.deps.polls.record(queueId, address, seen, "ok");
      } catch (err) {
        summary.errors += 1;
        const cursor = this.deps.polls.get(queueId, address)?.last_seen ?? null;
        this.deps.polls.record(queueId, address, cursor, `error:${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`);
        log("warn", "reply poll failed", { queueId, address, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return summary;
  }

  private pollAddresses(queueId: string, limit: number): Array<{ address: string; leadId: string }> {
    // Recipients with a provider-accepted initial and no replied signal yet.
    // Follow-up-only threads are covered through their initial's recipient.
    const rows = this.deps.db
      .prepare(
        `SELECT DISTINCT i.recipient AS address, d.lead_id AS leadId
         FROM send_items i JOIN outreach_drafts d ON d.id = i.draft_id
         WHERE i.queue_id = ? AND i.kind = 'initial' AND i.status = 'SENT'
         ORDER BY i.sent_at ASC NULLS LAST, i.created_at ASC
         LIMIT 1000`,
      )
      .all(queueId) as Array<{ address: string; leadId: string }>;
    const out: Array<{ address: string; leadId: string }> = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (this.deps.signals.has(queueId, row.address, "replied")) continue;
      out.push(row);
    }
    return out;
  }

  private async pollAddress(
    queue: { id: string; run_id: string },
    address: string,
    leadId: string,
    summary: ReplyPollSummary,
  ): Promise<string | null> {
    const cursor = this.deps.polls.get(queue.id, address)?.last_seen ?? null;
    const since = cursor ? cursor.slice(0, 10) : undefined;
    const threads = await this.deps.warmbly.searchUniboxThreads({ address, direction: "received", since, limit: 25 });
    summary.threads += threads.length;
    const sentIds = this.sentMessageIds(queue.id);
    let maxSeen = cursor;
    for (const thread of threads) {
      // Thread rows carry no ancestry or bodies, so candidates (lead-sent,
      // newer than the cursor) are opened individually for the full read.
      // Opening marks read in Warmbly by design; only implicated messages
      // are opened, never whole threads.
      const listed = await this.deps.warmbly.getUniboxThread(thread.thread_id);
      const candidates = listed
        .filter((m) => {
          // Exact per-address match: a substring test would implicate
          // "xa@example.com" in a poll for "a@example.com".
          const senders = (m.from_addr ?? []).map((a) => extractEmail(a));
          if (!senders.includes(address)) return false;
          const at = m.internal_date ?? null;
          if (at && (!maxSeen || at > maxSeen)) maxSeen = at;
          return !cursor || !at || at > cursor;
        })
        .slice(0, REPLY_THREAD_OPEN_MAX);
      for (const preview of candidates) {
        const full = await this.deps.warmbly.getUniboxEmail(preview.id);
        const msg = normalizeUniboxFull(full);
        const matched = this.isThreadReply(msg, full.in_reply_to ?? [], address, sentIds);
        if (!matched) continue;
        const { duplicate, id } = this.deps.replies.insert({
          id: randomUUID(),
          queueId: queue.id,
          leadId,
          warmblyId: msg.warmblyId,
          rfcMessageId: msg.rfcMessageId,
          threadId: msg.threadId,
          fromEmail: msg.fromEmail,
          subject: msg.subject,
          bodyText: msg.bodyText,
          receivedAt: msg.receivedAt,
        });
        if (duplicate) continue;
        summary.ingested += 1;
        this.deps.signals.record(queue.id, randomUUID(), address, "replied", leadId);
        this.deps.events.append({ kind: "reply.received", campaignRunId: queue.run_id, leadId, message: msg.subject.slice(0, 160) });
        if (await this.tryAutoAnalyze(queue.run_id, id)) summary.analyzed += 1;
      }
    }
    return maxSeen;
  }

  private isThreadReply(msg: NormalizedInbound, inReplyTo: string[], leadEmail: string, sentIds: Set<string>): boolean {
    if (this.isOwnSend(msg)) return false;
    return matchInbound({ fromEmail: msg.fromEmail, rfcMessageId: msg.rfcMessageId, threadId: msg.threadId, inReplyTo }, leadEmail, sentIds);
  }

  // Our own sends echoed back (sent-folder sync, Brevo copies) must never
  // read as a reply: they carry our sender addresses, never the lead's. This
  // is belt-and-braces behind the from==lead requirement above.
  private isOwnSend(msg: NormalizedInbound): boolean {
    const from = msg.fromEmail;
    const brevo = (this.deps.config.BREVO_FROM_EMAIL ?? "").trim().toLowerCase();
    return (brevo !== "" && from === brevo) || from === "bridge@localhost";
  }

  private sentMessageIds(queueId: string): Set<string> {
    const rows = this.deps.db
      .prepare("SELECT provider_message_id AS id FROM send_items WHERE queue_id = ? AND status = 'SENT' AND provider_message_id IS NOT NULL")
      .all(queueId) as Array<{ id: string }>;
    const out = new Set<string>();
    for (const row of rows) {
      const n = normalizeMessageId(row.id);
      if (n) out.add(n);
    }
    return out;
  }

  private async tryAutoAnalyze(runId: string, replyId: string): Promise<boolean> {
    if (!this.deps.createRuntime) return false;
    try {
      await this.analyzeReply(replyId);
      return true;
    } catch (err) {
      log("warn", "reply auto-analysis failed", { replyId, error: err instanceof Error ? err.message : String(err) });
      this.deps.events.append({ kind: "reply.analysis_failed", campaignRunId: runId, message: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
      return false;
    }
  }

  // Source-agnostic ingest for proofs and tests: normalized messages (e.g.
  // from Mailpit) flow through the same match → dedupe → signal pipeline as
  // Warmbly unibox rows. Returns ingested reply ids.
  ingestNormalized(queueId: string, messages: NormalizedInbound[], inReplyToByKey: Record<string, string[]>): string[] {
    const queue = this.deps.queues.get(queueId);
    if (!queue) throw new Error("send queue missing");
    const sentIds = this.sentMessageIds(queueId);
    const out: string[] = [];
    // Resolve each message to its lead through SENT-initial recipients.
    const recipients = this.deps.db
      .prepare("SELECT DISTINCT i.recipient AS address, d.lead_id AS leadId FROM send_items i JOIN outreach_drafts d ON d.id = i.draft_id WHERE i.queue_id = ? AND i.kind = 'initial' AND i.status = 'SENT'")
      .all(queueId) as Array<{ address: string; leadId: string }>;
    const byAddress = new Map(recipients.map((r) => [r.address.trim().toLowerCase(), r.leadId]));
    for (const msg of messages) {
      const leadId = byAddress.get(msg.fromEmail);
      if (!leadId) continue;
      if (this.isOwnSend(msg)) continue;
      if (!matchAncestry({ rfcMessageId: msg.rfcMessageId, threadId: msg.threadId, inReplyTo: inReplyToByKey[msg.key] ?? [] }, sentIds)) continue;
      const { duplicate, id } = this.deps.replies.insert({
        id: randomUUID(),
        queueId,
        leadId,
        warmblyId: msg.warmblyId,
        rfcMessageId: msg.rfcMessageId,
        threadId: msg.threadId,
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        bodyText: msg.bodyText,
        receivedAt: msg.receivedAt,
      });
      if (duplicate) continue;
      out.push(id);
      this.deps.signals.record(queueId, randomUUID(), msg.fromEmail, "replied", leadId);
      this.deps.events.append({ kind: "reply.received", campaignRunId: queue.run_id, leadId, message: msg.subject.slice(0, 160) });
    }
    return out;
  }

  // OpenCode analysis: intent + confidence + summary + next step. Read-only:
  // it writes analysis rows and (for unsubscribe) a suppression signal, and
  // never drafts or sends anything.
  async analyzeReply(replyId: string, opts?: { force?: boolean }): Promise<InboundReplyRow> {
    const reply = this.deps.replies.get(replyId);
    if (!reply) throw new Error("reply not found");
    if (reply.analyzed_at && !opts?.force) return reply;
    if (!this.deps.createRuntime) throw new Error("no AI runtime configured");
    const queue = this.deps.queues.get(reply.queue_id);
    if (!queue) throw new Error("send queue missing");
    const lead = this.deps.leads.get(reply.lead_id);
    const prior = this.threadContext(queue.id, reply.lead_id);
    const runtime = this.deps.createRuntime(this.deps.config.AI_PROVIDER);
    try {
      // AI context is outreach material only: the reply text, what we sent,
      // lead facts. Never credentials, keys, or offer URLs.
      const prompt = [
        "Classify this cold-outreach reply. Answer exactly the requested shape.",
        `Business: ${lead?.business_name ?? "unknown"} (${lead?.website ?? "no website"})`,
        `What we sent (subject): ${prior.subject}`,
        `What we sent (body): ${prior.body}`,
        `Reply subject: ${reply.subject}`,
        `Reply body: ${reply.body_text}`,
        "Intents: positive (interested, asks more, wants to talk), negative (declines, not interested, wrong person), neutral (question, deferral, unclear), unsubscribe (remove/stop/unsubscribe), automated (out-of-office, auto-reply, bounce, receipt).",
      ].join("\n");
      const result = await runtime.executeStructured(
        {
          systemPrompt: "You classify sales-email replies. Reply with exactly the requested JSON shape.",
          prompt,
          timeoutMs: this.deps.config.AI_JOB_TIMEOUT_MS,
          title: `reply-analyze:${reply.id}`,
        },
        ReplyAnalysisSchema,
      );
      if (!result.ok || !result.data) throw new Error(`reply analysis failed: ${result.error?.code ?? "unknown"}`);
      this.deps.replies.storeAnalysis(reply.id, {
        intent: result.data.intent,
        confidence: result.data.confidence,
        summary: result.data.summary,
        action: result.data.suggested_action,
      });
      this.deps.events.append({ kind: "reply.analyzed", campaignRunId: queue.run_id, leadId: reply.lead_id, message: `${result.data.intent}:${result.data.confidence}` });
      if (result.data.intent === REPLY_INTENT.UNSUBSCRIBE) {
        this.deps.signals.record(queue.id, randomUUID(), reply.from_email, "unsubscribed", reply.lead_id);
        this.deps.events.append({ kind: "signal.recorded", campaignRunId: queue.run_id, leadId: reply.lead_id, message: `unsubscribed:${reply.from_email}` });
      }
      return this.deps.replies.get(reply.id) as InboundReplyRow;
    } finally {
      try {
        await runtime.close();
      } catch {
        // Provider close is best effort.
      }
    }
  }

  private threadContext(queueId: string, leadId: string): { subject: string; body: string } {
    const draft = this.deps.db
      .prepare(
        `SELECT d.subject AS subject, d.body AS body FROM outreach_drafts d
         JOIN leads l ON l.id = d.lead_id WHERE l.id = ? LIMIT 1`,
      )
      .get(leadId) as { subject: string; body: string } | undefined;
    void queueId;
    return { subject: draft?.subject ?? "", body: draft?.body ?? "" };
  }

  // Drafting policy: positive/neutral replies at or above the confidence
  // floor draft without further input; anything else needs an explicit
  // operator instruction; automated and unsubscribe replies never draft
  // (an unsubscribe must never receive a marketing answer, and answering a
  // robot risks a loop). Drafting never sends: rows are NEEDS_REVIEW.
  async draftResponse(replyId: string, opts?: { instruction?: string }): Promise<ResponseDraftRow> {
    const reply = this.deps.replies.get(replyId);
    if (!reply) throw new Error("reply not found");
    const existing = this.deps.responses.getByReply(replyId);
    // A parked generation may be retried; anything else present is a duplicate.
    if (existing && existing.status !== RESPONSE_STATUS.GENERATION_RETRYABLE && existing.status !== RESPONSE_STATUS.GENERATION_FAILED) {
      throw new Error(`a response already exists for this reply (${existing.status.toLowerCase()})`);
    }
    if (existing?.status === RESPONSE_STATUS.GENERATION_FAILED) {
      throw new Error("response generation failed permanently for this reply");
    }
    let analysis = reply.analysis_intent
      ? { intent: reply.analysis_intent, confidence: reply.analysis_confidence ?? 0 }
      : null;
    if (!analysis) {
      const analyzed = await this.analyzeReply(replyId);
      analysis = { intent: analyzed.analysis_intent ?? "neutral", confidence: analyzed.analysis_confidence ?? 0 };
    }
    if (analysis.intent === REPLY_INTENT.AUTOMATED || analysis.intent === REPLY_INTENT.UNSUBSCRIBE) {
      throw new Error(`replies classified as ${analysis.intent} never receive drafted responses`);
    }
    const instruction = (opts?.instruction ?? "").trim();
    if ((analysis.intent !== REPLY_INTENT.POSITIVE && analysis.intent !== REPLY_INTENT.NEUTRAL) || analysis.confidence < RESPONSE_CONFIDENCE_MIN) {
      if (!instruction) {
        throw new Error(`reply is ${analysis.intent} at confidence ${analysis.confidence}; pass an explicit instruction to draft anyway`);
      }
    }
    if (!this.deps.createRuntime) {
      this.parkResponseGeneration(reply, "no AI runtime configured");
      throw new Error("no AI runtime configured");
    }
    const queue = this.deps.queues.get(reply.queue_id);
    if (!queue) throw new Error("send queue missing");
    const lead = this.deps.leads.get(reply.lead_id);
    const prior = this.threadContext(queue.id, reply.lead_id);
    const runtime = this.deps.createRuntime(this.deps.config.AI_PROVIDER);
    try {
      const prompt = [
        `Write a short reply to this prospect's message in our cold-outreach thread.`,
        `Business: ${lead?.business_name ?? "unknown"}`,
        `What we sent: ${prior.subject} / ${prior.body}`,
        `Their reply: ${reply.subject} / ${reply.body_text}`,
        instruction ? `Operator instruction: ${instruction}` : "Be helpful and human; answer what was asked.",
        "Return exactly: subject (max 120 chars) and body (plain text, no HTML, no URLs, no signature, no footer).",
      ].join("\n");
      const result = await runtime.executeStructured(
        {
          systemPrompt: "You write short, human sales replies. Reply with exactly the requested JSON shape.",
          prompt,
          timeoutMs: this.deps.config.AI_JOB_TIMEOUT_MS,
          title: `response-draft:${reply.id}`,
        },
        OutreachSchema,
      );
      if (!result.ok || !result.data) throw new Error(`response drafting failed: ${result.error?.code ?? "unknown"}`);
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.deps.db
          .prepare("UPDATE response_drafts SET subject = ?, body = ?, status = 'NEEDS_REVIEW', version = version + 1, error_message = NULL, updated_at = ? WHERE id = ?")
          .run(result.data.subject, result.data.body, utcNow(), id);
      } else {
        this.deps.responses.create({
          id,
          queueId: queue.id,
          leadId: reply.lead_id,
          replyId: reply.id,
          subject: result.data.subject,
          body: result.data.body,
          status: RESPONSE_STATUS.NEEDS_REVIEW,
          inReplyTo: reply.rfc_message_id,
        });
      }
      this.deps.events.append({ kind: "response.drafted", campaignRunId: queue.run_id, leadId: reply.lead_id, message: reply.id });
      return this.deps.responses.get(id) as ResponseDraftRow;
    } catch (err) {
      this.parkResponseGeneration(reply, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      try {
        await runtime.close();
      } catch {
        // Provider close is best effort.
      }
    }
  }

  private parkResponseGeneration(reply: InboundReplyRow, error: string): void {
    const existing = this.deps.responses.getByReply(reply.id);
    if (existing) {
      if (existing.attempts + 1 >= this.deps.config.SEND_MAX_ATTEMPTS) {
        this.deps.responses.setStatus(existing.id, RESPONSE_STATUS.GENERATION_FAILED, error);
      } else {
        this.deps.responses.markGenerationRetryable(existing.id, error);
      }
      return;
    }
    const id = randomUUID();
    this.deps.responses.create({
      id,
      queueId: reply.queue_id,
      leadId: reply.lead_id,
      replyId: reply.id,
      subject: "",
      body: "",
      status: RESPONSE_STATUS.GENERATION_RETRYABLE,
      inReplyTo: reply.rfc_message_id,
    });
    this.deps.events.append({ kind: "response.generation_failed", campaignRunId: this.deps.queues.get(reply.queue_id)?.run_id ?? "", leadId: reply.lead_id, message: error.slice(0, 160) });
  }

  // Approval sends exactly one threaded answer, synchronously: the human
  // click IS the send authorization. Gates re-checked at send time: queue
  // alive, no newer reply arrived, contact not unsubscribed/suppressed,
  // response content renders, daily slot + live cap hold.
  async approveResponse(responseId: string): Promise<ResponseDraftRow> {
    const row = this.deps.responses.get(responseId);
    if (!row) throw new Error("response not found");
    if (row.status !== RESPONSE_STATUS.NEEDS_REVIEW) throw new Error(`cannot approve a response in status ${row.status}`);
    const queue = this.deps.queues.get(row.queue_id);
    if (!queue) throw new Error("send queue missing");
    if (queue.status === "CANCELLED") {
      this.deps.responses.setStatus(row.id, RESPONSE_STATUS.BLOCKED, "queue is cancelled");
      throw new Error("queue is cancelled");
    }
    const reply = this.deps.replies.get(row.reply_id);
    if (!reply) throw new Error("parent reply missing");
    if (this.deps.replies.hasNewer(queue.id, row.lead_id, reply.received_at, reply.id)) {
      this.deps.responses.setStatus(row.id, RESPONSE_STATUS.BLOCKED, "a newer reply arrived; review it first");
      throw new Error("a newer reply arrived since this draft; review the latest mail first");
    }
    const lead = this.deps.leads.get(row.lead_id);
    const email = (lead?.email ?? reply.from_email).trim().toLowerCase();
    if (this.deps.signals.has(queue.id, email, "unsubscribed")) {
      this.deps.responses.setStatus(row.id, RESPONSE_STATUS.BLOCKED, "recipient unsubscribed");
      throw new Error("recipient unsubscribed; response blocked");
    }
    if (!this.deps.sendThreaded) throw new Error("response sending is not wired");
    const runOffers = this.runOffers(queue.run_id);
    let html: string;
    try {
      const rendered = await renderOutreach({ aiSubject: row.subject, aiBodyText: row.body, offers: runOffers });
      html = rendered.stepHtml.split(AI_BODY_VAR).join(escapeHtml(row.body));
    } catch (err) {
      throw new Error(`response content no longer renders: ${err instanceof Error ? err.message : String(err)}`);
    }
    const subject = row.subject.toLowerCase().startsWith("re:") ? row.subject : `Re: ${row.subject}`;
    const references = this.threadReferences(queue.id, row.lead_id, reply);
    try {
      const providerMessageId = await this.deps.sendThreaded(queue.id, {
        to: email,
        subject,
        html,
        text: row.body,
        inReplyTo: reply.rfc_message_id ?? undefined,
        references: references ?? undefined,
        headerKey: row.id,
      });
      this.deps.responses.markSent(row.id, providerMessageId);
      this.deps.events.append({ kind: "response.sent", campaignRunId: queue.run_id, leadId: row.lead_id, message: row.id });
      this.mirrorResponse(queue, row, email, providerMessageId);
      return this.deps.responses.get(row.id) as ResponseDraftRow;
    } catch (err) {
      if (err instanceof GateError) {
        this.deps.responses.setStatus(row.id, RESPONSE_STATUS.BLOCKED, err.message);
      }
      throw err;
    }
  }

  rejectResponse(responseId: string): ResponseDraftRow {
    const row = this.deps.responses.get(responseId);
    if (!row) throw new Error("response not found");
    this.deps.responses.setStatus(responseId, RESPONSE_STATUS.REJECTED);
    this.deps.events.append({ kind: "response.rejected", campaignRunId: this.deps.queues.get(row.queue_id)?.run_id ?? "", leadId: row.lead_id });
    return this.deps.responses.get(responseId) as ResponseDraftRow;
  }

  private threadReferences(queueId: string, leadId: string, reply: InboundReplyRow): string | null {
    const rows = this.deps.db
      .prepare("SELECT provider_message_id AS id FROM send_items WHERE queue_id = ? AND status = 'SENT' AND provider_message_id IS NOT NULL")
      .all(queueId) as Array<{ id: string }>;
    void leadId;
    const ids = rows.map((r) => normalizeMessageId(r.id)).filter((id): id is string => !!id);
    const replyId = normalizeMessageId(reply.rfc_message_id);
    const chain = [...ids];
    if (replyId && !chain.includes(replyId)) chain.push(replyId);
    return chain.length > 0 ? chain.map((id) => (id.startsWith("<") ? id : `<${id}>`)).join(" ") : null;
  }

  private runOffers(runId: string): string[] {
    const run = this.deps.runs.get(runId);
    if (!run) return [];
    return [run.offer_url_1, run.offer_url_2, run.offer_url_3].filter((u): u is string => !!u);
  }

  private mirrorResponse(
    queue: { id: string; run_id: string },
    row: ResponseDraftRow,
    recipient: string,
    providerMessageId: string,
  ): void {
    void (async () => {
      try {
        const lead = this.deps.leads.get(row.lead_id);
        const contactId = lead?.warmbly_contact_id;
        if (!contactId) return;
        let existing: Record<string, string> = {};
        try {
          existing = (await this.deps.warmbly.getContact(contactId)).custom_fields ?? {};
        } catch {
          existing = {};
        }
        await this.deps.warmbly.updateContact(contactId, {
          custom_fields: { ...existing, ai_send_status: "response-sent", ai_sent_at: utcNow(), ai_message_id: providerMessageId.slice(0, 200), ai_send_queue: queue.id },
        });
      } catch (err) {
        log("warn", "warmbly response mirror failed", { responseId: row.id, recipient, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  listReplies(runId: string, limit: number, offset: number): InboundReplyRow[] {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    return this.deps.replies.listByQueue(queue.id, limit, offset);
  }

  listResponses(runId: string, limit: number, offset: number): ResponseDraftRow[] {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    return this.deps.responses.listByQueue(queue.id, limit, offset);
  }

  replyMetrics(runId: string): Record<string, unknown> {
    const queue = this.deps.queues.getByRun(runId);
    if (!queue) throw new Error("no send queue for this campaign run");
    const replies = this.deps.replies.listByQueue(queue.id, 10000, 0);
    const intents: Record<string, number> = {};
    let analyzed = 0;
    for (const r of replies) {
      if (r.analysis_intent) {
        analyzed += 1;
        intents[r.analysis_intent] = (intents[r.analysis_intent] ?? 0) + 1;
      }
    }
    return { replies: replies.length, analyzed, intents, responses: this.deps.responses.countsByStatus(queue.id) };
  }
}
