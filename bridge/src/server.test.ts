import { describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "./server.js";

// HTTP-layer tests with a stub orchestrator: status codes, envelopes, and
// validation edges. Business logic is covered in review.test.ts.
function stubOrchestrator(overrides: Record<string, unknown> = {}) {
  const draft = {
    id: "d1",
    lead_id: "l1",
    business_name: "Acme",
    email: "a@x.com",
    website: "https://a.example",
    location: "Austin",
    agent_id: "ag1",
    research_summary: "Family shop.",
    pain_points: ["Slow booking"],
    facts: [],
    subject: "Hi",
    body: "Hello there.",
    status: "NEEDS_REVIEW",
    source: "ai",
    version: 3,
    template_name: "warmbly-outreach",
    template_version: "1",
    rendered_html: "<p>Hello there.</p>",
    offer_urls: ["https://example.com/offer-one"],
    updated_at: "2026-09-22T00:00:00.000Z",
  };
  return {
    listRunsForCampaign: (id: string) => [{ id: "run-1", status: "READY_FOR_REVIEW" }],
    listDrafts: () => [draft],
    getDraft: (id: string) => {
      if (id !== "d1") throw new Error("draft not found");
      return draft;
    },
    saveDraft: vi.fn(async (id: string, input: { version: number }) => {
      if (id !== "d1") throw new Error("draft not found");
      if (input.version !== 3) {
        const err = new Error("draft changed underneath") as Error & { code?: string };
        err.code = "draft_conflict";
        throw err;
      }
      return { ...draft, version: 4 };
    }),
    approveDraft: (id: string) => {
      if (id !== "d1") throw new Error("draft not found");
      return { ...draft, status: "APPROVED" };
    },
    rejectDraft: (id: string) => {
      if (id !== "d1") throw new Error("draft not found");
      return { ...draft, status: "REJECTED" };
    },
    regenerateDraft: vi.fn(async () => ({ ...draft, subject: "Fresh" })),
    ...overrides,
  };
}

async function json(app: { request: (url: string, init?: RequestInit) => Promise<Response> }, url: string, init?: RequestInit) {
  const res = await app.request(url, init);
  const body = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, body };
}

describe("review API", () => {
  it("lists runs, drafts, and single drafts with envelopes", async () => {
    const app = createBridgeApp(stubOrchestrator() as never);
    expect((await json(app, "/api/warmbly/camp-1/runs")).status).toBe(200);
    const drafts = await json(app, "/api/campaigns/run-1/drafts");
    expect(drafts.status).toBe(200);
    expect((drafts.body as { drafts: unknown[] }).drafts).toHaveLength(1);
    const one = await json(app, "/api/drafts/d1");
    expect(one.status).toBe(200);
    expect(await json(app, "/api/drafts/nope")).toMatchObject({ status: 404 });
  });

  it("serves stored preview HTML and 409s when none exists", async () => {
    const app = createBridgeApp(stubOrchestrator() as never);
    const ok = await json(app, "/api/drafts/d1/preview");
    expect(ok.status).toBe(200);
    expect((ok.body as { html: string }).html).toContain("Hello there.");
    const nodraft = await json(app, "/api/drafts/nope/preview");
    expect(nodraft.status).toBe(404);
  });

  it("validates save input and maps version conflicts to 409", async () => {
    const app = createBridgeApp(stubOrchestrator() as never);
    const bad = await json(app, "/api/drafts/d1", {
      method: "PATCH",
      body: JSON.stringify({ subject: "x" }),
    });
    expect(bad.status).toBe(400);
    const stale = await json(app, "/api/drafts/d1", {
      method: "PATCH",
      body: JSON.stringify({ subject: "x", body: "Stale body here.", version: 1 }),
    });
    expect(stale.status).toBe(409);
    const fresh = await json(app, "/api/drafts/d1", {
      method: "PATCH",
      body: JSON.stringify({ subject: "x", body: "Fresh body here.", version: 3 }),
    });
    expect(fresh.status).toBe(200);
  });

  it("approves, rejects, and regenerates", async () => {
    const app = createBridgeApp(stubOrchestrator() as never);
    expect((await json(app, "/api/drafts/d1/approve", { method: "POST" })).status).toBe(200);
    expect((await json(app, "/api/drafts/d1/reject", { method: "POST" })).status).toBe(200);
    expect((await json(app, "/api/drafts/d1/regenerate", { method: "POST" })).status).toBe(200);
    expect((await json(app, "/api/drafts/nope/approve", { method: "POST" })).status).toBe(404);
  });
});
