import { describe, expect, it, vi } from "vitest";
import { openBridgeDb, closeDb } from "../db.js";
import { AgentRuns, CampaignRuns, DiscoveryJobs, Drafts, Events, Leads, Research, Sends } from "../store/repositories.js";
import { StubAiProvider } from "../ai/stubProvider.js";
import { WarmblyClient } from "../warmbly/client.js";
import { BridgeOrchestrator } from "./orchestrator.js";
import type { BridgeConfig } from "../config.js";

const OFFERS = ["https://example.com/offer-one", "https://example.com/offer-two", "https://example.com/offer-three"];

function lead(name: string, site: string | null, email: string | null, source: string) {
  return {
    business_name: name,
    website: site,
    email,
    phone: null,
    address: null,
    city: "Austin",
    country: "US",
    source_urls: [source],
    confidence: 0.8,
  };
}

function researchResult() {
  return {
    summary: "Family-run shop with an outdated booking page observed on 2026-09-20.",
    pain_points: ["Booking takes four clicks"],
    facts: [{ claim: "Booking page exists", source_url: "https://acme.example/book" }],
  };
}

function personalizeResult(name: string) {
  return { subject: `A quick idea for ${name}`, body: `I came across ${name} and noticed the booking flow.` };
}

// In-memory Warmbly double: contacts keyed by email, one campaign, steps.
function mockWarmbly() {
  const contacts = new Map<string, { id: string; custom_fields: Record<string, string> }>();
  const steps: Array<{ id: string; name: string; subject: string; body_html: string }> = [];
  const paths: string[] = [];
  let n = 0;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url as string);
    paths.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/v1/campaigns/w1") {
      return json(200, { id: "w1", name: "AI test", status: "draft", kind: "sequence", daily_limit: 50 });
    }
    if (u.pathname === "/v1/contacts" && init?.method === "POST") {
      const arr = JSON.parse(init.body as string) as Array<{ email: string; custom_fields?: Record<string, string> }>;
      const out = arr.map((c) => {
        const existing = contacts.get(c.email.toLowerCase());
        if (existing) {
          if (c.custom_fields) existing.custom_fields = { ...existing.custom_fields, ...c.custom_fields };
          return { id: existing.id };
        }
        const id = `c${++n}`;
        contacts.set(c.email.toLowerCase(), { id, custom_fields: c.custom_fields ?? {} });
        return { id };
      });
      return json(200, out);
    }
    if (u.pathname === "/v1/contacts/lookup") {
      const hit = contacts.get((u.searchParams.get("email") ?? "").toLowerCase());
      return json(200, { contact: hit ? { id: hit.id } : null });
    }
    const contactPatch = u.pathname.match(/^\/v1\/contacts\/([^/]+)$/);
    if (contactPatch && init?.method === "PATCH") {
      const id = contactPatch[1];
      const body = JSON.parse(init.body as string) as { custom_fields?: Record<string, string> };
      for (const c of contacts.values()) if (c.id === id && body.custom_fields) c.custom_fields = body.custom_fields;
      return json(200, {});
    }
    if (u.pathname === "/v1/campaigns/w1/steps" && (init?.method ?? "GET") === "GET") return json(200, steps);
    if (u.pathname === "/v1/campaigns/w1/steps" && init?.method === "POST") {
      const step = { id: `s${steps.length + 1}`, name: "", subject: "", body_html: "" };
      steps.push(step);
      return json(200, step);
    }
    const stepPatch = u.pathname.match(/^\/v1\/campaigns\/w1\/steps\/([^/]+)$/);
    if (stepPatch && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as { subject?: string; body_html?: string };
      const step = steps.find((s) => s.id === stepPatch[1]);
      if (step) Object.assign(step, body);
      return json(200, {});
    }
    return json(404, { error: "x", message: "not found", code: "not_found" });
  });
  return { fetchFn, contacts, steps, paths };
}

