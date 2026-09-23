import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import type { BridgeDb } from "../db.js";
import { REPLY_PROCESS_STATE, type InboundReplyRow } from "../store/replies.js";
import type { InboundReplies, ResponseDrafts } from "../store/replies.js";
import type { Events } from "../store/repositories.js";
import { log } from "../log.js";

// Error classification for reply processing. Transient classes retry; the
// rest are terminal so a permanent failure never burns attempts forever.
// UNSUBSCRIBE_SIGNAL is not here on purpose: an unsubscribe is a classified
// outcome (analysis succeeded), never an AI failure to retry.
export type ReplyErrorClass =
  | "WARM_BLY_UNAVAILABLE"
  | "SYNC_TIMEOUT"
  | "OPEN_CODE_UNAVAILABLE"
  | "OPEN_CODE_TIMEOUT"
  | "INVALID_AI_OUTPUT"
  | "PERSISTENCE_FAILURE"
  | "UNMATCHED_REPLY"
  | "AMBIGUOUS_REPLY"
  | "PROCESSING_ERROR";

const TRANSIENT_CLASSES = new Set<ReplyErrorClass>([
  "WARM_BLY_UNAVAILABLE",
  "SYNC_TIMEOUT",
  "OPEN_CODE_UNAVAILABLE",
  "OPEN_CODE_TIMEOUT",
  "INVALID_AI_OUTPUT",
  "PERSISTENCE_FAILURE",
  "PROCESSING_ERROR",
]);

// Maps a raw failure to its classification. Anything unrecognized stays
// transient-but-bounded (PROCESSING_ERROR) rather than failing open.
export function classifyReplyError(err: unknown): ReplyErrorClass {
  const message = err instanceof Error ? err.message : String(err);
  // OpenCode provider error codes come through verbatim in the failure text
  // (ai_unavailable/ai_timeout/ai_invalid from describeTransportError).
  if (/ai_unavailable|no AI runtime|unknown AI provider/i.test(message)) return "OPEN_CODE_UNAVAILABLE";
  if (/ai_timeout|timed? ?out|deadline/i.test(message)) return "OPEN_CODE_TIMEOUT";
  if (/ai_invalid|schema validation|failed schema/i.test(message)) return "INVALID_AI_OUTPUT";
  if (/WarmblyApiError|warmbly.*unavailable|503|502|429/i.test(message)) return "WARM_BLY_UNAVAILABLE";
  if (/SQLITE|database|persistence/i.test(message)) return "PERSISTENCE_FAILURE";
  return "PROCESSING_ERROR";
}

export interface ReplyWorkerDeps {
  config: BridgeConfig;
  db: BridgeDb;
  replies: InboundReplies;
  responses: ResponseDrafts;
  events: Events;
  // The full analysis + auto-draft step. Receives the claimed reply; returns
  // true when analysis (and any permitted auto-draft) completed. Throwing is
  // classified and either retried or failed terminally.
  processReply: (reply: InboundReplyRow) => Promise<boolean>;
  // Queue ids with SENT initials and no replied-signal resolution pending —
  // i.e. queues whose replies may still need analysis work.
  queueIdsWithSent: () => string[];
  // Ingestion step: runs the bounded Warmbly unibox poll for every live
  // queue (Warmbly owns mailbox sync; this only reads its normalized API).
  // Optional so deterministic unit tests can construct a worker without a
  // Warmbly fixture; production wiring always provides it.
  pollQueues?: () => Promise<void>;
  intervalMs?: number;
  leaseMs?: number;
}

export interface ReplyWorkerStatus {
  enabled: boolean;
  state: "STOPPED" | "RUNNING" | "ERROR";
  connected: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  claimable: number;
  analyzing: number;
  awaitingApproval: number;
  failed: number;
  ambiguous: number;
  processedTotal: number;
  failureTotal: number;
}

