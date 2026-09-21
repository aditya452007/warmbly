import { describe, it, expect } from "vitest";
import { DEFAULT_LANES, OpenCodeDiscoveryProvider, type DiscoveryCtx } from "./discovery.js";
import { StubAiProvider } from "./stubProvider.js";

function makeCtx(): DiscoveryCtx {
  return {
    businessType: "plumbers",
    location: "Austin, TX",
    customInstructions: "residential only",
    lane: DEFAULT_LANES[0],
    maxLeads: 5,
    promptVersion: "test-1",
  };
}

describe("discovery lanes", () => {
  it("DEFAULT_LANES has 4 distinct ids", () => {
    expect(DEFAULT_LANES).toHaveLength(4);
    const ids = DEFAULT_LANES.map((lane) => lane.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain("maps-local");
    expect(ids).toContain("organic-search");
    expect(ids).toContain("directories");
    expect(ids).toContain("query-variations");
    for (const lane of DEFAULT_LANES) {
      expect(lane.label.length).toBeGreaterThan(0);
      expect(lane.guidance.length).toBeGreaterThan(0);
    }
  });

  it("discovery ctx carries no offer field", () => {
    const ctx = makeCtx();
    expect("offer" in (ctx as Record<string, unknown>)).toBe(false);
    expect("offerUrl" in (ctx as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(ctx).toLowerCase()).not.toContain("offer");
    expect(Object.keys(ctx).sort()).toEqual(
      ["businessType", "customInstructions", "lane", "location", "maxLeads", "promptVersion"].sort(),
    );
  });

  it("stub runtime returns lane leads", async () => {
    const leads = [
      {
        business_name: "Acme Plumbing",
        website: "https://acme-plumbing.example",
        email: null,
        phone: null,
        address: "123 Main St",
        city: "Austin",
        country: "US",
        source_url: "https://maps.example/acme",
        source_urls: ["https://maps.example/acme"],
        confidence: 0.9,
      },
      {
        business_name: "Beacon Rooter",
        website: null,
        email: null,
        phone: null,
        address: null,
        city: "Austin",
        country: "US",
        source_url: "https://directory.example/beacon",
        source_urls: ["https://directory.example/beacon"],
        confidence: 0.7,
      },
    ];
    const stub = new StubAiProvider([{ match: () => true, result: leads }]);
    const provider = new OpenCodeDiscoveryProvider(stub, { timeoutMs: 5000 });
    const found = await provider.discover(makeCtx());
    expect(found).toHaveLength(2);
    expect(found[0].business_name).toBe("Acme Plumbing");
    expect(found[1].business_name).toBe("Beacon Rooter");
  });
});
