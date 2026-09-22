import type { BridgeDb } from "../db.js";

// Status vocabularies. Statuses are plain strings matching the schema
// defaults; use these constants instead of string literals.
export const CAMPAIGN_STATUS = {
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS];

export const AGENT_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

export const JOB_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  RETRYABLE: "RETRYABLE",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const LEAD_STATUS = {
  DISCOVERED: "DISCOVERED",
  RESEARCHED: "RESEARCHED",
  DRAFTED: "DRAFTED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
} as const;
export type LeadStatus = (typeof LEAD_STATUS)[keyof typeof LEAD_STATUS];

export const LEAD_SYNC_STATUS = {
  PENDING: "pending",
  SYNCED: "synced",
  FAILED: "failed",
} as const;
export type LeadSyncStatus = (typeof LEAD_SYNC_STATUS)[keyof typeof LEAD_SYNC_STATUS];

export const DRAFT_STATUS = {
  DRAFT: "DRAFT",
  APPROVED: "APPROVED",
  SENT: "SENT",
} as const;
export type DraftStatus = (typeof DRAFT_STATUS)[keyof typeof DRAFT_STATUS];

// better-sqlite3 statement with untyped bind params. Rows come back unknown
// and are cast at the repository boundary; avoids pinning the generic
// BindParameters tuple that prepare() carries.
interface AnyStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

type Prepared = AnyStatement;

function utcNow(): string {
  return new Date().toISOString();
}

function asJson(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isIdentityConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof message === "string" &&
    message.includes("campaign_run_id")
  );
}

export interface CampaignRunRow {
  id: string;
  warmbly_campaign_id: string;
  business_type: string;
  location: string;
  custom_instructions: string;
  offer_url_1: string | null;
  offer_url_2: string | null;
  offer_url_3: string | null;
  parallel_agents: number;
  target_leads: number;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCampaignRun {
  id: string;
  warmblyCampaignId: string;
  businessType: string;
  location: string;
  customInstructions: string;
  offerUrls: string[];
  parallelAgents: number;
  targetLeads: number;
}

export class CampaignRuns {
  private insertStmt: Prepared;
  private getStmt: Prepared;
  private setStatusStmt: Prepared;
  private touchStmt: Prepared;

  constructor(private db: BridgeDb) {
    this.insertStmt = this.db.prepare(
      `INSERT INTO campaign_runs
        (id, warmbly_campaign_id, business_type, location, custom_instructions,
         offer_url_1, offer_url_2, offer_url_3, parallel_agents, target_leads, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = this.db.prepare("SELECT * FROM campaign_runs WHERE id = ?");
    this.setStatusStmt = this.db.prepare(
      `UPDATE campaign_runs
       SET status = ?, error_message = COALESCE(?, error_message), updated_at = ?
       WHERE id = ?`,
    );
    this.touchStmt = this.db.prepare("UPDATE campaign_runs SET updated_at = ? WHERE id = ?");
  }

  create(run: CreateCampaignRun): CampaignRunRow {
    const [url1, url2, url3] = run.offerUrls;
    this.insertStmt.run(
      run.id,
      run.warmblyCampaignId,
      run.businessType,
      run.location,
      run.customInstructions,
      url1 ?? null,
      url2 ?? null,
      url3 ?? null,
      run.parallelAgents,
      run.targetLeads,
      CAMPAIGN_STATUS.CREATED,
    );
    return this.get(run.id) as CampaignRunRow;
  }

  get(id: string): CampaignRunRow | undefined {
    return this.getStmt.get(id) as CampaignRunRow | undefined;
  }

  // Runs that may hold unfinished work after a crash: anything not in a
  // terminal, paused, or cancelled state.
  listResumable(): CampaignRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM campaign_runs WHERE status IN ('CREATED','DISCOVERING','RESEARCHING','PERSONALIZING','WAITING_FOR_AI') ORDER BY created_at ASC`,
      )
      .all() as CampaignRunRow[];
  }

  // Omitting errorMessage leaves the previous message untouched.
  setStatus(id: string, status: string, errorMessage?: string): void {
    this.setStatusStmt.run(status, errorMessage ?? null, utcNow(), id);
  }

