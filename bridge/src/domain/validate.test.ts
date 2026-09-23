import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  isHttpUrl,
  leadIdentity,
  LeadSchema,
  normalizeDomain,
  normalizeEmail,
  OutreachSchema,
  redactSecrets,
  ReplyAnalysisSchema,
  ResearchSchema,
  RunRequestSchema,
} from "./validate.js";

describe("urls and emails", () => {
  it("accepts http/https only", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
  });

  it("normalizes domains", () => {
    expect(normalizeDomain("https://WWW.Example.com:8080/a?b=1")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("http://localhost:3000")).toBe(null);
    expect(normalizeDomain("not a url !@#")).toBe(null);
    expect(normalizeDomain(null)).toBe(null);
  });

  it("normalizes emails", () => {
    expect(normalizeEmail("  John@Example.COM ")).toBe("john@example.com");
    expect(normalizeEmail("bad")).toBe(null);
    expect(normalizeEmail(undefined)).toBe(null);
  });

  it("builds lead identity preferring domain", () => {
    expect(leadIdentity("example.com", "a@b.com")).toBe("domain:example.com");
    expect(leadIdentity(null, "a@b.com")).toBe("email:a@b.com");
    expect(() => leadIdentity(null, null)).toThrow();
  });
});

describe("schemas", () => {
  it("rejects run requests without business type or URLs", () => {
    expect(RunRequestSchema.safeParse({}).success).toBe(false);
    const base = {
      warmblyCampaignId: "c",
      businessType: "Dental clinics",
      location: "California",
      offerUrls: ["https://example.com/o"],
      targetLeads: 10,
    };
    expect(RunRequestSchema.safeParse(base).success).toBe(true);
    expect(RunRequestSchema.safeParse({ ...base, offerUrls: [] }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ ...base, parallelAgents: 17 }).success).toBe(false);
  });

  it("requires business name and a source URL on leads", () => {
    expect(LeadSchema.safeParse({ business_name: "", source_urls: [] }).success).toBe(false);
    const ok = LeadSchema.safeParse({
      business_name: "Smile Dental",
      website: "https://smiledental.example",
      source_urls: ["https://maps.example/x"],
      confidence: 0.9,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects CRLF subjects and oversized bodies", () => {
    expect(OutreachSchema.safeParse({ subject: "a\r\nb", body: "hi" }).success).toBe(false);
    expect(OutreachSchema.safeParse({ subject: "ok", body: "" }).success).toBe(false);
    expect(OutreachSchema.safeParse({ subject: "ok", body: "x".repeat(4001) }).success).toBe(false);
  });

  it("rejects Markdown constructs but keeps plain prose", () => {
    expect(OutreachSchema.safeParse({ subject: "ok", body: "See [this](https://x.example/)" }).success).toBe(false);
    expect(OutreachSchema.safeParse({ subject: "ok", body: "# Hello\ntext" }).success).toBe(false);
    expect(OutreachSchema.safeParse({ subject: "ok", body: "This is **great** news" }).success).toBe(false);
    expect(
      OutreachSchema.safeParse({ subject: "ok", body: "A 5-star shop on 1st-Street, open Mon-Fri." }).success,
    ).toBe(true);
  });
});

describe("research tolerance", () => {
  it("accepts model-shaped pain points and facts", () => {
    const parsed = ResearchSchema.safeParse({
      summary: "Family-run shop.",
      pain_points: ["Slow booking", { pain_point: "Stale blog", evidence: " newest 2019" }],
      facts: [
        { claim: "Address observed", source_url: "https://x.example/" },
        { fact: "Phone observed", source: "https://x.example/contact" },
        { wrong: "shape" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pain_points).toEqual(["Slow booking", "Stale blog"]);
      expect(parsed.data.facts).toEqual([
        { claim: "Address observed", sourceUrl: "https://x.example/" },
        { claim: "Phone observed", sourceUrl: "https://x.example/contact" },
      ]);
    }
  });
});

describe("escaping and redaction", () => {
  it("escapes html", () => {
    expect(escapeHtml('<a href="x">&\'')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("redacts credential shapes", () => {
    const s = redactSecrets("key wmbly_abc123XYZ789 and Bearer tok.en-x plus password= hunter2");
    expect(s).not.toContain("wmbly_");
    expect(s).not.toContain("hunter2");
    expect(s).toContain("[REDACTED");
  });
});

describe("reply analysis schema", () => {
  it("accepts the full Phase 10 intent vocabulary", () => {
    for (const intent of [
      "INTERESTED",
      "QUESTION",
      "OBJECTION",
      "NOT_INTERESTED",
      "UNSUBSCRIBE",
      "WRONG_PERSON",
      "AUTO_REPLY",
      "OTHER",
    ]) {
      const parsed = ReplyAnalysisSchema.safeParse({
        intent,
        confidence: 0.9,
        summary: "Wants pricing.",
        suggested_action: "Reply with pricing.",
        requires_response: intent === "INTERESTED" || intent === "QUESTION",
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects arbitrary intent strings (schema-validated, no free text)", () => {
    const parsed = ReplyAnalysisSchema.safeParse({
      intent: "MAYBE_KINDA_INTERESTED",
      confidence: 0.9,
      summary: "Unclear.",
      suggested_action: "Follow up.",
      requires_response: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults requires_response to false when the model omits it", () => {
    const parsed = ReplyAnalysisSchema.safeParse({
      intent: "QUESTION",
      confidence: 0.8,
      summary: "Asks about timeline.",
      suggested_action: "Reply with availability.",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.requires_response).toBe(false);
  });
});