describe("end-to-end run with stub AI", () => {
  it("4 agents, duplicates, one failure, contacts synced, step prepared, never sends", async () => {
    const db = openBridgeDb(":memory:");
    const mock = mockWarmbly();
    const config = {
      MAX_PARALLEL_AGENTS: 16,
      AI_JOB_TIMEOUT_MS: 10_000,
      AI_RETRY_ATTEMPTS: 1,
      WARMBLY_API_TIMEOUT_MS: 5000,
      WARMBLY_RETRY_ATTEMPTS: 2,
      OPENCODE_BASE_URL: "http://127.0.0.1:4096",
      OPENCODE_SERVER_USERNAME: "",
      OPENCODE_SERVER_PASSWORD: "",
    } as BridgeConfig;
    const stub = new StubAiProvider([
      { match: (p) => p === "Reply with exactly: ok", result: "ok" },
      { match: (p) => p.includes("maps-local"), result: [lead("Acme", "https://acme.example", "acme@x.com", "https://m.example/a"), lead("Dup", "https://dup.example", "dup@x.com", "https://m.example/d")] },
      { match: (p) => p.includes("organic-search"), result: [lead("Dup", "https://dup.example", "dup@x.com", "https://o.example/d"), lead("Beacon", "https://beacon.example", "beacon@x.com", "https://o.example/b")] },
      { match: (p) => p.includes("directories"), error: { code: "ai_timeout", message: "lane down" } },
      { match: (p) => p.includes("query-variations"), result: [lead("NoMail", "https://nomail.example", null, "https://q.example/n")] },
      ...[0, 1, 2, 3].map(() => ({ match: (p: string) => p.includes("# Research task"), result: researchResult() })),
      ...[0, 1, 2].map(() => ({ match: (p: string) => p.includes("# Personalization task"), result: personalizeResult("Shop") })),
    ]);
    const warmbly = new WarmblyClient({
      baseUrl: "http://localhost:8080",
      apiKey: "wmbly_testkey12345678",
      timeoutMs: 5000,
      maxAttempts: 2,
      fetchFn: mock.fetchFn as unknown as typeof fetch,
    });
    const orchestrator = new BridgeOrchestrator({
      config,
      runs: new CampaignRuns(db),
      agents: new AgentRuns(db),
      jobs: new DiscoveryJobs(db),
      leads: new Leads(db),
      research: new Research(db),
      drafts: new Drafts(db),
      events: new Events(db),
      sends: new Sends(db),
      warmbly,
      createRuntime: () => stub,
    });
    try {
      const runId = await orchestrator.startRun({
        warmblyCampaignId: "w1",
        businessType: "Plumbers",
        location: "Austin",
        customInstructions: "",
        offerUrls: OFFERS,
        parallelAgents: 4,
        targetLeads: 10,
      });
      const terminal = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"];
      const deadline = Date.now() + 25_000;
      let status = "";
      while (Date.now() < deadline) {
        status = String((orchestrator.getStatus(runId) as { status: string }).status);
        if (terminal.includes(status)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      // One lane failed, others delivered: degraded, never fully failed.
      expect(status).toBe("PARTIALLY_COMPLETED");
      const summary = orchestrator.getStatus(runId) as {
        agents: { total: number; failed: number };
        leads: { synced: number };
        errors: number;
      };
      expect(summary.agents.total).toBe(4);
      expect(summary.agents.failed).toBe(1);
      // Canonical leads only: Dup discovered twice is one lead + duplicate.
      expect(mock.contacts.size).toBe(3);
      expect(summary.leads.synced).toBe(3);
      // No send/start path was ever touched.
      expect(mock.paths.some((p) => /\/start|\/send|\/test-email/.test(p))).toBe(false);
      // Step shell prepared with variable + exact offers.
      expect(mock.steps).toHaveLength(1);
      expect(mock.steps[0].subject).toBe("{{.ai_subject}}");
      expect(mock.steps[0].body_html).toContain("{{.ai_body}}");
      for (const url of OFFERS) expect(mock.steps[0].body_html).toContain(url);
      // Personalization variables attached to each contact.
      for (const c of mock.contacts.values()) {
        expect(c.custom_fields.ai_subject).toContain("Shop");
        expect(c.custom_fields.ai_body).toContain("booking flow");
      }
      // Agent isolation visible in status.
      const agents = orchestrator.listAgents(runId) as Array<{ status: string }>;
      expect(agents.filter((a) => a.status === "SUCCEEDED")).toHaveLength(3);
      expect(agents.filter((a) => a.status === "FAILED")).toHaveLength(1);
    } finally {
      await orchestrator.shutdown();
      closeDb(db);
    }
  }, 60_000);
});
