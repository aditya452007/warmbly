import { z } from "zod";

// Runtime validation for every external boundary: run requests, AI output,
// Warmbly payloads, URLs, and AI copy. TypeScript types are not trusted at
// runtime; these schemas are.

const httpUrl = z
  .string()
  .refine((s) => /^https?:\/\/.+/i.test(s), { message: "must be an http(s) URL" });

export const RunRequestSchema = z.object({
  warmblyCampaignId: z.string().min(1),
  businessType: z.string().trim().min(1),
  location: z.string().trim().min(1),
  customInstructions: z.string().default(""),
  offerUrls: z.array(httpUrl).min(1).max(3),
  parallelAgents: z.number().int().min(1).max(16).default(4),
  targetLeads: z.number().int().positive(),
});

const LeadWireSchema = z
  .object({
    business_name: z.string().trim().min(1),
    website: httpUrl.nullish(),
    email: z.string().trim().email().nullish(),
    phone: z.string().trim().min(1).nullish(),
    address: z.string().trim().min(1).nullish(),
    city: z.string().trim().min(1).nullish(),
    country: z.string().trim().min(1).nullish(),
    // Models often emit the singular form despite the prompt; accept both
    // and canonicalize to the array. At least one source URL is required.
    source_url: httpUrl.nullish(),
    source_urls: z.array(httpUrl).nullish(),
    confidence: z.number().min(0).max(1).default(0),
  })
  .refine((v) => (v.source_urls?.length ?? 0) > 0 || !!v.source_url, {
    message: "a source URL is required",
  })
  .transform((v) => ({
    business_name: v.business_name,
    website: v.website ?? null,
    email: v.email ?? null,
    phone: v.phone ?? null,
    address: v.address ?? null,
    city: v.city ?? null,
    country: v.country ?? null,
    source_urls: v.source_urls?.length ? v.source_urls : [v.source_url as string],
    confidence: v.confidence,
  }));

export const LeadSchema = LeadWireSchema;

export const ResearchSchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    // Models emit plain strings or {pain_point, evidence} objects; both are
    // accepted and normalized to strings.
    pain_points: z
      .array(z.union([z.string(), z.object({ pain_point: z.string() }).passthrough()]))
      .max(10)
      .default([]),
    // Facts arrive as {claim, source_url} or {fact, source_url}; both are
    // accepted and normalized to {claim, sourceUrl}.
    facts: z
      .array(
        z
          .object({
            claim: z.string().trim().min(1).nullish(),
            fact: z.string().trim().min(1).nullish(),
            source_url: httpUrl.nullish(),
            source: httpUrl.nullish(),
          })
          .passthrough(),
      )
      .max(20)
      .default([]),
  })
  .transform((v) => ({
    summary: v.summary,
    pain_points: v.pain_points
      .map((p) => (typeof p === "string" ? p.trim() : p.pain_point.trim()))
      .filter((p) => p.length > 0)
      .slice(0, 10),
    facts: v.facts
      .map((f) => ({ claim: (f.claim ?? f.fact ?? "").trim(), sourceUrl: f.source_url ?? f.source ?? "" }))
      .filter((f) => f.claim.length > 0 && f.sourceUrl.length > 0)
      .slice(0, 20),
  }));

const NO_CRLF = /[\r\n]/;
// Unambiguous Markdown constructs. Plain prose with dashes, asterisks in
// normal writing ("5-star", "$99 teeth-cleaning") must keep passing; only
// link/image syntax, ATX headers, and bold/italic spans are rejected.
const MARKDOWN = /(^|\n)#{1,6}\s|\[.+?\]\(.+?\)|!\[[^\]]*\]\(.+?\)|\*\*.+?\*\*|__.+?__/;

export const OutreachSchema = z.object({
  subject: z.string().trim().min(1).max(120).refine((s) => !NO_CRLF.test(s), {
    message: "subject must be a single line",
  }),
  body: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine((s) => !MARKDOWN.test(s), { message: "body must be plain text, no Markdown" }),
});

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/.+/i.test(s);
}

// Canonical business identity host: lowercase, no leading www., no port,
// no path. Null when the input is not a parseable http(s) URL.
export function normalizeDomain(websiteOrDomain: string | null | undefined): string | null {
  if (!websiteOrDomain) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(websiteOrDomain)
    ? websiteOrDomain
    : `https://${websiteOrDomain}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    if (!host || host === "localhost") return null;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const clean = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : null;
}

// Per-run dedupe identity: domain wins, email is the fallback.
export function leadIdentity(domain: string | null, email: string | null): string {
  if (domain) return `domain:${domain}`;
  if (email) return `email:${email}`;
  throw new Error("lead needs a website domain or an email for identity");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strip anything credential-shaped before it can reach a log, an error, or
// (by construction) a prompt.
export function redactSecrets(s: string): string {
  return s
    .replace(/wmbly_[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/(password\s*=\s*)([^\s;,]+)/gi, "$1[REDACTED]");
}
