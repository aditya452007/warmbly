import type { BridgeDb } from "../db.js";

export const REPLY_INTENT = {
  POSITIVE: "positive",
  NEGATIVE: "negative",
  NEUTRAL: "neutral",
  UNSUBSCRIBE: "unsubscribe",
  AUTOMATED: "automated",
} as const;

// Bridge-owned AI processing states for an inbound reply. Warmbly owns
// mailbox/message state (read/unread, folders); these track only what the
// bridge's AI pipeline has done. AWAITING_APPROVAL lives on the response
// draft, not here: a reply's terminal AI state is ANALYZED (drafted or
// deliberately not drafted) or FAILED/AMBIGUOUS (human decision needed).
export const REPLY_PROCESS_STATE = {
  RECEIVED: "RECEIVED",
  MATCHED: "MATCHED",
  ANALYZING: "ANALYZING",
  ANALYZED: "ANALYZED",
  RETRYABLE: "RETRYABLE",
  FAILED: "FAILED",
  AMBIGUOUS: "AMBIGUOUS",
  UNMATCHED: "UNMATCHED",
} as const;

export type ReplyProcessState = (typeof REPLY_PROCESS_STATE)[keyof typeof REPLY_PROCESS_STATE];

// Production rows are ingested from Warmbly's unibox. 'test' rows exist only
// inside deterministic tests; production scheduling never claims them.
export const REPLY_SOURCE = {
  WARMBLY: "warmbly",
  TEST: "test",
} as const;

export const RESPONSE_STATUS = {
  NEEDS_REVIEW: "NEEDS_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  GENERATION_RETRYABLE: "GENERATION_RETRYABLE",
  GENERATION_FAILED: "GENERATION_FAILED",
  SENT: "SENT",
  BLOCKED: "BLOCKED",
} as const;

interface AnyStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function utcNow(): string {
  return new Date().toISOString();
}

export interface InboundReplyRow {
  id: string;
  queue_id: string;
  lead_id: string;
  warmbly_id: string;
  rfc_message_id: string | null;
  thread_id: string | null;
  from_email: string;
  subject: string;
  body_text: string;
  received_at: string | null;
  process_state: string;
  source: string;
  error_message: string | null;
  lease_until: string | null;
  analysis_intent: string | null;
  analysis_confidence: number | null;
  analysis_summary: string | null;
  analysis_action: string | null;
  requires_response: number | null;
  analyzed_at: string | null;
  created_at: string;
}

export class InboundReplies {
  constructor(private db: BridgeDb) {}

