import type { ZodType } from "zod";
import type { AiTaskResult } from "../domain/types.js";

// Options for a single isolated agent execution. Carries only research
// task data: never API keys, offer URLs, or Warmbly credentials.
export interface ExecOpts {
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  title?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

// Minimal agent runtime over an externally owned OpenCode server.
export interface AgentRuntime {
  name: string;
  executeText(opts: ExecOpts): Promise<AiTaskResult<string>>;
  executeStructured<T>(opts: ExecOpts, schema: ZodType<T>): Promise<AiTaskResult<T>>;
  abort(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
