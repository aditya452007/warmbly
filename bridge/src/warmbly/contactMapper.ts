import type { AddContact } from "./client.js";

// Lead -> Warmbly contact mapping. Standard fields carry identity; everything
// AI-specific rides flat string custom fields (Warmbly custom fields are
// string-only). Research documents stay in the local DB, never in Warmbly.
export interface MappableLead {
  businessName: string;
  email: string;
  phone: string | null;
  website: string | null;
}

export interface MappableResearch {
  summary: string;
  painPoints: string[];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mapLeadToContact(
  lead: MappableLead,
  research: MappableResearch,
  location: string,
  agentId: string,
): AddContact {
  return {
    first_name: "",
    last_name: "",
    email: lead.email,
    company: lead.businessName,
    // Scraped cold leads have given no marketing consent. Warmbly defaults
    // omitted subscribed to true (internal/models/contact.go), which would
    // mark non-consented prospects emailable, so opt them out explicitly.
    // The sending phase must decide consent handling before mailing them.
    subscribed: false,
    ...(lead.phone ? { phone: lead.phone } : {}),
    custom_fields: {
      website: lead.website ?? "",
      location,
      research_summary_short: truncate(research.summary, 200),
      pain_1: truncate(research.painPoints[0] ?? "", 200),
      pain_2: truncate(research.painPoints[1] ?? "", 200),
      agent_id: agentId,
      ai_status: "qualified",
    },
  };
}

// Per-contact personalization variables for the campaign step shell.
// ai_body is HTML-escaped here because Warmbly substitutes it raw.
export function mapOutreachToCustomFields(subject: string, bodyText: string): Record<string, string> {
  return { ai_subject: subject, ai_body: esc(bodyText) };
}
