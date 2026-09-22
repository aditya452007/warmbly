import { describe, expect, it } from "vitest";
import { renderOutreach, RenderError } from "./render.js";

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
