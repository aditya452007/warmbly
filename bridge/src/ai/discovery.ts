import { z } from "zod";
import type { AgentRuntime } from "./types.js";
import { LeadSchema } from "../domain/validate.js";
import { buildDiscoveryPrompt } from "../prompts/index.js";
import { BridgeError } from "./factory.js";

export interface Lane {
  id: string;
  label: string;
  guidance: string;
}

export const DEFAULT_LANES: Lane[] = [
  {
    id: "maps-local",
    label: "Google Maps / local business discovery",
    guidance:
      "Search map listings and local packs for the trade and area (try several map-query phrasings). Open each listing, then scrape the linked official website for contact details. Treat aggregator data as hints only.",
  },
  {
    id: "organic-search",
    label: "Organic web search",
    guidance:
      "Use varied natural search phrasings for the service and city; prefer official business sites over aggregators. Fetch candidate sites and extract published contact details verbatim.",
  },
  {
    id: "directories",
    label: "Business directories and registries",
    guidance:
      "Mine reputable local directories, review listings, and industry registries for the trade and area. Cross-check every candidate against its own official site before keeping it; drop stale or mismatched entries.",
  },
  {
    id: "query-variations",
    label: "Query variations",
    guidance:
      "Rephrase the service with synonyms, neighboring areas, and long-tail queries (e.g. 'family-run', 'near <landmark>'). Keep only businesses that still match the target trade and place after verification.",
  },
];

export interface LeadDiscoveryProvider {
  discover(ctx: DiscoveryCtx): Promise<LeadWire[]>;
}

// Research-only context. Deliberately no offer URLs, keys, or tokens;
// prompts carry only this task data.
export interface DiscoveryCtx {
  businessType: string;
  location: string;
  customInstructions: string;
  lane: Lane;
  maxLeads: number;
  promptVersion: string;
}

// Validated wire shape (snake_case, exactly what the schema accepted). The
// orchestrator maps this to the camelCase domain RawLead on persistence.
export type LeadWire = z.infer<typeof LeadSchema>;

const DEFAULT_DISCOVERY_TIMEOUT_MS = 120_000;

export class OpenCodeDiscoveryProvider implements LeadDiscoveryProvider {
  private readonly runtime: AgentRuntime;
  private readonly timeoutMs: number;
  private readonly model?: { providerID: string; modelID: string };

  constructor(runtime: AgentRuntime, opts?: { timeoutMs?: number; model?: { providerID: string; modelID: string } }) {
    this.runtime = runtime;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.model = opts?.model;
  }

  async discover(ctx: DiscoveryCtx): Promise<LeadWire[]> {
    const built = buildDiscoveryPrompt({
      businessType: ctx.businessType,
      location: ctx.location,
      customInstructions: ctx.customInstructions,
      lane: ctx.lane,
      maxLeads: ctx.maxLeads,
      promptVersion: ctx.promptVersion,
    });
    const arraySchema = z.array(LeadSchema).min(1);
    const result = await this.runtime.executeStructured(
      {
        systemPrompt: built.system,
        prompt: built.text,
        timeoutMs: this.timeoutMs,
        title: `discovery:${ctx.lane.id}`,
        ...(this.model ? { model: this.model } : {}),
      },
      arraySchema,
    );
    if (!result.ok || result.data === undefined) {
      const code = result.error?.code ?? "ai_unknown";
      throw new BridgeError(`lead discovery failed: ${code}`, code);
    }
    return result.data;
  }
}
