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