  // Dedupe key is (queue, warmbly message id): a re-poll that re-sees the
  // same message reports duplicate instead of forking analysis + drafts.
  insert(args: {
    id: string;
    queueId: string;
    leadId: string;
    warmblyId: string;
    rfcMessageId?: string | null;
    threadId?: string | null;
    fromEmail: string;
    subject: string;
    bodyText: string;
    receivedAt?: string | null;
    source?: string;
  }): { duplicate: boolean; id: string } {
    try {
      (this.db.prepare(
        `INSERT INTO inbound_replies
          (id, queue_id, lead_id, warmbly_id, rfc_message_id, thread_id,
           from_email, subject, body_text, received_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ) as unknown as AnyStatement).run(
        args.id,
        args.queueId,
        args.leadId,
        args.warmblyId,
        args.rfcMessageId ?? null,
        args.threadId ?? null,
        args.fromEmail,
        args.subject,
        args.bodyText,
        args.receivedAt ?? null,
        args.source ?? REPLY_SOURCE.WARMBLY,
      );
      return { duplicate: false, id: args.id };
    } catch (err) {
      if ((err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = (this.db.prepare(
          "SELECT * FROM inbound_replies WHERE queue_id = ? AND warmbly_id = ?",
        ) as unknown as AnyStatement).get(args.queueId, args.warmblyId) as InboundReplyRow;
        return { duplicate: true, id: existing.id };
      }
      throw err;
    }
  }

  get(id: string): InboundReplyRow | undefined {
    return (this.db.prepare("SELECT * FROM inbound_replies WHERE id = ?") as unknown as AnyStatement).get(id) as InboundReplyRow | undefined;
  }

  listByQueue(queueId: string, limit: number, offset: number): InboundReplyRow[] {
    return (this.db.prepare(
      "SELECT * FROM inbound_replies WHERE queue_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
    ) as unknown as AnyStatement).all(queueId, limit, offset) as InboundReplyRow[];
  }

  listByLead(queueId: string, leadId: string): InboundReplyRow[] {
    return (this.db.prepare(
      "SELECT * FROM inbound_replies WHERE queue_id = ? AND lead_id = ? ORDER BY received_at ASC NULLS LAST, created_at ASC",
    ) as unknown as AnyStatement).all(queueId, leadId) as InboundReplyRow[];
  }

  // A newer inbound message than the one being answered blocks the response:
  // the operator must see the latest mail before anything goes out.
  hasNewer(queueId: string, leadId: string, receivedAt: string | null, excludeId: string): boolean {
    if (!receivedAt) return false;
    const row = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM inbound_replies
       WHERE queue_id = ? AND lead_id = ? AND id != ?
         AND ((received_at IS NOT NULL AND received_at > ?) OR (received_at IS NULL AND created_at > ?))`,
    ) as unknown as AnyStatement).get(queueId, leadId, excludeId, receivedAt, receivedAt) as { n: number };
    return row.n > 0;
  }

  storeAnalysis(id: string, analysis: { intent: string; confidence: number; summary: string; action: string; requiresResponse: boolean }): void {
    (this.db.prepare(
      "UPDATE inbound_replies SET analysis_intent = ?, analysis_confidence = ?, analysis_summary = ?, analysis_action = ?, requires_response = ?, analyzed_at = ?, process_state = ?, lease_until = NULL, error_message = NULL WHERE id = ?",
    ) as unknown as AnyStatement).run(analysis.intent, analysis.confidence, analysis.summary, analysis.action, analysis.requiresResponse ? 1 : 0, utcNow(), REPLY_PROCESS_STATE.ANALYZED, id);
  }

  // Lease semantics: state transitions are CAS-style so a crashed worker's
  // stale claim cannot overwrite a fresh one. claimForAnalysis flips
  // RECEIVED/MATCHED/RETRYABLE (or an expired-lease ANALYZING left by a dead
  // worker) -> ANALYZING only when no other worker holds an unexpired lease;
  // markAnalysisFailed/Retryable release it.
  claimForAnalysis(id: string, leaseUntil: string): boolean {
    const info = (this.db.prepare(
      `UPDATE inbound_replies SET process_state = ?, lease_until = ?, error_message = NULL
       WHERE id = ? AND analyzed_at IS NULL
         AND process_state IN (?, ?, ?)
         AND (lease_until IS NULL OR lease_until <= ?)`,
    ) as unknown as AnyStatement).run(
      REPLY_PROCESS_STATE.ANALYZING,
      leaseUntil,
      id,
      REPLY_PROCESS_STATE.RECEIVED,
      REPLY_PROCESS_STATE.MATCHED,
      REPLY_PROCESS_STATE.RETRYABLE,
      utcNow(),
    );
    if (Number(info.changes) > 0) return true;
    // Second chance: an ANALYZING row whose lease expired is the signature
    // of a crashed worker; it is safe to re-claim (dedupe keys hold).
    const reclaim = (this.db.prepare(
      `UPDATE inbound_replies SET process_state = ?, lease_until = ?, error_message = NULL
       WHERE id = ? AND analyzed_at IS NULL
         AND process_state = ?
         AND lease_until IS NOT NULL AND lease_until <= ?`,
    ) as unknown as AnyStatement).run(
      REPLY_PROCESS_STATE.ANALYZING,
      leaseUntil,
      id,
      REPLY_PROCESS_STATE.ANALYZING,
      utcNow(),
    );
    return Number(reclaim.changes) > 0;
  }

  // Rows claimable by the inbox worker: fresh work plus rows whose previous
  // analyst died (ANALYZING with an expired lease). Production scheduling
  // claims only warmbly-sourced rows; 'test' rows are analyzed only when a
  // test drives the pipeline explicitly (analyzeReply is called directly).
  listClaimable(now: string, limit: number): InboundReplyRow[] {
    return (this.db.prepare(
      `SELECT * FROM inbound_replies
       WHERE analyzed_at IS NULL AND source = ?
         AND process_state IN (?, ?, ?, ?)
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    ) as unknown as AnyStatement).all(
      REPLY_SOURCE.WARMBLY,
      REPLY_PROCESS_STATE.RECEIVED,
      REPLY_PROCESS_STATE.MATCHED,
      REPLY_PROCESS_STATE.RETRYABLE,
      REPLY_PROCESS_STATE.ANALYZING,
      now,
      limit,
    ) as InboundReplyRow[];
  }

  setProcessState(id: string, state: string, error?: string): void {
    (this.db.prepare(
      "UPDATE inbound_replies SET process_state = ?, error_message = COALESCE(?, error_message), lease_until = NULL WHERE id = ?",
    ) as unknown as AnyStatement).run(state, error ?? null, id);
  }

  markAnalysisFailed(id: string, state: "RETRYABLE" | "FAILED", error: string): void {
    (this.db.prepare(
      "UPDATE inbound_replies SET process_state = ?, error_message = ?, lease_until = NULL WHERE id = ?",
    ) as unknown as AnyStatement).run(state, error.slice(0, 500), id);
  }

  countsByProcessState(queueId: string): Record<string, number> {
    const rows = (this.db.prepare(
      "SELECT process_state, COUNT(*) AS n FROM inbound_replies WHERE queue_id = ? GROUP BY process_state",
    ) as unknown as AnyStatement).all(queueId) as Array<{ process_state: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.process_state] = row.n;
    return out;
  }

  countAnalyzed(queueId: string): number {
    const row = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM inbound_replies WHERE queue_id = ? AND analyzed_at IS NOT NULL",
    ) as unknown as AnyStatement).get(queueId) as { n: number };
    return row.n;
  }
}

export interface ResponseDraftRow {
  id: string;
  queue_id: string;
  lead_id: string;
  reply_id: string;
  subject: string;
  body: string;
  status: string;
  version: number;
  attempts: number;
  in_reply_to: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class ResponseDrafts {
  constructor(private db: BridgeDb) {}

  get(id: string): ResponseDraftRow | undefined {
    return (this.db.prepare("SELECT * FROM response_drafts WHERE id = ?") as unknown as AnyStatement).get(id) as ResponseDraftRow | undefined;
  }

  getByReply(replyId: string): ResponseDraftRow | undefined {
    return (this.db.prepare("SELECT * FROM response_drafts WHERE reply_id = ?") as unknown as AnyStatement).get(replyId) as ResponseDraftRow | undefined;
  }

  listByQueue(queueId: string, limit: number, offset: number): ResponseDraftRow[] {
    return (this.db.prepare(
      "SELECT * FROM response_drafts WHERE queue_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
    ) as unknown as AnyStatement).all(queueId, limit, offset) as ResponseDraftRow[];
  }

  countsByStatus(queueId: string): Record<string, number> {
    const rows = (this.db.prepare(
      "SELECT status, COUNT(*) AS n FROM response_drafts WHERE queue_id = ? GROUP BY status",
    ) as unknown as AnyStatement).all(queueId) as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  create(args: { id: string; queueId: string; leadId: string; replyId: string; subject: string; body: string; status: string; inReplyTo?: string | null }): void {
    (this.db.prepare(
      `INSERT INTO response_drafts
        (id, queue_id, lead_id, reply_id, subject, body, status, in_reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ) as unknown as AnyStatement).run(
      args.id, args.queueId, args.leadId, args.replyId, args.subject, args.body, args.status, args.inReplyTo ?? null,
    );
  }

  setStatus(id: string, status: string, error?: string): void {
    (this.db.prepare(
      "UPDATE response_drafts SET status = ?, error_message = COALESCE(?, error_message), updated_at = ? WHERE id = ?",
    ) as unknown as AnyStatement).run(status, error ?? null, utcNow(), id);
  }

  markGenerationRetryable(id: string, error: string): void {
    (this.db.prepare(
      "UPDATE response_drafts SET status = 'GENERATION_RETRYABLE', attempts = attempts + 1, error_message = ?, updated_at = ? WHERE id = ?",
    ) as unknown as AnyStatement).run(error.slice(0, 500), utcNow(), id);
  }

  markSent(id: string, providerMessageId: string): void {
    const now = utcNow();
    (this.db.prepare(
      "UPDATE response_drafts SET status = 'SENT', provider_message_id = COALESCE(provider_message_id, ?), error_message = NULL, updated_at = ? WHERE id = ?",
    ) as unknown as AnyStatement).run(providerMessageId || null, now, id);
  }
}

export class ReplyPolls {
  constructor(private db: BridgeDb) {}

  get(queueId: string, address: string): { last_seen: string | null; last_status: string } | undefined {
    return (this.db.prepare(
      "SELECT last_seen, last_status FROM reply_polls WHERE queue_id = ? AND address = ?",
    ) as unknown as AnyStatement).get(queueId, address) as { last_seen: string | null; last_status: string } | undefined;
  }

  // Cursor advances only on a successful poll of that address: a failed poll
  // keeps the old window so nothing is skipped.
  record(queueId: string, address: string, lastSeen: string | null, status: string): void {
    (this.db.prepare(
      `INSERT INTO reply_polls (queue_id, address, last_seen, last_status, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(queue_id, address) DO UPDATE SET
         last_seen = excluded.last_seen, last_status = excluded.last_status, updated_at = excluded.updated_at`,
    ) as unknown as AnyStatement).run(queueId, address, lastSeen, status, utcNow());
  }
}
