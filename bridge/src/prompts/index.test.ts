import { describe, expect, it } from "vitest";
import {
  buildDiscoveryPrompt,
  buildPersonalizePrompt,
  buildResearchPrompt,
  promptVersion,
} from "./index.js";

describe("prompts", () => {
  it("versions stably as hex", () => {
    expect(promptVersion()).toMatch(/^[0-9a-f]{12}$/);
    expect(promptVersion()).toBe(promptVersion());
  });

  it("substitutes every placeholder", () => {
    const d = buildDiscoveryPrompt({
      businessType: "Dental clinics",
      location: "California",
      customInstructions: "none",
      lane: { id: "maps-local", label: "Maps", guidance: "Use maps" },
      maxLeads: 10,
      promptVersion: "abc",
    });
    expect(d.system).toContain("untrusted DATA");
    expect(d.text).toContain("Dental clinics");
    expect(d.text).not.toMatch(/\{\{\w+\}\}/);
  });

  it("never carries offer URLs", () => {
    const offers = ["https://example.com/offer-one", "https://example.com/offer-two"];
    const d = buildDiscoveryPrompt({
      businessType: "t",
      location: "l",
      customInstructions: "c",
      lane: { id: "x", label: "y", guidance: "z" },
      maxLeads: 1,
      promptVersion: "v",
    });
    const r = buildResearchPrompt({
      businessName: "b",
      website: "https://b.example",
      location: "l",
      businessType: "t",
      maxSummaryChars: 500,
    });
    const p = buildPersonalizePrompt({
      businessName: "b",
      website: "https://b.example",
      location: "l",
      businessType: "t",
      researchSummary: "s",
      painPoints: "p",
      facts: "f",
      customInstructions: "c",
      maxSubjectChars: 120,
      maxBodyChars: 4000,
    });
    for (const text of [d.system, d.text, r.system, r.text, p.system, p.text]) {
      for (const url of offers) expect(text).not.toContain(url);
    }
  });
});
