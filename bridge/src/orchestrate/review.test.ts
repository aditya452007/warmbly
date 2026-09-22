import { describe, expect, it, vi } from "vitest";
import { openBridgeDb, closeDb, type BridgeDb } from "../db.js";
import { AgentRuns, CampaignRuns, DiscoveryJobs, Drafts, Events, Leads, Research } from "../store/repositories.js";
import { StubAiProvider } from "../ai/stubProvider.js";
import { WarmblyClient } from "../warmbly/client.js";
import { BridgeOrchestrator } from "./orchestrator.js";
import type { BridgeConfig } from "../config.js";

const OFFERS = ["https://example.com/offer-one", "https://example.com/offer-two", "https://example.com/offer-three"];

function mockWarmbly() {
  const contacts = new Map<string, { id: string; custom_fields: Record<string, string> }>([
    ["a@x.com", { id: "c1", custom_fields: { website: "https://a.example" } }],
  ]);
  const paths: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url as string);
    paths.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/v1/contacts/lookup") {
      const hit = contacts.get((u.searchParams.get("email") ?? "").toLowerCase());
      return json(200, { contact: hit ? { id: hit.id } : null });
    }
    const m = u.pathname.match(/^\/v1\/contacts\/([^/]+)$/);
    if (m && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as { custom_fields?: Record<string, string> };
      for (const c of contacts.values()) if (c.id === m[1] && body.custom_fields) c.custom_fields = body.custom_fields;
      return json(200, {});
    }
    if (u.pathname === "/v1/contacts/c1" && (init?.method ?? "GET") === "GET") {
      return json(200, { id: "c1", custom_fields: contacts.get("a@x.com")?.custom_fields ?? {} });
    }
    return json(404, { error: "x", message: "not found", code: "not_found" });
  });
  return { fetchFn, contacts, paths };
}

function setup() {
  const db = openBridgeDb(":memory:");
  const mock = mockWarmbly();
  const warmbly = new WarmblyClient({
    baseUrl: "http://localhost:8080",
    apiKey: "wmbly_testkey12345678",
    timeoutMs: 3000,
    maxAttempts: 1,
    fetchFn: mock.fetchFn as unknown as typeof fetch,
  });
  const config = { AI_JOB_TIMEOUT_MS: 5000, AI_RETRY_ATTEMPTS: 0, OPENCODE_MODEL: "" } as BridgeConfig;
  const deps = {
    config,
    runs: new CampaignRuns(db),
    agents: new AgentRuns(db),
    jobs: new DiscoveryJobs(db),
    leads: new Leads(db),
    research: new Research(db),
    drafts: new Drafts(db),
    events: new Events(db),
    warmbly,
  };
  const orchestrator = new BridgeOrchestrator({ ...deps, createRuntime: () => new StubAiProvider([]) });
  deps.runs.create({
    id: "run-1",
    warmblyCampaignId: "camp-1",
    businessType: "Plumbers",
    location: "Austin",
    customInstructions: "",
    offerUrls: OFFERS,
    parallelAgents: 1,
    targetLeads: 5,
  });
  deps.leads.insert({
    id: "lead-1",
    campaignRunId: "run-1",
    identity: "domain:a.example",
    businessName: "Acme Plumbing",
    website: "https://a.example",
    email: "a@x.com",
    sourceUrls: ["https://maps.example/a"],
    status: "QUALIFIED",
  });
  deps.research.upsert("lead-1", { summary: "Family shop.", painPoints: ["Slow booking"], facts: [] });
  deps.drafts.upsert({
    id: "draft-1",
    leadId: "lead-1",
    subject: "AI subject",
    body: "AI body text here.",
    templateName: "warmbly-outreach",
    templateVersion: "1",
    renderedHtml: "<p>snapshot</p>",
    offerSnapshot: OFFERS,
    status: "NEEDS_REVIEW",
  });
  return { db, mock, orchestrator, deps };
}

