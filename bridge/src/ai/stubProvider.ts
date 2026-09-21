import type { ZodType } from "zod";
import type { AgentRuntime, ExecOpts } from "./types.js";
import type { AiTaskResult } from "../domain/types.js";

export type StubScriptEntry =
  | { match: (prompt: string) => boolean; result: unknown }
  | { match?: (prompt: string) => boolean; error: { code: string; message: string } };

function isErrorEntry(entry: StubScriptEntry): entry is { match?: (prompt: string) => boolean; error: { code: string; message: string } } {
  return "error" in entry;
}

const PROMPT_VERSION = "test";

// Scripted AgentRuntime for tests and dev dry-runs. Each execution pops
// the first matching scripted entry; error entries always match.
export class StubAiProvider implements AgentRuntime {
  readonly name = "stub";
  private readonly script: StubScriptEntry[];
  private counter = 0;

  constructor(script: StubScriptEntry[]) {
    this.script = [...script];
  }

  get remaining(): number {
    return this.script.length;
  }

  async executeText(opts: ExecOpts): Promise<AiTaskResult<string>> {
    const started = Date.now();
    const sessionId = `stub-${++this.counter}`;
    const entry = this.pop(opts.prompt);
    if (!entry) {
      return {
        ok: false,
        error: { code: "ai_unknown", message: `ai_unknown (promptLen=${opts.prompt.length}, replyLen=0)` },
        sessionId,
        durationMs: Date.now() - started,
        promptVersion: PROMPT_VERSION,
      };
    }
    if (isErrorEntry(entry)) {
      return {
        ok: false,
        error: entry.error,
        sessionId,
        durationMs: Date.now() - started,
        promptVersion: PROMPT_VERSION,
      };
    }
    const data = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result);
    return { ok: true, data, sessionId, durationMs: Date.now() - started, promptVersion: PROMPT_VERSION };
  }

  async executeStructured<T>(opts: ExecOpts, schema: ZodType<T>): Promise<AiTaskResult<T>> {
    const started = Date.now();
    const sessionId = `stub-${++this.counter}`;
    const entry = this.pop(opts.prompt);
    if (!entry) {
      return {
        ok: false,
        error: { code: "ai_unknown", message: `ai_unknown (promptLen=${opts.prompt.length}, replyLen=0)` },
        sessionId,
        durationMs: Date.now() - started,
        promptVersion: PROMPT_VERSION,
      };
    }
    if (isErrorEntry(entry)) {
      return {
        ok: false,
        error: entry.error,
        sessionId,
        durationMs: Date.now() - started,
        promptVersion: PROMPT_VERSION,
      };
    }
    const direct = schema.safeParse(entry.result);
    if (direct.success) {
      return { ok: true, data: direct.data, sessionId, durationMs: Date.now() - started, promptVersion: PROMPT_VERSION };
    }
    if (typeof entry.result === "string") {
      try {
        const parsed = JSON.parse(entry.result) as unknown;
        const second = schema.safeParse(parsed);
        if (second.success) {
          return {
            ok: true,
            data: second.data,
            sessionId,
            durationMs: Date.now() - started,
            promptVersion: PROMPT_VERSION,
          };
        }
      } catch {
        // Fall through to ai_invalid below.
      }
    }
    return {
      ok: false,
      error: { code: "ai_invalid", message: `ai_invalid (promptLen=${opts.prompt.length}, replyLen=0)` },
      sessionId,
      durationMs: Date.now() - started,
      promptVersion: PROMPT_VERSION,
    };
  }

  async abort(_sessionId: string): Promise<void> {
    // No-op: stubbed executions resolve immediately.
  }

  async close(): Promise<void> {
    // No-op: nothing externally owned.
  }

  private pop(prompt: string): StubScriptEntry | undefined {
    // Error entries without a matcher are wildcards (always match); entries
    // with a matcher only match their own prompts so parallel workers can be
    // scripted deterministically.
    const idx = this.script.findIndex((entry) =>
      isErrorEntry(entry) ? !entry.match || entry.match(prompt) : entry.match(prompt),
    );
    if (idx < 0) return undefined;
    const [entry] = this.script.splice(idx, 1);
    return entry;
  }
}
