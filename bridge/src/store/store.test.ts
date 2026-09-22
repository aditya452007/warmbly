import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDb, openBridgeDb } from "../db.js";
import type { BridgeDb } from "../db.js";
import {
  AGENT_STATUS,
  AgentRuns,
  CAMPAIGN_STATUS,
  CampaignRuns,
  DiscoveryJobs,
  Drafts,
  Events,
  JOB_STATUS,
  LEAD_STATUS,
  Leads,
  Research,
} from "./repositories.js";

const TABLES = [
  "campaign_runs",
  "agent_runs",
  "discovery_jobs",
  "leads",
  "lead_research",
  "outreach_drafts",
  "events",
];

function seedRun(db: BridgeDb, id = "run-1"): CampaignRuns {
  const runs = new CampaignRuns(db);
  runs.create({
    id,
    warmblyCampaignId: "camp-1",
    businessType: "plumbers",
    location: "Austin, TX",
    customInstructions: "",
    offerUrls: ["https://example.com/offer"],
    parallelAgents: 2,
    targetLeads: 10,
  });
  return runs;
}

describe("migration", () => {
  it("creates all tables with foreign keys enforced", () => {
    const db = openBridgeDb(":memory:");
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      for (const table of TABLES) {
        expect(rows.map((r) => r.name)).toContain(table);
      }
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("tracks campaign status transitions", () => {
    const db = openBridgeDb(":memory:");
    try {
      const runs = seedRun(db);
      expect(runs.get("run-1")?.status).toBe(CAMPAIGN_STATUS.CREATED);
      runs.setStatus("run-1", CAMPAIGN_STATUS.RUNNING);
      expect(runs.get("run-1")?.status).toBe(CAMPAIGN_STATUS.RUNNING);
      runs.touch("run-1");
      runs.setStatus("run-1", CAMPAIGN_STATUS.FAILED, "boom");
      expect(runs.get("run-1")?.error_message).toBe("boom");
    } finally {
      closeDb(db);
    }
  });
});

describe("leads", () => {
  it("insert reports duplicates without throwing and counts by status", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const agents = new AgentRuns(db);
      agents.create({ id: "agent-1", campaignRunId: "run-1", agentNumber: 1, sessionId: null, lane: "discovery" });
      const leads = new Leads(db);
      const base = {
        campaignRunId: "run-1",
        agentId: "agent-1",
        identity: "example.com",
        businessName: "Example Plumbing",
      };
      expect(leads.insert({ ...base, id: "lead-1" })).toEqual({ duplicate: false });
      expect(leads.insert({ ...base, id: "lead-2", businessName: "Example Plumbing LLC" })).toEqual({
        duplicate: true,
      });
      expect(leads.countsByStatus("run-1")).toEqual({ [LEAD_STATUS.DISCOVERED]: 1 });
      // Same identity in a different run is a different lead.
      seedRun(db, "run-2");
      expect(leads.insert({ ...base, id: "lead-3", campaignRunId: "run-2" })).toEqual({
        duplicate: false,
      });
      // Sync lifecycle roundtrip.
      expect(leads.getSyncPending("run-1", 10).map((l) => l.id)).toEqual(["lead-1"]);
      leads.setSynced("lead-1", "contact-1");
      expect(leads.get("lead-1")?.warmbly_contact_id).toBe("contact-1");
      expect(leads.getSyncPending("run-1", 10)).toEqual([]);
      leads.setSyncPending("lead-1");
      leads.setSyncFailed("lead-1", "nope");
      expect(leads.get("lead-1")?.sync_error).toBe("nope");
    } finally {
      closeDb(db);
    }
  });
});