describe("draft review", () => {
  it("lists and retrieves drafts with research context", () => {
    const { db, orchestrator } = setup();
    try {
      const list = orchestrator.listDrafts("run-1", 50, 0) as Array<Record<string, unknown>>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ business_name: "Acme Plumbing", status: "NEEDS_REVIEW" });
      expect(list[0].offer_urls).toEqual(OFFERS);
      const one = orchestrator.getDraft("draft-1") as Record<string, unknown>;
      expect(one).toMatchObject({ subject: "AI subject", research_summary: "Family shop." });
      expect(() => orchestrator.getDraft("missing")).toThrow("draft not found");
    } finally {
      closeDb(db);
    }
  });

  it("saves edits with version check, re-render, and contact sync", async () => {
    const { db, mock, orchestrator } = setup();
    try {
      const saved = (await orchestrator.saveDraft("draft-1", {
        subject: "Human subject",
        body: "Human rewritten body with specifics.",
        version: 1,
      })) as Record<string, unknown>;
      expect(saved.subject).toBe("Human subject");
      expect(saved.version).toBe(2);
      expect(saved.status).toBe("NEEDS_REVIEW");
      expect(String(saved.rendered_html)).toContain("Human rewritten body with specifics.");
      // Offers byte-identical after edit.
      for (const url of OFFERS) expect(String(saved.rendered_html)).toContain(url);
      // Contact vars refreshed, discovery fields merged rather than wiped.
      expect(mock.contacts.get("a@x.com")?.custom_fields.website).toBe("https://a.example");
      expect(mock.contacts.get("a@x.com")?.custom_fields.ai_subject).toBe("Human subject");
      // Stale version conflicts instead of overwriting.
      await expect(
        orchestrator.saveDraft("draft-1", { subject: "x", body: "Stale edit attempt here.", version: 1 }),
      ).rejects.toThrow("changed underneath");
      // Invalid content rejected.
      await expect(orchestrator.saveDraft("draft-1", { subject: "x", body: "", version: 2 })).rejects.toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("approves and rejects without touching any send path", () => {
    const { db, mock, orchestrator } = setup();
    try {
      const approved = orchestrator.approveDraft("draft-1") as Record<string, unknown>;
      expect(approved.status).toBe("APPROVED");
      const rejected = orchestrator.rejectDraft("draft-1") as Record<string, unknown>;
      expect(rejected.status).toBe("REJECTED");
      expect(() => orchestrator.approveDraft("missing")).toThrow("draft not found");
      expect(mock.paths.some((p) => /\/start|\/send|\/test-email/.test(p))).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("regenerates through a fresh AI session without offer URLs", async () => {
    const { db, orchestrator, deps } = setup();
    try {
      const stub = new StubAiProvider([
        { match: (p: string) => p.includes("# Personalization task"), result: { subject: "Fresh angle", body: "Freshly researched body text." } },
      ]);
      const regen = new BridgeOrchestrator({ ...deps, createRuntime: () => stub });
      const out = (await regen.regenerateDraft("draft-1")) as Record<string, unknown>;
      expect(out.subject).toBe("Fresh angle");
      expect(out.status).toBe("NEEDS_REVIEW");
      expect(out.source).toBe("ai");
      await expect(regen.regenerateDraft("missing")).rejects.toThrow("draft not found");
      expect(orchestrator).toBeDefined();
    } finally {
      closeDb(db);
    }
  });

  it("maps legacy RENDERED rows to NEEDS_REVIEW", () => {
    const { db, orchestrator, deps } = setup();
    try {
      deps.leads.insert({
        id: "lead-old",
        campaignRunId: "run-1",
        identity: "domain:old.example",
        businessName: "Old Shop",
        website: "https://old.example",
        sourceUrls: ["https://maps.example/old"],
      });
      // Bypass upsert (one draft per lead) to simulate a pre-review row.
      db.prepare(
        `INSERT INTO outreach_drafts (id, lead_id, subject, body, template_name, template_version, status)
         VALUES ('draft-old', 'lead-old', 'Old', 'Old body', 'warmbly-outreach', '1', 'RENDERED')`,
      ).run();
      const list = orchestrator.listDrafts("run-1", 50, 0) as Array<Record<string, unknown>>;
      const legacy = list.find((d) => d.id === "draft-old");
      expect(legacy?.status).toBe("NEEDS_REVIEW");
    } finally {
      closeDb(db);
    }
  });
});
