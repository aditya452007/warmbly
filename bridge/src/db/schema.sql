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
