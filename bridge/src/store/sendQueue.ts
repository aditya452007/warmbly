import type { BridgeDb } from "../db.js";

// Phase 8 bulk-send vocabularies. Plain strings like the rest of the store.
export const QUEUE_STATUS = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
} as const;

export const ITEM_STATUS = {
  QUEUED: "QUEUED",
  SENDING: "SENDING",
  SENT: "SENT",
  RETRYABLE: "RETRYABLE",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
} as const;

export const FOLLOWUP_STATUS = {
  NEEDS_REVIEW: "NEEDS_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  GENERATION_RETRYABLE: "GENERATION_RETRYABLE",
  GENERATION_FAILED: "GENERATION_FAILED",
  SENT: "SENT",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
} as const;

interface AnyStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function utcNow(): string {
  return new Date().toISOString();
}

export interface SendQueueRow {
  id: string;
  run_id: string;
  status: string;
  daily_limit: number;
  timezone: string;
  concurrency: number;
  consent_attested: number;
  followup_enabled: number;
  followup_days: string;
  followup_require_approval: number;
  max_live_sends: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSendQueue {
  id: string;
  runId: string;
  dailyLimit: number;
  timezone: string;
  concurrency: number;
  followupEnabled: boolean;
  followupDays: number[];
  followupRequireApproval: boolean;
  maxLiveSends: number;
}

export class SendQueues {
  constructor(private db: BridgeDb) {}

