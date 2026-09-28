import { render } from "react-email";
import { escapeHtml, OutreachSchema } from "../domain/validate.js";
import {
  AI_BODY_VAR,
  BODY_SENTINEL,
  FIRST_NAME_VAR,
  OFFER_SLOT_LABELS,
  OutreachTemplate,
  OutreachTemplateV2,
  OutreachTemplateV3,
  type OfferLink,
} from "./template.js";

export const OUTREACH_TEMPLATE_NAME = "warmbly-outreach";
export const OUTREACH_TEMPLATE_VERSION = "1";
export const OUTREACH_TEMPLATE_V2_VERSION = "2";
export const OUTREACH_TEMPLATE_V3_VERSION = "3";

export type OutreachTemplateId = "v1" | "v2" | "v3";

// Stored template versions select the renderer: unknown or v1 rows keep the
// original shell so approved bytes never shift under review.
export function templateFor(stored?: string | null): OutreachTemplateId {
  if (stored === OUTREACH_TEMPLATE_V3_VERSION) return "v3";
  return stored === OUTREACH_TEMPLATE_V2_VERSION ? "v2" : "v1";
}
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
  offers: Array<string | OfferLink>;
  businessName?: string;
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

// Provider-bound HTML: bridge-direct relays (Brevo) parse {{...}} as their
// own template tags and abort the send, so Go-style step variables must never
// leave the bridge. Warmbly campaign steps keep stepHtml verbatim; only mail
// handed to a provider is resolved here. The bridge stores no per-lead first
// name, so the greeting falls back to a neutral "there".
export function resolveDirectHtml(stepHtml: string, body: string): string {
  return stepHtml.split(AI_BODY_VAR).join(escapeHtml(body)).split(FIRST_NAME_VAR).join("there");
}

// The template always renders with the sentinel; AI plain text is HTML-escaped
// before it goes anywhere near HTML. React Email owns all markup: AI text can
// never become markup, and offer URLs travel verbatim from configuration.
export async function renderOutreach(input: RenderInput, opts?: { template?: OutreachTemplateId }): Promise<RenderedOutreach> {
  const parsed = OutreachSchema.safeParse({ subject: input.aiSubject, body: input.aiBodyText });
  if (!parsed.success) {
    throw new RenderError(`invalid AI copy: ${parsed.error.issues[0]?.message ?? "rejected"}`);
  }
  const links = normalizeOffers(input.offers);
  const urls = links.map((l) => l.url);
  const template = opts?.template ?? "v1";
  const v3Props = {
    headline: parsed.data.subject,
    preview: parsed.data.body.slice(0, 100),
    businessName: input.businessName,
    offers: links,
  };
  const html =
    template === "v3"
      ? await render(OutreachTemplateV3(v3Props))
      : template === "v2"
        ? await render(
            OutreachTemplateV2({
              headline: parsed.data.subject,
              preview: parsed.data.body.slice(0, 100),
              businessName: input.businessName,
              offers: links,
            }),
          )
        : await render(OutreachTemplate({ offers: urls }));
  if (countOccurrences(html, BODY_SENTINEL) !== 1) {
    throw new RenderError("body sentinel must occur exactly once");
  }
  const escaped = escapeHtml(parsed.data.body);
  const stepHtml = html.split(BODY_SENTINEL).join(AI_BODY_VAR);
  const snapshot = html.split(BODY_SENTINEL).join(`${AI_BODY_VAR}<!--${escaped}-->`);
  assertSafe(stepHtml, urls);
  assertSafe(snapshot, urls);
  return { subject: parsed.data.subject, stepHtml, snapshot };
}

// Offer labels travel with the run configuration like URLs do; bare URLs
// fall back to the fixed psychology-framed slot labels. Labels are capped so
// one long string cannot break the button layout.
function normalizeOffers(offers: RenderInput["offers"]): OfferLink[] {
  if (offers.length < 1 || offers.length > 3) {
    throw new RenderError("one to three offer URLs are required");
  }
  return offers.map((offer, i) => {
    if (typeof offer === "string") return { url: offer, label: OFFER_SLOT_LABELS[i] ?? `Offer ${i + 1}` };
    const label = offer.label.trim();
    if (!label || label.length > 40) throw new RenderError("offer label must be 1-40 characters");
    return { url: offer.url, label };
  });
}
