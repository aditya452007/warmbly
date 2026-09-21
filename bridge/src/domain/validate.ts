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

export const LeadSchema = z.object({
  business_name: z.string().trim().min(1),
  website: httpUrl.nullish(),
  email: z.string().trim().email().nullish(),
  phone: z.string().trim().min(1).nullish(),
  address: z.string().trim().min(1).nullish(),
  city: z.string().trim().min(1).nullish(),
  country: z.string().trim().min(1).nullish(),
  source_urls: z.array(httpUrl).min(1),
  confidence: z.number().min(0).max(1).default(0),
});

export const ResearchSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  pain_points: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  facts: z
    .array(z.object({ claim: z.string().trim().min(1), source_url: httpUrl }))
    .max(20)
    .default([]),
});

const NO_CRLF = /[\r\n]/;

export const OutreachSchema = z.object({
  subject: z.string().trim().min(1).max(120).refine((s) => !NO_CRLF.test(s), {
    message: "subject must be a single line",
  }),
  body: z.string().trim().min(1).max(4000),
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