  touch(id: string): void {
    this.touchStmt.run(utcNow(), id);
  }
}

export interface AgentRunRow {
  id: string;
  campaign_run_id: string;
  agent_number: number;
  session_id: string | null;
  lane: string;
  status: string;
  current_task: string | null;
  leads_found: number;
  duplicates: number;
  errors: number;
  started_at: string | null;
  finished_at: string | null;
  last_heartbeat: string | null;
  error_message: string | null;
}

export interface CreateAgentRun {
  id: string;
  campaignRunId: string;
  agentNumber: number;
  sessionId?: string | null;
  lane: string;
}

export class AgentRuns {
  private insertStmt: Prepared;
  private heartbeatStmt: Prepared;
  private sessionStmt: Prepared;
  private taskStmt: Prepared;
  private finishStmt: Prepared;
  private addLeadsStmt: Prepared;
  private addDuplicatesStmt: Prepared;
  private addErrorsStmt: Prepared;
  private listByRunStmt: Prepared;
  private staleStmt: Prepared;

  constructor(private db: BridgeDb) {
    this.insertStmt = this.db.prepare(
      `INSERT INTO agent_runs (id, campaign_run_id, agent_number, session_id, lane, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.heartbeatStmt = this.db.prepare(
      `UPDATE agent_runs
       SET status = CASE WHEN status = 'QUEUED' THEN 'RUNNING' ELSE status END,
           started_at = COALESCE(started_at, ?),
           last_heartbeat = ?
       WHERE id = ?`,
    );
    this.finishStmt = this.db.prepare(
      `UPDATE agent_runs
       SET status = ?, finished_at = ?, error_message = COALESCE(?, error_message)
       WHERE id = ?`,
    );
    this.addLeadsStmt = this.db.prepare("UPDATE agent_runs SET leads_found = leads_found + ? WHERE id = ?");
    this.addDuplicatesStmt = this.db.prepare("UPDATE agent_runs SET duplicates = duplicates + ? WHERE id = ?");
    this.addErrorsStmt = this.db.prepare("UPDATE agent_runs SET errors = errors + ? WHERE id = ?");
    this.listByRunStmt = this.db.prepare(
      "SELECT * FROM agent_runs WHERE campaign_run_id = ? ORDER BY agent_number ASC",
    );
    this.staleStmt = this.db.prepare(
      `SELECT * FROM agent_runs
       WHERE status = 'RUNNING' AND (last_heartbeat IS NULL OR last_heartbeat < ?)
       ORDER BY last_heartbeat ASC NULLS FIRST`,
    );
    this.sessionStmt = this.db.prepare("UPDATE agent_runs SET session_id = ? WHERE id = ?");
    this.taskStmt = this.db.prepare("UPDATE agent_runs SET current_task = ? WHERE id = ?");
  }

  create(agent: CreateAgentRun): void {
    this.insertStmt.run(
      agent.id,
      agent.campaignRunId,
      agent.agentNumber,
      agent.sessionId ?? null,
      agent.lane,
      AGENT_STATUS.QUEUED,
    );
  }

  // First heartbeat promotes QUEUED to RUNNING and stamps started_at.
  heartbeat(id: string): void {
    const now = utcNow();
    this.heartbeatStmt.run(now, now, id);
  }

  setSession(id: string, sessionId: string): void {
    this.sessionStmt.run(sessionId, id);
  }

  setTask(id: string, task: string | null): void {
    this.taskStmt.run(task, id);
  }

  finish(id: string, status: string, errorMessage?: string): void {
    this.finishStmt.run(status, utcNow(), errorMessage ?? null, id);
  }

  addLeads(id: string, n: number): void {
    this.addLeadsStmt.run(n, id);
  }

  addDuplicates(id: string, n: number): void {
    this.addDuplicatesStmt.run(n, id);
  }

  addErrors(id: string, n: number): void {
    this.addErrorsStmt.run(n, id);
  }

  listByRun(runId: string): AgentRunRow[] {
    return this.listByRunStmt.all(runId) as AgentRunRow[];
  }

  findStale(nowIso: string, leaseSeconds: number): AgentRunRow[] {
    const cutoff = new Date(Date.parse(nowIso) - leaseSeconds * 1000).toISOString();
    return this.staleStmt.all(cutoff) as AgentRunRow[];
  }
}

export interface DiscoveryJobRow {
  id: string;
  campaign_run_id: string;
  agent_run_id: string | null;
  status: string;
  attempts: number;
  lease_until: string | null;
  payload: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueJob {
  id: string;
  campaignRunId: string;
  agentRunId?: string | null;
  payload: string;
}

export class DiscoveryJobs {
  private insertStmt: Prepared;
  private getStmt: Prepared;
  private staleIdsStmt: Prepared;
  private retryStmt: Prepared;
  private completeStmt: Prepared;
  private failStmt: Prepared;
  private pendingCountStmt: Prepared;

  constructor(private db: BridgeDb) {
    this.insertStmt = this.db.prepare(
      `INSERT INTO discovery_jobs (id, campaign_run_id, agent_run_id, status, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.getStmt = this.db.prepare("SELECT * FROM discovery_jobs WHERE id = ?");
    this.staleIdsStmt = this.db.prepare(
      `SELECT id FROM discovery_jobs
       WHERE status = 'RUNNING' AND lease_until IS NOT NULL AND lease_until < ?`,
    );
    this.retryStmt = this.db.prepare(
      "UPDATE discovery_jobs SET status = ?, updated_at = ? WHERE id = ?",
    );
    this.completeStmt = this.db.prepare(
      "UPDATE discovery_jobs SET status = ?, updated_at = ? WHERE id = ?",
    );
    this.failStmt = this.db.prepare(
      `UPDATE discovery_jobs
       SET status = ?, attempts = attempts + 1, error_message = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.pendingCountStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM discovery_jobs
       WHERE campaign_run_id = ? AND status IN (?, ?)`,
    );
  }

  enqueue(job: EnqueueJob): void {
    this.insertStmt.run(job.id, job.campaignRunId, job.agentRunId ?? null, JOB_STATUS.QUEUED, job.payload);
  }

  // A worker owns the job from here until complete/fail: crash recovery
  // (claimStale) only ever sees leases this method wrote.
  start(id: string, leaseUntil: string): void {
    this.db
      .prepare("UPDATE discovery_jobs SET status = ?, lease_until = ?, updated_at = ? WHERE id = ?")
      .run(JOB_STATUS.RUNNING, leaseUntil, utcNow(), id);
  }

  extendLease(id: string, leaseUntil: string): void {
    this.db
      .prepare("UPDATE discovery_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(leaseUntil, utcNow(), id, JOB_STATUS.RUNNING);
  }

  // Re-queues expired RUNNING leases and returns the jobs as re-queued.
  claimStale(nowIso: string): DiscoveryJobRow[] {
    const claim = this.db.transaction((now: string): DiscoveryJobRow[] => {
      const ids = this.staleIdsStmt.all(now) as Array<{ id: string }>;
      const out: DiscoveryJobRow[] = [];
      for (const row of ids) {
        this.retryStmt.run(JOB_STATUS.RETRYABLE, now, row.id);
        out.push(this.getStmt.get(row.id) as DiscoveryJobRow);
      }
      return out;
    });
    return claim(nowIso);
  }

  complete(id: string): void {
    this.completeStmt.run(JOB_STATUS.COMPLETED, utcNow(), id);
  }

  fail(id: string, error: string, retryable: boolean): void {
    this.failStmt.run(retryable ? JOB_STATUS.RETRYABLE : JOB_STATUS.FAILED, error, utcNow(), id);
  }

  pendingCount(runId: string): number {
    const row = this.pendingCountStmt.get(runId, JOB_STATUS.QUEUED, JOB_STATUS.RETRYABLE) as { n: number };
    return row.n;
  }
}

export interface LeadRow {
  id: string;
  campaign_run_id: string;
  agent_id: string | null;
  identity: string;
  business_name: string;
  website: string | null;
  website_domain: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  source_urls: string;
  confidence: number;
  status: string;
  sync_status: string;
  warmbly_contact_id: string | null;
  sync_attempts: number;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertLead {
  id: string;
  campaignRunId: string;
  agentId?: string | null;
  identity: string;
  businessName: string;
  website?: string | null;
  websiteDomain?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  sourceUrls?: string[] | string;
  confidence?: number;
  status?: string;
}

export class Leads {
  private insertStmt: Prepared;
  private getStmt: Prepared;
  private setStatusStmt: Prepared;
  private setSyncPendingStmt: Prepared;
  private setSyncedStmt: Prepared;
  private setSyncFailedStmt: Prepared;
  private syncPendingStmt: Prepared;
  private countsStmt: Prepared;

  constructor(private db: BridgeDb) {
    this.insertStmt = this.db.prepare(
      `INSERT INTO leads
        (id, campaign_run_id, agent_id, identity, business_name, website, website_domain,
         email, phone, address, city, country, source_urls, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = this.db.prepare("SELECT * FROM leads WHERE id = ?");
    this.setStatusStmt = this.db.prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?");
    this.setSyncPendingStmt = this.db.prepare(
      "UPDATE leads SET sync_status = 'pending', sync_error = NULL, updated_at = ? WHERE id = ?",
    );
    this.setSyncedStmt = this.db.prepare(
      `UPDATE leads
       SET sync_status = 'synced', warmbly_contact_id = ?, sync_error = NULL, updated_at = ?
       WHERE id = ?`,
    );
    this.setSyncFailedStmt = this.db.prepare(
      `UPDATE leads
       SET sync_status = 'failed', sync_error = ?,
           sync_attempts = sync_attempts + 1, updated_at = ?
       WHERE id = ?`,
    );
    this.syncPendingStmt = this.db.prepare(
      `SELECT * FROM leads
       WHERE campaign_run_id = ? AND sync_status = 'pending'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    );
    this.countsStmt = this.db.prepare(
      "SELECT status, COUNT(*) AS n FROM leads WHERE campaign_run_id = ? GROUP BY status",
    );
  }

  // Same (campaign_run_id, identity) twice is one canonical lead plus a
  // duplicate counter: reports { duplicate: true } instead of throwing.
  insert(lead: InsertLead): { duplicate: boolean } {
    try {
      this.insertStmt.run(
        lead.id,
        lead.campaignRunId,
        lead.agentId ?? null,
        lead.identity,
        lead.businessName,
        lead.website ?? null,
        lead.websiteDomain ?? null,
        lead.email ?? null,
        lead.phone ?? null,
        lead.address ?? null,
        lead.city ?? null,
        lead.country ?? null,
        asJson(lead.sourceUrls, "[]"),
        lead.confidence ?? 0,
        lead.status ?? LEAD_STATUS.DISCOVERED,
      );
      return { duplicate: false };
    } catch (err) {
      if (isIdentityConflict(err)) return { duplicate: true };
      throw err;
    }
  }

  get(id: string): LeadRow | undefined {
    return this.getStmt.get(id) as LeadRow | undefined;
  }

  setStatus(id: string, status: string): void {
    this.setStatusStmt.run(status, utcNow(), id);
  }

  setSyncPending(id: string): void {
    this.setSyncPendingStmt.run(utcNow(), id);
  }

  setSynced(id: string, contactId: string): void {
    this.setSyncedStmt.run(contactId, utcNow(), id);
  }

  setSyncFailed(id: string, error: string): void {
    this.setSyncFailedStmt.run(error, utcNow(), id);
  }

  getSyncPending(runId: string, limit: number): LeadRow[] {
    return this.syncPendingStmt.all(runId, limit) as LeadRow[];
  }

  // Crash recovery: transient in-flight states return to their resting
  // state (RESEARCHING came only from DISCOVERED; PERSONALIZING only from
  // QUALIFIED). Returns the number of rows reset.
  resetStuck(runId: string): number {
    const info = this.db
      .prepare(
        `UPDATE leads SET status = CASE status WHEN 'RESEARCHING' THEN 'DISCOVERED' WHEN 'PERSONALIZING' THEN 'QUALIFIED' ELSE status END, updated_at = ? WHERE campaign_run_id = ? AND status IN ('RESEARCHING', 'PERSONALIZING')`,
      )
      .run(utcNow(), runId);
    return Number(info.changes);
  }

  hasUnfinishedWork(runId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM leads WHERE campaign_run_id = ? AND status IN ('DISCOVERED', 'RESEARCHING', 'QUALIFIED', 'PERSONALIZING', 'PERSONALIZED', 'RENDERED')`,
      )
      .get(runId) as { n: number };
    return row.n > 0;
  }

  listByRun(runId: string, limit: number, offset: number): LeadRow[] {
    return this.db
      .prepare("SELECT * FROM leads WHERE campaign_run_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?")
      .all(runId, limit, offset) as LeadRow[];
  }

  listByStatus(runId: string, status: string, limit: number): LeadRow[] {
    return this.db
      .prepare("SELECT * FROM leads WHERE campaign_run_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(runId, status, limit) as LeadRow[];
  }

  countsByStatus(runId: string): Record<string, number> {
    const rows = this.countsStmt.all(runId) as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }
}

export interface ResearchRow {
  lead_id: string;
  summary: string;
  pain_points: string;
  facts: string;
  created_at: string;
}

export interface ResearchInput {
  summary?: string;
  painPoints?: unknown;
  facts?: unknown;
}

export class Research {
  private upsertStmt: Prepared;
  private getStmt: Prepared;

  constructor(private db: BridgeDb) {
    this.getStmt = this.db.prepare("SELECT * FROM lead_research WHERE lead_id = ?");
    this.upsertStmt = this.db.prepare(
      `INSERT INTO lead_research (lead_id, summary, pain_points, facts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(lead_id) DO UPDATE SET
         summary = excluded.summary,
         pain_points = excluded.pain_points,
         facts = excluded.facts`,
    );
  }

  upsert(leadId: string, research: ResearchInput): void {
    this.upsertStmt.run(
      leadId,
      research.summary ?? "",
      asJson(research.painPoints, "[]"),
      asJson(research.facts, "[]"),
    );
  }

  get(leadId: string): { summary: string; painPoints: string[]; facts: Array<{ claim: string; sourceUrl: string }> } | undefined {
    const row = this.getStmt.get(leadId) as ResearchRow | undefined;
    if (!row) return undefined;
    const parseJson = (raw: string): [] => {
      try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? (v as []) : [];
      } catch {
        return [];
      }
    };
    return {
      summary: row.summary,
      painPoints: parseJson(row.pain_points) as string[],
      facts: parseJson(row.facts) as Array<{ claim: string; sourceUrl: string }>,
    };
  }
}

export interface DraftRow {
  id: string;
  lead_id: string;
  subject: string;
  body: string;
  template_name: string;
  template_version: string;
  rendered_html_snapshot: string | null;
  offer_snapshot: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertDraft {
  id: string;
  leadId: string;
  subject: string;
  body: string;
  templateName: string;
  templateVersion: string;
  renderedHtml?: string | null;
  offerSnapshot?: string[] | string;
  status?: string;
}

export class Drafts {
  private upsertStmt: Prepared;

  constructor(private db: BridgeDb) {
    // One draft per lead: re-rendering the same lead replaces its draft.
    this.upsertStmt = this.db.prepare(
      `INSERT INTO outreach_drafts
        (id, lead_id, subject, body, template_name, template_version,
         rendered_html_snapshot, offer_snapshot, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lead_id) DO UPDATE SET
         id = excluded.id,
         subject = excluded.subject,
         body = excluded.body,
         template_name = excluded.template_name,
         template_version = excluded.template_version,
         rendered_html_snapshot = excluded.rendered_html_snapshot,
         offer_snapshot = excluded.offer_snapshot,
         status = excluded.status,
         updated_at = ?`,
    );
  }

  upsert(draft: UpsertDraft): void {
    this.upsertStmt.run(
      draft.id,
      draft.leadId,
      draft.subject,
      draft.body,
      draft.templateName,
      draft.templateVersion,
      draft.renderedHtml ?? null,
      asJson(draft.offerSnapshot, "[]"),
      draft.status ?? DRAFT_STATUS.DRAFT,
      utcNow(),
    );
  }
}

export interface EventRow {
  id: number;
  kind: string;
  campaign_run_id: string | null;
  agent_id: string | null;
  job_id: string | null;
  lead_id: string | null;
  message: string;
  created_at: string;
}

export interface AppendEvent {
  kind: string;
  campaignRunId: string;
  agentId?: string | null;
  jobId?: string | null;
  leadId?: string | null;
  message?: string;
}

export class Events {
  private appendStmt: Prepared;
  private listStmt: Prepared;

  constructor(private db: BridgeDb) {
    this.appendStmt = this.db.prepare(
      `INSERT INTO events (kind, campaign_run_id, agent_id, job_id, lead_id, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.listStmt = this.db.prepare(
      "SELECT * FROM events WHERE campaign_run_id = ? ORDER BY id ASC LIMIT ?",
    );
  }

  // Events are operational notes, never a place for secrets: callers must not
  // pass API keys, tokens, credentials, or raw provider output in `message`.
  // Keep messages short, human-readable status notes.
  append(event: AppendEvent): number {
    const info = this.appendStmt.run(
      event.kind,
      event.campaignRunId,
      event.agentId ?? null,
      event.jobId ?? null,
      event.leadId ?? null,
      event.message ?? "",
    );
    return Number(info.lastInsertRowid);
  }

  list(runId: string, limit: number): EventRow[] {
    return this.listStmt.all(runId, limit) as EventRow[];
  }
}
