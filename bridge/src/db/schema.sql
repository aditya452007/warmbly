-- Bridge local state. SQLite, WAL mode, short transactions.
-- Warmbly remains the system of record for outreach; this DB owns AI job state.

CREATE TABLE IF NOT EXISTS campaign_runs (
  id TEXT PRIMARY KEY,
  warmbly_campaign_id TEXT NOT NULL,
  business_type TEXT NOT NULL,
  location TEXT NOT NULL,
  custom_instructions TEXT NOT NULL DEFAULT '',
  offer_url_1 TEXT,
  offer_url_2 TEXT,
  offer_url_3 TEXT,
  parallel_agents INTEGER NOT NULL,
  target_leads INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  campaign_run_id TEXT NOT NULL REFERENCES campaign_runs(id) ON DELETE CASCADE,
  agent_number INTEGER NOT NULL,
  session_id TEXT,
  lane TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  current_task TEXT,
  leads_found INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  last_heartbeat TEXT,
  error_message TEXT,
  UNIQUE (campaign_run_id, agent_number)
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_campaign ON agent_runs(campaign_run_id);

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id TEXT PRIMARY KEY,
  campaign_run_id TEXT NOT NULL REFERENCES campaign_runs(id) ON DELETE CASCADE,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_campaign_status ON discovery_jobs(campaign_run_id, status);

-- A lead's business identity is its normalized website domain when present,
-- else its normalized email. Unique per campaign run: the same business found
-- twice in one run is one canonical lead plus a duplicate counter. Cross-run
-- repeats are allowed (different campaigns may target overlapping markets).
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  campaign_run_id TEXT NOT NULL REFERENCES campaign_runs(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  identity TEXT NOT NULL,
  business_name TEXT NOT NULL,
  website TEXT,
  website_domain TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  source_urls TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  warmbly_contact_id TEXT,
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (campaign_run_id, identity)
);
CREATE INDEX IF NOT EXISTS idx_leads_campaign_status ON leads(campaign_run_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_sync ON leads(sync_status);

CREATE TABLE IF NOT EXISTS lead_research (
  lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  pain_points TEXT NOT NULL DEFAULT '[]',
  facts TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_version TEXT NOT NULL,
  rendered_html_snapshot TEXT,
  offer_snapshot TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  -- source tracks provenance: 'ai' for generated, 'human' after a manual edit.
  -- version increments on every save for optimistic concurrency.
  source TEXT NOT NULL DEFAULT 'ai',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One controlled send per draft version. The UNIQUE(draft_id, draft_version)
-- is the double-click/duplicate guard: a second send of identical content is
-- refused, while a re-approved edit (new version) may send again.
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  draft_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  provider TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  error_message TEXT,
  force_retried INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (draft_id, draft_version)
);
CREATE INDEX IF NOT EXISTS idx_sends_draft ON sends(draft_id);

-- Phase 8 bulk campaign sending. One queue per bridge campaign run owns the
-- bounded, paced delivery of its APPROVED drafts. Queue rows survive restart;
-- unfinished items resume from persisted state, never from memory.
CREATE TABLE IF NOT EXISTS send_queues (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES campaign_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  daily_limit INTEGER NOT NULL DEFAULT 50,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  concurrency INTEGER NOT NULL DEFAULT 1,
  -- Campaign-level sending authorization, attested once by the operator at
  -- start. Per-send consent is satisfied by a subscribed contact OR this
  -- attestation; the contact's subscribed flag is never flipped silently.
  consent_attested INTEGER NOT NULL DEFAULT 0,
  followup_enabled INTEGER NOT NULL DEFAULT 1,
  followup_days TEXT NOT NULL DEFAULT '[3,7,12]',
  -- Least surprise: AI follow-ups need a human approval before they may send.
  -- An explicit campaign-level opt-out auto-approves on generation instead.
  followup_require_approval INTEGER NOT NULL DEFAULT 1,
  -- Lifetime live-send cap for this queue. Fail-closed bulk safety.
  max_live_sends INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One queue item per (draft version, kind). kind is 'initial' or
-- 'followup:<seq>'. The idempotency key is the stable send identity across
-- restarts and workers: draft + version + recipient + campaign run + kind.
CREATE TABLE IF NOT EXISTS send_items (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES send_queues(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  draft_version INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'initial',
  seq INTEGER NOT NULL DEFAULT 0,
  followup_id TEXT REFERENCES followup_drafts(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  -- Due date for pacing/follow-ups. NULL means due immediately.
  scheduled_for TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  in_reply_to TEXT,
  consent_source TEXT,
  error_code TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (queue_id, draft_id, draft_version, kind, seq)
);
CREATE INDEX IF NOT EXISTS idx_send_items_queue_status ON send_items(queue_id, status);
CREATE INDEX IF NOT EXISTS idx_send_items_due ON send_items(queue_id, status, scheduled_for, next_attempt_at);

-- AI-generated follow-up copy. Plain text only: React Email owns
-- presentation, offer URLs are inserted by the template layer, never by AI.
CREATE TABLE IF NOT EXISTS followup_drafts (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES send_queues(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  parent_draft_id TEXT NOT NULL REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  rendered_html TEXT,
  status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
  version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (queue_id, lead_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_followups_queue ON followup_drafts(queue_id, status);

-- Persisted per-day send counters. Restart-safe daily pacing: the count is
-- incremented in the same step that stamps SENT, never recomputed from rows.
CREATE TABLE IF NOT EXISTS send_day_counters (
  queue_id TEXT NOT NULL REFERENCES send_queues(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queue_id, day)
);

-- Local signals that stop future sends: replies, unsubscribes, complaints.
-- Written by inbound-sync hooks, manual operator marks, and tests. A present
-- 'replied' row halts the whole follow-up chain for that lead.
CREATE TABLE IF NOT EXISTS contact_signals (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES send_queues(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_queue_email ON contact_signals(queue_id, email);

-- Structured application events. Never stores secrets or raw provider output.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  campaign_run_id TEXT REFERENCES campaign_runs(id) ON DELETE CASCADE,
  agent_id TEXT,
  job_id TEXT,
  lead_id TEXT,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_run_id, id);