  create(q: CreateSendQueue): SendQueueRow {
    (this.db.prepare(
      `INSERT INTO send_queues
        (id, run_id, status, daily_limit, timezone, concurrency, followup_enabled,
         followup_days, followup_require_approval, max_live_sends)
       VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
    ) as unknown as AnyStatement).run(
      q.id,
      q.runId,
      q.dailyLimit,
      q.timezone,
      q.concurrency,
      q.followupEnabled ? 1 : 0,
      JSON.stringify(q.followupDays),
      q.followupRequireApproval ? 1 : 0,
      q.maxLiveSends,
    );
    return this.get(q.id) as SendQueueRow;
  }

  get(id: string): SendQueueRow | undefined {
    return (this.db.prepare("SELECT * FROM send_queues WHERE id = ?") as unknown as AnyStatement).get(
      id,
    ) as SendQueueRow | undefined;
  }

  getByRun(runId: string): SendQueueRow | undefined {
    return (this.db.prepare("SELECT * FROM send_queues WHERE run_id = ?") as unknown as AnyStatement).get(
      runId,
    ) as SendQueueRow | undefined;
  }

  setStatus(id: string, status: string): void {
    (this.db.prepare("UPDATE send_queues SET status = ?, updated_at = ? WHERE id = ?") as unknown as AnyStatement).run(
      status,
      utcNow(),
      id,
    );
  }

  attestConsent(id: string): void {
    (this.db.prepare("UPDATE send_queues SET consent_attested = 1, updated_at = ? WHERE id = ?") as unknown as AnyStatement).run(
      utcNow(),
      id,
    );
  }

  setMaxLiveSends(id: string, maxLiveSends: number): void {
    (this.db.prepare("UPDATE send_queues SET max_live_sends = ?, updated_at = ? WHERE id = ?") as unknown as AnyStatement).run(
      maxLiveSends,
      utcNow(),
      id,
    );
  }

  // ACTIVE queues with unfinished items after a crash. DRAFT never auto-runs;
  // PAUSED/CANCELLED/COMPLETED stay exactly as the operator left them.
  listActive(): SendQueueRow[] {
    return (this.db.prepare("SELECT * FROM send_queues WHERE status = 'ACTIVE' ORDER BY created_at ASC") as unknown as AnyStatement).all() as SendQueueRow[];
  }
}

export interface SendItemRow {
  id: string;
  queue_id: string;
  draft_id: string;
  draft_version: number;
  kind: string;
  seq: number;
  followup_id: string | null;
  recipient: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  scheduled_for: string | null;
  idempotency_key: string;
  provider: string;
  provider_message_id: string | null;
  in_reply_to: string | null;
  consent_source: string | null;
  error_code: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSendItem {
  id: string;
  queueId: string;
  draftId: string;
  draftVersion: number;
  kind: string;
  seq: number;
  followupId?: string | null;
  recipient: string;
  idempotencyKey: string;
  provider: string;
  scheduledFor?: string | null;
}

export class SendItems {
  constructor(private db: BridgeDb) {}

  // Idempotent enqueue: the UNIQUE(queue,draft,version,kind,seq) guard makes a
  // repeated enqueue a no-op report instead of a duplicate row.
  enqueue(item: CreateSendItem): { duplicate: boolean; id: string } {
    try {
      (this.db.prepare(
        `INSERT INTO send_items
          (id, queue_id, draft_id, draft_version, kind, seq, followup_id,
           recipient, status, idempotency_key, provider, scheduled_for)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
      ) as unknown as AnyStatement).run(
        item.id,
        item.queueId,
        item.draftId,
        item.draftVersion,
        item.kind,
        item.seq,
        item.followupId ?? null,
        item.recipient,
        item.idempotencyKey,
        item.provider,
        item.scheduledFor ?? null,
      );
      return { duplicate: false, id: item.id };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = (this.db.prepare(
          "SELECT * FROM send_items WHERE queue_id = ? AND draft_id = ? AND draft_version = ? AND kind = ? AND seq = ?",
        ) as unknown as AnyStatement).get(item.queueId, item.draftId, item.draftVersion, item.kind, item.seq) as SendItemRow;
        return { duplicate: true, id: existing.id };
      }
      throw err;
    }
  }

  get(id: string): SendItemRow | undefined {
    return (this.db.prepare("SELECT * FROM send_items WHERE id = ?") as unknown as AnyStatement).get(id) as SendItemRow | undefined;
  }

  getByIdempotencyKey(key: string): SendItemRow | undefined {
    return (this.db.prepare("SELECT * FROM send_items WHERE idempotency_key = ?") as unknown as AnyStatement).get(key) as SendItemRow | undefined;
  }

  // Atomic claim: only a QUEUED (or due RETRYABLE) row flips to SENDING.
  // Two pump workers can never own the same item.
  claimDue(queueId: string, nowIso: string, limit: number): SendItemRow[] {
    const claim = this.db.transaction((now: string, n: number): SendItemRow[] => {
      const rows = (this.db.prepare(
        `SELECT * FROM send_items
         WHERE queue_id = ?
           AND ((status = 'QUEUED' AND (scheduled_for IS NULL OR scheduled_for <= ?))
             OR (status = 'RETRYABLE' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?))
         ORDER BY scheduled_for ASC NULLS FIRST, created_at ASC, id ASC
         LIMIT ?`,
      ) as unknown as AnyStatement).all(queueId, now, now, n) as SendItemRow[];
      for (const row of rows) {
        (this.db.prepare(
          "UPDATE send_items SET status = 'SENDING', updated_at = ? WHERE id = ? AND status = ?",
        ) as unknown as AnyStatement).run(utcNow(), row.id, row.status);
      }
      return rows;
    });
    return claim(nowIso, limit);
  }

  setSending(id: string): void {
    (this.db.prepare("UPDATE send_items SET status = 'SENDING', updated_at = ? WHERE id = ?") as unknown as AnyStatement).run(utcNow(), id);
  }

  markSent(id: string, providerMessageId: string): void {
    const now = utcNow();
    (this.db.prepare(
      `UPDATE send_items SET status = 'SENT', provider_message_id = COALESCE(provider_message_id, ?),
       sent_at = COALESCE(sent_at, ?), error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
    ) as unknown as AnyStatement).run(providerMessageId || null, now, now, id);
  }

  markRetryable(id: string, code: string, message: string, nextAttemptAt: string): void {
    (this.db.prepare(
      `UPDATE send_items SET status = 'RETRYABLE', attempts = attempts + 1,
       error_code = ?, error_message = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ) as unknown as AnyStatement).run(code, message.slice(0, 500), nextAttemptAt, utcNow(), id);
  }

  // Terminal refusal: BLOCKED never retries, FAILED exhausted retries.
  markTerminal(id: string, status: "BLOCKED" | "FAILED", code: string, message: string): void {
    (this.db.prepare(
      `UPDATE send_items SET status = ?, attempts = attempts + 1,
       error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
    ) as unknown as AnyStatement).run(status, code, message.slice(0, 500), utcNow(), id);
  }

  setConsentSource(id: string, source: string): void {
    (this.db.prepare("UPDATE send_items SET consent_source = ?, updated_at = ? WHERE id = ?") as unknown as AnyStatement).run(source, utcNow(), id);
  }

  // Crash recovery: items stuck SENDING never stay there. They return as
  // RETRYABLE with the ambiguous flag in the error, so the pump retries with
  // the same idempotency key and an audit trail instead of parking forever.
  resetStuckSending(queueId: string, nextAttemptAt: string): number {
    const info = (this.db.prepare(
      `UPDATE send_items SET status = 'RETRYABLE', attempts = attempts + 1,
       error_code = 'TIMEOUT', error_message = 'ambiguous: bridge stopped mid-send; retrying with the same idempotency key',
       next_attempt_at = ?, updated_at = ? WHERE queue_id = ? AND status = 'SENDING'`,
    ) as unknown as AnyStatement).run(nextAttemptAt, utcNow(), queueId);
    return Number(info.changes);
  }

  countsByStatus(queueId: string): Record<string, number> {
    const rows = (this.db.prepare(
      "SELECT status, COUNT(*) AS n FROM send_items WHERE queue_id = ? GROUP BY status",
    ) as unknown as AnyStatement).all(queueId) as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  countSent(queueId: string): number {
    const row = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM send_items WHERE queue_id = ? AND status = 'SENT'",
    ) as unknown as AnyStatement).get(queueId) as { n: number };
    return row.n;
  }

  // Follow-up chain state for one lead: sent initials + sent/blocked seqs.
  listByDraft(queueId: string, draftId: string): SendItemRow[] {
    return (this.db.prepare(
      "SELECT * FROM send_items WHERE queue_id = ? AND draft_id = ? ORDER BY seq ASC",
    ) as unknown as AnyStatement).all(queueId, draftId) as SendItemRow[];
  }

  list(queueId: string, limit: number, offset: number): SendItemRow[] {
    return (this.db.prepare(
      "SELECT * FROM send_items WHERE queue_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
    ) as unknown as AnyStatement).all(queueId, limit, offset) as SendItemRow[];
  }

  hasUnfinished(queueId: string): boolean {
    const row = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM send_items WHERE queue_id = ? AND status IN ('QUEUED','SENDING','RETRYABLE')",
    ) as unknown as AnyStatement).get(queueId) as { n: number };
    return row.n > 0;
  }
}

export interface FollowupRow {
  id: string;
  queue_id: string;
  lead_id: string;
  parent_draft_id: string;
  seq: number;
  subject: string;
  body: string;
  rendered_html: string | null;
  status: string;
  version: number;
  attempts: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class FollowupDrafts {
  constructor(private db: BridgeDb) {}

  get(id: string): FollowupRow | undefined {
    return (this.db.prepare("SELECT * FROM followup_drafts WHERE id = ?") as unknown as AnyStatement).get(id) as FollowupRow | undefined;
  }

  getByLeadSeq(queueId: string, leadId: string, seq: number): FollowupRow | undefined {
    return (this.db.prepare(
      "SELECT * FROM followup_drafts WHERE queue_id = ? AND lead_id = ? AND seq = ?",
    ) as unknown as AnyStatement).get(queueId, leadId, seq) as FollowupRow | undefined;
  }

  listByQueue(queueId: string, limit: number, offset: number): FollowupRow[] {
    return (this.db.prepare(
      "SELECT * FROM followup_drafts WHERE queue_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
    ) as unknown as AnyStatement).all(queueId, limit, offset) as FollowupRow[];
  }

  countsByStatus(queueId: string): Record<string, number> {
    const rows = (this.db.prepare(
      "SELECT status, COUNT(*) AS n FROM followup_drafts WHERE queue_id = ? GROUP BY status",
    ) as unknown as AnyStatement).all(queueId) as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  create(args: { id: string; queueId: string; leadId: string; parentDraftId: string; seq: number; subject: string; body: string; renderedHtml: string | null; status: string }): void {
    (this.db.prepare(
      `INSERT INTO followup_drafts
        (id, queue_id, lead_id, parent_draft_id, seq, subject, body, rendered_html, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ) as unknown as AnyStatement).run(
      args.id, args.queueId, args.leadId, args.parentDraftId, args.seq,
      args.subject, args.body, args.renderedHtml, args.status,
    );
  }

  setStatus(id: string, status: string, error?: string): void {
    (this.db.prepare(
      "UPDATE followup_drafts SET status = ?, error_message = COALESCE(?, error_message), updated_at = ? WHERE id = ?",
    ) as unknown as AnyStatement).run(status, error ?? null, utcNow(), id);
  }

  markGenerationRetryable(id: string, error: string): void {
    (this.db.prepare(
      "UPDATE followup_drafts SET status = 'GENERATION_RETRYABLE', attempts = attempts + 1, error_message = ?, updated_at = ? WHERE id = ?",
    ) as unknown as AnyStatement).run(error.slice(0, 500), utcNow(), id);
  }

  // A retried generation replaces the failed text and resets the row to the
  // queue's approval policy. Version bumps so a review UI can tell.
  storeGenerated(id: string, subject: string, body: string, status: string): void {
    (this.db.prepare(
      "UPDATE followup_drafts SET subject = ?, body = ?, status = ?, version = version + 1, error_message = NULL, updated_at = ? WHERE id = ?",
    ) as unknown as AnyStatement).run(subject, body, status, utcNow(), id);
  }
}

export class DayCounters {
  constructor(private db: BridgeDb) {}

  get(queueId: string, day: string): number {
    const row = (this.db.prepare(
      "SELECT count FROM send_day_counters WHERE queue_id = ? AND day = ?",
    ) as unknown as AnyStatement).get(queueId, day) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}

export class ContactSignals {
  constructor(private db: BridgeDb) {}

  record(queueId: string, id: string, email: string, kind: string, leadId?: string | null): void {
    (this.db.prepare(
      "INSERT INTO contact_signals (id, queue_id, lead_id, email, kind) VALUES (?, ?, ?, ?, ?)",
    ) as unknown as AnyStatement).run(id, queueId, leadId ?? null, email.trim().toLowerCase(), kind);
  }

  has(queueId: string, email: string, kind: string): boolean {
    const row = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM contact_signals WHERE queue_id = ? AND email = ? AND kind = ?",
    ) as unknown as AnyStatement).get(queueId, email.trim().toLowerCase(), kind) as { n: number };
    return row.n > 0;
  }
}
