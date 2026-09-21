import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single authoritative prompt source. Task prompts carry only research data:
// offer URLs, API keys, and credentials can never reach this layer because
// the builder input types have no fields for them.
const dir = dirname(fileURLToPath(import.meta.url));

function load(name: string): string {
  return readFileSync(join(dir, `${name}.md`), "utf8");
}

const ORDER = ["agent-system", "discovery", "research", "personalization"] as const;

export function loadPrompt(name: (typeof ORDER)[number]): string {
  return load(name);
}

// Version pinned per run so results are traceable to exact instructions.
export function promptVersion(): string {
  const hash = createHash("sha1");
  for (const name of ORDER) hash.update(load(name));
  return hash.digest("hex").slice(0, 12);
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export interface DiscoveryPromptArgs {
  businessType: string;
  location: string;
  customInstructions: string;
  lane: { id: string; label: string; guidance: string };
  maxLeads: number;
  promptVersion: string;
}

export function buildDiscoveryPrompt(args: DiscoveryPromptArgs): { system: string; text: string } {
  return {
    system: load("agent-system"),
    text: fill(load("discovery"), {
      business_type: args.businessType,
      location: args.location,
      custom_instructions: args.customInstructions || "none",
      lane_id: args.lane.id,
      lane_label: args.lane.label,
      lane_guidance: args.lane.guidance,
      max_leads: String(args.maxLeads),
    }),
  };
}

export interface ResearchPromptArgs {
  businessName: string;
  website: string;
  location: string;
  businessType: string;
  maxSummaryChars: number;
}

export function buildResearchPrompt(args: ResearchPromptArgs): { system: string; text: string } {
  return {
    system: load("agent-system"),
    text: fill(load("research"), {
      business_name: args.businessName,
      website: args.website,
      location: args.location,
      business_type: args.businessType,
      max_summary_chars: String(args.maxSummaryChars),
    }),
  };
}

export interface PersonalizePromptArgs {
  businessName: string;
  website: string;
  location: string;
  businessType: string;
  researchSummary: string;
  painPoints: string;
  facts: string;
  customInstructions: string;
  maxSubjectChars: number;
  maxBodyChars: number;
}

export function buildPersonalizePrompt(args: PersonalizePromptArgs): { system: string; text: string } {
  return {
    system: load("agent-system"),
    text: fill(load("personalization"), {
      business_name: args.businessName,
      website: args.website,
      location: args.location,
      business_type: args.businessType,
      research_summary: args.researchSummary,
      pain_points: args.painPoints,
      facts: args.facts,
      custom_instructions: args.customInstructions || "none",
      max_subject_chars: String(args.maxSubjectChars),
      max_body_chars: String(args.maxBodyChars),
    }),
  };
}

export function newCorrelationId(): string {
  return randomUUID();
}