// One process-wide inbox worker (never one loop per campaign). Each tick it:
//   1. claims bounded claimable replies (RECEIVED/MATCHED/RETRYABLE, unexpired
//      lease) and runs analysis through OpenCode in a fresh session;
//   2. on success the reply reaches ANALYZED and the reply may auto-draft a
//      NEEDS_REVIEW response (positive/neutral above the confidence floor) —
//      never sends anything;
//   3. on transient failure marks RETRYABLE (bounded attempts), on permanent
//      failure FAILED, never touching an unsubscribe as an AI failure.
// A kill between claim and analysis leaves the reply ANALYZING with a lease;
// the expired lease makes it claimable again after restart, and the dedupe
// key (queue, warmbly id) plus response uniqueness keep the resume from
// forking duplicates.
export class ReplyWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;
  private connected = false;
  private processedTotal = 0;
  private failureTotal = 0;
  private readonly intervalMs: number;
  private readonly leaseMs: number;

  constructor(private readonly deps: ReplyWorkerDeps) {
    this.intervalMs = deps.intervalMs ?? deps.config.REPLY_WORKER_INTERVAL_MS;
    this.leaseMs = deps.leaseMs ?? deps.config.REPLY_WORKER_LEASE_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
    log("info", "reply worker started", { intervalMs: this.intervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log("info", "reply worker stopped", {});
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
  }

  async tick(): Promise<{ claimed: number; analyzed: number; errors: number } | null> {
    if (this.running) return null; // never overlap ticks
    this.running = true;
    this.lastTickAt = new Date().toISOString();
    const summary = { claimed: 0, analyzed: 0, errors: 0 };
    try {
      // Ingest first: without this the worker would only ever drain replies
      // ingested by a manual poll or a bulk pump.
      if (this.deps.pollQueues) {
        await this.deps.pollQueues();
      }
      const now = new Date().toISOString();
      const claimLimit = Math.max(1, this.deps.config.REPLY_POLL_BATCH);
      const candidates = this.deps.replies.listClaimable(now, claimLimit);
      summary.claimed = candidates.length;
      for (const row of candidates) {
        const leaseUntil = new Date(Date.now() + this.leaseMs).toISOString();
        // CAS claim: another worker (or a previous life of this one) may have
        // taken it; a lost race just skips this tick.
        if (!this.deps.replies.claimForAnalysis(row.id, leaseUntil)) continue;
        try {
          const ok = await this.deps.processReply(row);
          if (ok) {
            summary.analyzed += 1;
            this.processedTotal += 1;
            this.connected = true;
          } else {
            // Processed but deliberately not analyzable here (e.g. no AI
            // runtime configured): park as retryable so a configured worker
            // picks it up later.
            this.park(row, "OPEN_CODE_UNAVAILABLE", "no AI runtime configured");
            summary.errors += 1;
            this.failureTotal += 1;
          }
        } catch (err) {
          const klass = classifyReplyError(err);
          this.park(row, klass, err instanceof Error ? err.message : String(err));
          summary.errors += 1;
          this.failureTotal += 1;
        }
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.connected = false;
      log("warn", "reply worker tick failed", { error: this.lastError });
    } finally {
      this.running = false;
    }
    return summary;
  }

  // Transient classes retry with bounded attempts (attempts live on the
  // response draft for drafting failures; here the lease expiry plus
  // RETRYABLE state bound re-analysis). Terminal classes never retry.
  private park(row: InboundReplyRow, klass: ReplyErrorClass, message: string): void {
    this.connected =
      klass !== "OPEN_CODE_UNAVAILABLE" &&
      klass !== "WARM_BLY_UNAVAILABLE" &&
      klass !== "SYNC_TIMEOUT";
    if (klass === "AMBIGUOUS_REPLY" || klass === "UNMATCHED_REPLY") {
      const state = klass === "AMBIGUOUS_REPLY" ? REPLY_PROCESS_STATE.AMBIGUOUS : REPLY_PROCESS_STATE.UNMATCHED;
      this.deps.replies.setProcessState(row.id, state, `${klass}: ${message}`);
      this.deps.events.append({ kind: "reply.process_ambiguous", campaignRunId: row.queue_id, leadId: row.lead_id, message: message.slice(0, 160) });
      return;
    }
    if (!TRANSIENT_CLASSES.has(klass)) {
      this.deps.replies.markAnalysisFailed(row.id, "FAILED", `${klass}: ${message}`);
      this.deps.events.append({ kind: "reply.process_failed", campaignRunId: row.queue_id, leadId: row.lead_id, message: message.slice(0, 160) });
      return;
    }
    this.deps.replies.markAnalysisFailed(row.id, "RETRYABLE", `${klass}: ${message}`);
    this.deps.events.append({ kind: "reply.process_retryable", campaignRunId: row.queue_id, leadId: row.lead_id, message: message.slice(0, 160) });
  }

  status(): ReplyWorkerStatus {
    const queueIds = this.deps.queueIdsWithSent();
    let claimable = 0;
    let analyzing = 0;
    let failed = 0;
    let ambiguous = 0;
    for (const queueId of queueIds) {
      const counts = this.deps.replies.countsByProcessState(queueId);
      claimable += (counts[REPLY_PROCESS_STATE.RECEIVED] ?? 0) + (counts[REPLY_PROCESS_STATE.MATCHED] ?? 0) + (counts[REPLY_PROCESS_STATE.RETRYABLE] ?? 0);
      analyzing += counts[REPLY_PROCESS_STATE.ANALYZING] ?? 0;
      failed += counts[REPLY_PROCESS_STATE.FAILED] ?? 0;
      ambiguous += counts[REPLY_PROCESS_STATE.AMBIGUOUS] ?? 0;
    }
    let awaitingApproval = 0;
    for (const queueId of queueIds) {
      const counts = this.deps.responses.countsByStatus(queueId);
      awaitingApproval += counts["NEEDS_REVIEW"] ?? 0;
    }
    return {
      enabled: this.deps.config.REPLY_WORKER_ENABLED,
      state: this.stopped ? "STOPPED" : this.lastError ? "ERROR" : "RUNNING",
      connected: this.connected,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      claimable,
      analyzing,
      awaitingApproval,
      failed,
      ambiguous,
      processedTotal: this.processedTotal,
      failureTotal: this.failureTotal,
    };
  }
}

// Convenience factory for the ids the status endpoint aggregates over.
export function queueIdsWithSentInitials(db: BridgeDb): string[] {
  return (db.prepare("SELECT DISTINCT queue_id AS id FROM send_items WHERE kind = 'initial' AND status = 'SENT'").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

export function newReplyId(): string {
  return randomUUID();
}
