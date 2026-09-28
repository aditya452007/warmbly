import { describe, expect, it } from "vitest";
import { renderOutreach, RenderError, resolveDirectHtml, templateFor } from "./render.js";

// Spec section 54 fake lead.
const FAKE = {
  aiSubject: "A quick idea for Smile Dental",
  aiBodyText: "I came across Smile Dental and noticed your booking page takes four clicks.",
  offers: [
    "https://example.com/test-offer-one",
    "https://example.com/test-offer-two",
    "https://example.com/test-offer-three",
  ] as [string, string, string],
};

describe("renderOutreach", () => {
  it("renders the spec fake lead safely", async () => {
    const out = await renderOutreach(FAKE);
    expect(out.subject).toBe(FAKE.aiSubject);
    // Header and footer exist.
    expect(out.stepHtml).toContain("Warmbly Outreach");
    expect(out.stepHtml).toContain("Best regards");
    // Greeting + variable in position, AI text only escaped in snapshot.
    expect(out.stepHtml).toContain("Hi {{.FirstName}},");
    expect(out.stepHtml).toContain("{{.ai_body}}");
    expect(out.stepHtml).not.toContain("four clicks");
    expect(out.snapshot).toContain("four clicks");
    // Exactly three offer URLs, byte-identical, no AI-generated URL.
    for (const url of FAKE.offers) expect(out.stepHtml).toContain(url);
    expect(out.stepHtml).not.toMatch(/https?:\/\/[^\s"']*ai-/i);
    // No raw AI HTML, no sentinels, no unexpected placeholders.
    expect(out.stepHtml).not.toContain("__WARMBLY_");
    expect(out.stepHtml.match(/\{\{[^}]*\}\}/g)?.sort()).toEqual(["{{.FirstName}}", "{{.ai_body}}"]);
    expect(out.stepHtml).not.toMatch(/<script|<iframe|javascript:/i);
    expect(out.stepHtml.length).toBeLessThan(100_000);
  });

  it("rejects CRLF subjects and escapes hostile bodies", async () => {
    await expect(renderOutreach({ ...FAKE, aiSubject: "a\r\nb" })).rejects.toBeInstanceOf(RenderError);
    const out = await renderOutreach({ ...FAKE, aiBodyText: '<script>alert(1)</script> Hi <b>there</b>' });
    expect(out.snapshot).not.toContain("<script>");
    expect(out.snapshot).toContain("&lt;script&gt;");
    expect(out.stepHtml).not.toContain("<script>");
  });

  it("renders exactly the offers given, never empty buttons", async () => {
    const one = await renderOutreach({ ...FAKE, offers: ["https://example.com/only"] });
    expect(one.stepHtml).toContain("https://example.com/only");
    expect(one.stepHtml).not.toMatch(/href\s*=\s*""/);
    expect(one.stepHtml).not.toContain("Offer 2");
    await expect(renderOutreach({ ...FAKE, offers: [] })).rejects.toBeInstanceOf(RenderError);
  });
});

// Brevo parses {{...}} as its own template tags and aborts the send, so
// provider-bound HTML must carry no step variables at all.
describe("resolveDirectHtml", () => {
  it("resolves both step variables from real rendered output", async () => {
    const rendered = await renderOutreach({ ...FAKE, offers: ["https://example.com/only"] });
    const html = resolveDirectHtml(rendered.stepHtml, FAKE.aiBodyText);
    expect(html).not.toContain("{{");
    expect(html).toContain("Hi there,");
    expect(html).toContain("four clicks");
    expect(html).toContain("https://example.com/only");
  });

  it("escapes AI text instead of passing it through as markup", () => {
    const html = resolveDirectHtml("<p>Hi {{.FirstName}},</p><p>{{.ai_body}}</p>", "<b>bold</b>");
    expect(html).not.toContain("{{");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });
});

// Combined v2 shell: Shodasha header, insight headline, proof chips, labeled
// exits, fixed sender signature. Stored step HTML keeps both Go variables for
// the Warmbly path; resolveDirectHtml strips them for providers.
describe("renderOutreach v2", () => {
  it("renders the header card, headline, default labels, and footer card", async () => {
    const out = await renderOutreach(
      { ...FAKE, businessName: "Smile Dental", offers: ["https://example.com/a", "https://example.com/b"] },
      { template: "v2" },
    );
    expect(out.stepHtml).toContain("Shodasha");
    expect(out.stepHtml).toContain("From scratch to a brand.");
    expect(out.stepHtml).toContain("https://ik.imagekit.io/shodasha/shodasha-cms/shodasha-logo_MxOa6iz9H.png");
    expect(out.stepHtml).toContain("https://shodasha.vercel.app/");
    expect(out.stepHtml).toContain("api.dicebear.com");
    expect(out.stepHtml).toContain(FAKE.aiSubject);
    expect(out.stepHtml).toContain("Smile Dental");
    expect(out.stepHtml).toContain("See how it works");
    expect(out.stepHtml).toContain("Get my free review");
    expect(out.stepHtml).toContain("AADITYA THAKUR");
    expect(out.stepHtml).toContain("CEO");
    expect(out.stepHtml).toContain("Hi {{.FirstName}},");
    expect(out.stepHtml).not.toContain("purple");
    expect(out.stepHtml).not.toContain("indigo");
    const direct = resolveDirectHtml(out.stepHtml, FAKE.aiBodyText);
    expect(direct).not.toContain("{{");
    expect(direct).toContain("Hi there,");
  });

  it("honors explicit offer labels and renders one button per URL", async () => {
    const out = await renderOutreach(
      {
        ...FAKE,
        offers: [
          { url: "https://example.com/a", label: "Claim your audit" },
          { url: "https://example.com/b", label: "See the proof" },
          { url: "https://example.com/c", label: "Reply yes" },
        ],
      },
      { template: "v2" },
    );
    for (const label of ["Claim your audit", "See the proof", "Reply yes"]) expect(out.stepHtml).toContain(label);
    expect(out.stepHtml).not.toContain("Offer 1");
  });

  it("rejects bad label lengths and keeps v1 the default", async () => {
    await expect(
      renderOutreach({ ...FAKE, offers: [{ url: "https://example.com/a", label: "" }] }, { template: "v2" }),
    ).rejects.toBeInstanceOf(RenderError);
    const v1 = await renderOutreach({ ...FAKE });
    expect(v1.stepHtml).toContain("Warmbly Outreach");
    expect(templateFor("1")).toBe("v1");
    expect(templateFor("2")).toBe("v2");
    expect(templateFor("3")).toBe("v3");
    expect(templateFor(null)).toBe("v1");
  });
});

// Newest shell (v3): welcome skeleton — open logo header, body card, big
// footer card. V1 and V2 stay pinned by their own tests above.
describe("renderOutreach v3", () => {
  it("renders the logo header, body card, and big footer", async () => {
    const out = await renderOutreach(
      { ...FAKE, businessName: "Smile Dental", offers: ["https://example.com/a", "https://example.com/b"] },
      { template: "v3" },
    );
    expect(out.stepHtml).toContain("https://ik.imagekit.io/shodasha/shodasha-cms/shodasha-logo_MxOa6iz9H.png");
    expect(out.stepHtml).toContain("From scratch to a brand.");
    expect(out.stepHtml).toContain("https://api.dicebear.com/10.x/adventurer/png");
    expect(out.stepHtml).toContain("AADITYA THAKUR");
    expect(out.stepHtml).toContain("CEO,");
    expect(out.stepHtml).toContain("Visit our company website");
    expect(out.stepHtml).toContain("https://shodasha.vercel.app/");
    expect(out.stepHtml).toContain(FAKE.aiSubject);
    expect(out.stepHtml).toContain("See how it works");
    expect(out.stepHtml).toContain("Hi {{.FirstName}},");
    expect(out.stepHtml).not.toContain("purple");
    expect(out.stepHtml).not.toContain("indigo");
    const direct = resolveDirectHtml(out.stepHtml, FAKE.aiBodyText);
    expect(direct).not.toContain("{{");
    expect(direct).toContain("Hi there,");
  });
});