describe("agents", () => {
  it("findStale returns only RUNNING agents past their lease", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const agents = new AgentRuns(db);
      agents.create({ id: "a-stale", campaignRunId: "run-1", agentNumber: 1, sessionId: "s1", lane: "discovery" });
      agents.create({ id: "a-fresh", campaignRunId: "run-1", agentNumber: 2, sessionId: "s2", lane: "discovery" });
      agents.create({ id: "a-queued", campaignRunId: "run-1", agentNumber: 3, sessionId: null, lane: "discovery" });
      agents.heartbeat("a-stale");
      agents.heartbeat("a-fresh");
      agents.addLeads("a-stale", 3);
      agents.addDuplicates("a-stale", 1);
      agents.addErrors("a-stale", 2);
      expect(agents.listByRun("run-1").map((a) => a.id)).toEqual(["a-stale", "a-fresh", "a-queued"]);

      const oneHourLater = new Date(Date.now() + 3_600_000).toISOString();
      expect(agents.findStale(oneHourLater, 600).map((a) => a.id).sort()).toEqual([
        "a-fresh",
        "a-stale",
      ]);
      expect(agents.findStale(oneHourLater, 7200)).toEqual([]);
      agents.finish("a-stale", AGENT_STATUS.COMPLETED);
      expect(agents.findStale(oneHourLater, 600).map((a) => a.id)).toEqual(["a-fresh"]);
    } finally {
      closeDb(db);
    }
  });
});

describe("discovery jobs", () => {
  it("claimStale retries expired RUNNING leases exactly once", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const jobs = new DiscoveryJobs(db);
      jobs.enqueue({ id: "job-1", campaignRunId: "run-1", agentRunId: null, payload: "{}" });
      const now = new Date().toISOString();
      expect(jobs.claimStale(now)).toEqual([]);
      expect(jobs.pendingCount("run-1")).toBe(1);

      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare("UPDATE discovery_jobs SET status = 'RUNNING', lease_until = ? WHERE id = 'job-1'").run(past);

      const claimed = jobs.claimStale(now);
      expect(claimed.map((j) => j.id)).toEqual(["job-1"]);
      expect(claimed[0]?.status).toBe(JOB_STATUS.RETRYABLE);
      expect(jobs.claimStale(now)).toEqual([]);
      expect(jobs.pendingCount("run-1")).toBe(1);

      jobs.fail("job-1", "timeout", false);
      expect(jobs.pendingCount("run-1")).toBe(0);
    } finally {
      closeDb(db);
    }
  });
});

describe("research and drafts", () => {
  it("upserts research and one draft per lead", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const leads = new Leads(db);
      leads.insert({ id: "lead-1", campaignRunId: "run-1", identity: "example.com", businessName: "Example" });
      const research = new Research(db);
      research.upsert("lead-1", { summary: "v1", painPoints: ["slow season"], facts: ["10 staff"] });
      research.upsert("lead-1", { summary: "v2", painPoints: [], facts: [] });
      const saved = db.prepare("SELECT * FROM lead_research WHERE lead_id = ?").get("lead-1") as {
        summary: string;
      };
      expect(saved.summary).toBe("v2");

      const drafts = new Drafts(db);
      drafts.upsert({
        id: "draft-1",
        leadId: "lead-1",
        subject: "Hi",
        body: "Hello",
        templateName: "intro",
        templateVersion: "1",
        renderedHtml: "<p>Hi</p>",
        offerSnapshot: ["https://example.com/offer"],
      });
      drafts.upsert({
        id: "draft-2",
        leadId: "lead-1",
        subject: "Hi again",
        body: "Hello again",
        templateName: "intro",
        templateVersion: "2",
        offerSnapshot: [],
      });
      const rows = db.prepare("SELECT * FROM outreach_drafts WHERE lead_id = ?").all("lead-1") as Array<{
        id: string;
        subject: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "draft-2", subject: "Hi again" });
    } finally {
      closeDb(db);
    }
  });

  it("drafts survive close and reopen (restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-restart-"));
    try {
      const path = join(dir, "bridge.sqlite");
      const first = openBridgeDb(path);
      try {
        seedRun(first);
        const leads = new Leads(first);
        leads.insert({ id: "lead-9", campaignRunId: "run-1", identity: "example.com", businessName: "Example" });
        new Drafts(first).upsert({
          id: "draft-9",
          leadId: "lead-9",
          subject: "Persisted",
          body: "Survives restart",
          templateName: "intro",
          templateVersion: "1",
          renderedHtml: "<p>x</p>",
          offerSnapshot: ["https://example.com/offer"],
        });
      } finally {
        closeDb(first);
      }
      const second = openBridgeDb(path);
      try {
        const rows = second.prepare("SELECT * FROM outreach_drafts WHERE lead_id = ?").all("lead-9") as Array<{
          subject: string;
          body: string;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ subject: "Persisted", body: "Survives restart" });
      } finally {
        closeDb(second);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("events", () => {
  it("appends and lists events in order", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const events = new Events(db);
      events.append({ kind: "run.started", campaignRunId: "run-1", message: "run started" });
      events.append({ kind: "agent.heartbeat", campaignRunId: "run-1", agentId: "a-1", message: "ok" });
      const listed = events.list("run-1", 10);
      expect(listed.map((e) => e.kind)).toEqual(["run.started", "agent.heartbeat"]);
      expect(events.list("run-1", 1)).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });
});

