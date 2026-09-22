import { render } from "react-email";
import { escapeHtml, OutreachSchema } from "../domain/validate.js";
import { AI_BODY_VAR, BODY_SENTINEL, OutreachTemplate } from "./template.js";

export const OUTREACH_TEMPLATE_NAME = "warmbly-outreach";
export const OUTREACH_TEMPLATE_VERSION = "1";
export const MAX_RENDERED_HTML_CHARS = 100_000;

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderInput {
  aiSubject: string;
  aiBodyText: string;
  offers: string[];
}

export interface RenderedOutreach {
  subject: string;
  // Campaign-step HTML: fixed shell + {{.ai_body}} variable + fixed offers.
  stepHtml: string;
  // Audit snapshot: stepHtml plus the escaped AI text in a comment.
  snapshot: string;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function assertSafe(html: string, offers: string[]): void {
  if (/__WARMBLY_[A-Z_]+__/.test(html)) {
    throw new RenderError("unresolved sentinel remains");
  }
  const unexpected = html
    .match(/\{\{[^}]*\}\}/g)
    ?.filter((m) => m !== AI_BODY_VAR && m !== "{{.FirstName}}");
  if (unexpected && unexpected.length > 0) {
    throw new RenderError(`unexpected placeholder: ${unexpected[0]}`);
  }
  // Event handlers need a delimiter before "on" so <meta content=...> is not
  // flagged while onclick=... still is.
  if (/(<script|<iframe|<style|javascript:|data:text\/html|(?:^|[\s"'</])on\w+\s*=)/i.test(html)) {
    throw new RenderError("unsafe markup detected");
  }
  for (const url of offers) {
    if (countOccurrences(html, url) < 1) {
      throw new RenderError("offer URL altered or missing");
    }
  }
  // No dead buttons: every rendered link carries a real destination.
  if (/href\s*=\s*""/.test(html)) {
    throw new RenderError("empty link target rendered");
  }
  if (html.length > MAX_RENDERED_HTML_CHARS) {
    throw new RenderError("rendered email exceeds size cap");
  }
}

// The template always renders with the sentinel; AI plain text is HTML-escaped
// before it goes anywhere near HTML. React Email owns all markup: AI text can
// never become markup, and offer URLs travel verbatim from configuration.
export async function renderOutreach(input: RenderInput): Promise<RenderedOutreach> {
  const parsed = OutreachSchema.safeParse({ subject: input.aiSubject, body: input.aiBodyText });
  if (!parsed.success) {
    throw new RenderError(`invalid AI copy: ${parsed.error.issues[0]?.message ?? "rejected"}`);
  }
  if (input.offers.length < 1 || input.offers.length > 3) {
    throw new RenderError("one to three offer URLs are required");
  }
  const html = await render(OutreachTemplate({ offers: input.offers }));
  if (countOccurrences(html, BODY_SENTINEL) !== 1) {
    throw new RenderError("body sentinel must occur exactly once");
  }
  const escaped = escapeHtml(parsed.data.body);
  const stepHtml = html.split(BODY_SENTINEL).join(AI_BODY_VAR);
  const snapshot = html.split(BODY_SENTINEL).join(`${AI_BODY_VAR}<!--${escaped}-->`);
  assertSafe(stepHtml, input.offers);
  assertSafe(snapshot, input.offers);
  return { subject: parsed.data.subject, stepHtml, snapshot };
}
