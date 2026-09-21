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
      "Prioritize map listings and local packs for the area; prefer businesses showing a street address and recent local reviews.",
  },
  {
    id: "organic-search",
    label: "Organic web search",
    guidance:
      "Use varied natural search phrasings for the service and city; prefer official business sites over aggregators.",
  },
  {
    id: "directories",
    label: "Business directories",
    guidance:
      "Mine reputable local directories and review listings; cross-check each name against its own site before keeping it.",
  },
  {
    id: "query-variations",
    label: "Query variations",
    guidance:
      "Rephrase the service with synonyms and neighboring areas; keep only businesses that still match the target trade and place.",
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

  constructor(runtime: AgentRuntime, opts?: { timeoutMs?: number }) {
    this.runtime = runtime;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
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
