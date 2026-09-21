import type { AgentRuntime } from "./types.js";

// Dependencies handed to a provider constructor. Timeouts only;
// secrets never travel inside prompts (see agent-system policy).
export interface ProviderDeps {
  baseUrl?: string;
  username?: string;
  password?: string;
  timeoutMs: number;
}

export type ProviderCtor = (deps: ProviderDeps) => AgentRuntime;

export class BridgeError extends Error {
  code: string;
  constructor(message: string, code = "bridge_error") {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

const registry = new Map<string, ProviderCtor>();

export function registerProvider(name: string, ctor: ProviderCtor): void {
  registry.set(name, ctor);
}

export function listProviders(): string[] {
  return [...registry.keys()].sort();
}

// Test-only reset so suites stay isolated when run in one worker.
export function clearProvidersForTests(): void {
  registry.clear();
}

export function createAiProvider(name: string, deps: ProviderDeps): AgentRuntime {
  const ctor = registry.get(name);
  if (!ctor) {
    const names = listProviders();
    const listing = names.length > 0 ? names.join(", ") : "none";
    throw new BridgeError(`unknown AI provider "${name}" (available: ${listing})`, "unknown_ai_provider");
  }
  return ctor(deps);
}