describe("journal mode", () => {
  it("uses WAL for file databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-db-"));
    try {
      const db = openBridgeDb(join(dir, "nested", "bridge.sqlite"));
      try {
        expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      } finally {
        closeDb(db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("crash recovery", () => {
  function seedLead(db: BridgeDb, id: string, status: string): Leads {
    const leads = new Leads(db);
    leads.insert({
      id,
      campaignRunId: "run-1",
      identity: `domain:${id}.example`,
      businessName: id,
      website: `https://${id}.example`,
      email: `${id}@example.com`,
      sourceUrls: [`https://maps.example/${id}`],
      status,
    });
    return leads;
  }

  it("resets transient lead states to resting states", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const leads = seedLead(db, "researching", "RESEARCHING");
      seedLead(db, "personalizing", "PERSONALIZING");
      seedLead(db, "qualified", "QUALIFIED");
      expect(leads.resetStuck("run-1")).toBe(2);
      expect(leads.get("researching")?.status).toBe("DISCOVERED");
      expect(leads.get("personalizing")?.status).toBe("QUALIFIED");
      expect(leads.get("qualified")?.status).toBe("QUALIFIED");
      expect(leads.resetStuck("run-1")).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("reports unfinished work", () => {    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const leads = new Leads(db);
      expect(leads.hasUnfinishedWork("run-1")).toBe(false);
      seedLead(db, "d1", "DISCOVERED");
      expect(leads.hasUnfinishedWork("run-1")).toBe(true);
      const row = leads.get("d1");
      if (row) leads.setStatus(row.id, "SYNCED_TO_WARMBLY");
      expect(leads.hasUnfinishedWork("run-1")).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("tracks job leases so crashes become retryable", () => {
    const db = openBridgeDb(":memory:");
    try {
      seedRun(db);
      const jobs = new DiscoveryJobs(db);
      jobs.enqueue({ id: "job-1", campaignRunId: "run-1", payload: "{}" });
      expect(jobs.pendingCount("run-1")).toBe(1);
      // A lease far in the past is claimable; a fresh one is not.
      jobs.start("job-1", new Date(Date.now() - 1000).toISOString());
      expect(jobs.claimStale(new Date().toISOString())).toHaveLength(1);
      expect(jobs.pendingCount("run-1")).toBe(1);
      jobs.start("job-1", new Date(Date.now() + 600_000).toISOString());
      expect(jobs.claimStale(new Date().toISOString())).toHaveLength(0);
      jobs.extendLease("job-1", new Date(Date.now() - 1000).toISOString());
      expect(jobs.claimStale(new Date().toISOString())).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });
});
