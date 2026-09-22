import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import type { AgentRuntime, ExecOpts } from "./types.js";
import type { ProviderDeps } from "./factory.js";
import type { AiTaskResult } from "../domain/types.js";

// Minimal surface used from the SDK client. Kept structural so tests can
// inject a mock { session: { create, prompt, abort } } via clientFactory.
export interface SessionClientLike {
  session: {
    create(args: Record<string, unknown>): Promise<unknown>;
    prompt(args: Record<string, unknown>): Promise<unknown>;
    abort(args: Record<string, unknown>): Promise<unknown>;
  };
}

export type OpencodeClientFactory = (deps: ProviderDeps) => SessionClientLike;

type AiErrorCode =
  | "ai_unavailable"
  | "ai_auth"
  | "ai_timeout"
  | "ai_invalid"
  | "ai_aborted"
  | "ai_unknown";

const PROMPT_VERSION = "1";

function unwrapData(raw: unknown): { data: unknown; error: unknown } {
  if (raw !== null && typeof raw === "object" && ("data" in raw || "error" in raw)) {
    const r = raw as { data?: unknown; error?: unknown };
    return { data: r.data, error: r.error };
  }
  return { data: raw, error: undefined };
}

function describeTransportError(err: unknown): { code: AiErrorCode; hint: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lowered = msg.toLowerCase();
  const code = (err as { code?: unknown }).code;
  const status = (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  if (
    code === "AI_TIMEOUT" ||
    lowered.includes("ai timeout") ||
    (err instanceof DOMException && err.name === "AbortError")
  ) {
    return { code: "ai_timeout", hint: lowered.slice(0, 160) };
  }
  if (status === 401 || status === 403 || lowered.includes("unauthorized") || lowered.includes("forbidden")) {
    // 401/403 from the server; never echo bodies.
    return { code: "ai_auth", hint: lowered.slice(0, 160) };
  }
  if (
    lowered.includes("econnrefused") ||
    lowered.includes("enotfound") ||
    lowered.includes("eai_again") ||
    lowered.includes("fetch failed") ||
    lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("load failed") ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return { code: "ai_unavailable", hint: lowered.slice(0, 160) };
  }
  return { code: "ai_unknown", hint: lowered.slice(0, 160) };
}

function lastTextPart(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as { type?: unknown; text?: unknown };
    if (p !== null && typeof p === "object" && p.type === "text" && typeof p.text === "string") {
      return p.text;
    }
  }
  return undefined;
}

function extractJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("empty reply");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to fence/substring recovery.
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fall through.
    }
  }
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace >= 0) {
    const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (lastBrace > firstBrace) {
      const slice = trimmed.slice(firstBrace, lastBrace + 1);
      return JSON.parse(slice);
    }
  }
  // Re-throw the original shape: caller maps to ai_invalid with lengths only.
  return JSON.parse(trimmed);
}

function timeoutError(): Error {
  return Object.assign(new Error("AI timeout"), { code: "AI_TIMEOUT" });
}

export class OpenCodeAiProvider implements AgentRuntime {
  readonly name = "opencode";
  private readonly client: SessionClientLike;
  private readonly defaultTimeoutMs: number;
  private readonly aborted = new Set<string>();

  constructor(deps: ProviderDeps, clientFactory?: OpencodeClientFactory) {
    this.defaultTimeoutMs = deps.timeoutMs;
    if (clientFactory) {
      this.client = clientFactory(deps);
    } else {
      const baseUrl = deps.baseUrl ?? "http://127.0.0.1:4096";
      // Self-hosted `opencode serve` instances require HTTP basic auth when
      // OPENCODE_SERVER_PASSWORD is set. The SDK accepts a custom fetch, so
      // credentials ride the transport and never enter prompts or logs.
      const username = deps.username ?? "";
      const password = deps.password ?? "";
      const authedFetch =
        username || password
          ? (async (...args: Parameters<typeof fetch>): Promise<Response> => {
              const [url, init] = args;
              const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
              headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
              return fetch(url, { ...init, headers });
            })
          : undefined;
      this.client = createOpencodeClient({ baseUrl, ...(authedFetch ? { fetch: authedFetch } : {}) }) as unknown as SessionClientLike;
    }
  }

  async executeText(opts: ExecOpts): Promise<AiTaskResult<string>> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = started + timeoutMs;
    let sessionId = "unknown";
    const controller = new AbortController();
    let timedOut = false;
    const onExpire = (): void => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // Ignore abort errors; the race below surfaces ai_timeout.
      }
      if (sessionId !== "unknown") {
        this.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      }
    };

    try {
      const created = await this.withDeadline(deadline, onExpire, () =>
        this.client.session.create({
          body: { title: opts.title ?? "bridge-task" },
          signal: controller.signal,
        }),
      );
      const { data: sessionData, error: createError } = unwrapData(created);
      if (createError !== undefined) {
        return this.fail<string>(mapServerError(createError, opts), sessionId, started);
      }
      sessionId = (sessionData as { id?: string }).id ?? "unknown";
      if (this.aborted.has(sessionId)) {
        return this.fail<string>("ai_aborted", sessionId, started, opts, 0);
      }
      const body: Record<string, unknown> = {
        system: opts.systemPrompt,
        parts: [{ type: "text", text: opts.prompt }],
      };
      if (opts.model) body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };
      const replied = await this.withDeadline(deadline, onExpire, () =>
        this.client.session.prompt({
          path: { id: sessionId },
          body,
          signal: controller.signal,
        }),
      );
      const { data: replyData, error: promptError } = unwrapData(replied);
      if (promptError !== undefined) {
        return this.fail<string>(mapServerError(promptError, opts), sessionId, started);
      }
      const reply = replyData as { info?: unknown; parts?: unknown };
      const text = lastTextPart(reply?.parts);
      if (typeof text !== "string") {
        return this.fail<string>("ai_unknown", sessionId, started, opts, 0);
      }
      return {
        ok: true,
        data: text,
        sessionId,
        durationMs: Date.now() - started,
        promptVersion: PROMPT_VERSION,
      };
    } catch (err) {
      if (timedOut || isAbortError(err)) {
        if (this.aborted.has(sessionId)) {
          return this.fail<string>("ai_aborted", sessionId, started, opts, 0);
        }
        return this.fail<string>("ai_timeout", sessionId, started, opts, 0);
      }
      return this.fail<string>(describeTransportError(err).code, sessionId, started, opts, 0);
    }
  }

  async executeStructured<T>(opts: ExecOpts, schema: z.ZodType<T>): Promise<AiTaskResult<T>> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = started + timeoutMs;
    let sessionId = "unknown";
    const controller = new AbortController();
    let timedOut = false;
    const onExpire = (): void => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // Ignore abort errors; the race below surfaces ai_timeout.
      }
      if (sessionId !== "unknown") {
        this.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      }
    };

    try {
      const created = await this.withDeadline(deadline, onExpire, () =>
        this.client.session.create({
          body: { title: opts.title ?? "bridge-task" },
          signal: controller.signal,
        }),
      );
      const { data: sessionData, error: createError } = unwrapData(created);
      if (createError !== undefined) {
        return this.fail<T>(mapServerError(createError, opts), sessionId, started);
      }
      sessionId = (sessionData as { id?: string }).id ?? "unknown";
      if (this.aborted.has(sessionId)) {
        return this.fail<T>("ai_aborted", sessionId, started, opts, 0);
      }
      const jsonOrder = "Reply with ONLY the requested JSON. No prose, no fences, no commentary.";
      const body: Record<string, unknown> = {
        system: opts.systemPrompt,
        // NOTE: no `format: json_schema` is sent. OpenCode 1.18.26 stores the
        // format on the user message but then fails to read that session back
        // (GET messages 400s on its own retryCount default) and the model
        // answers constrained decoding with an empty reply. A direct JSON-only
        // instruction returns exact JSON, validated below with one repair.
        parts: [{ type: "text", text: `${opts.prompt}\n\n${jsonOrder}` }],
      };
      const first = await this.withDeadline(deadline, onExpire, () =>
        this.client.session.prompt({
          path: { id: sessionId },
          body,
          signal: controller.signal,
        }),
      );
      const attempt = this.readStructured(first, schema);
      if (attempt.ok) {
        return {
          ok: true,
          data: attempt.value as T,
          sessionId,
          durationMs: Date.now() - started,
          promptVersion: PROMPT_VERSION,
        };
      }
      // ONE repair retry: send validation errors back in-session.
      const repairText =
        `Your previous reply failed schema validation. ` +
        `Issues: ${summarizeIssues(attempt.issues)}. ` +
        `Reply with corrected JSON only, matching the requested schema.`;
      const retryBody: Record<string, unknown> = {
        parts: [{ type: "text", text: repairText }],
      };
      if (opts.model) retryBody.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };
      const second = await this.withDeadline(deadline, onExpire, () =>
        this.client.session.prompt({
          path: { id: sessionId },
          body: retryBody,
          signal: controller.signal,
        }),
      );
      const reattempt = this.readStructured(second, schema);
      if (reattempt.ok) {
        return {
          ok: true,
          data: reattempt.value as T,
          sessionId,
          durationMs: Date.now() - started,
          promptVersion: PROMPT_VERSION,
        };
      }
      const replyLen = lastReplyLength(second);
      return this.fail<T>("ai_invalid", sessionId, started, opts, replyLen);
    } catch (err) {
      if (timedOut || isAbortError(err)) {
        if (this.aborted.has(sessionId)) {
          return this.fail<T>("ai_aborted", sessionId, started, opts, 0);
        }
        return this.fail<T>("ai_timeout", sessionId, started, opts, 0);
      }
      return this.fail<T>(describeTransportError(err).code, sessionId, started, opts, 0);
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.add(sessionId);
    try {
      await this.client.session.abort({ path: { id: sessionId } });
    } catch {
      // Abort is best-effort; in-flight calls map to ai_aborted via the set.
    }
  }

  async close(): Promise<void> {
    // Server is externally owned; nothing to shut down.
  }

  private readStructured<T>(
    raw: unknown,
    schema: z.ZodType<T>,
  ): { ok: true; value: T } | { ok: false; issues: string } {
    const { data: replyData, error: promptError } = unwrapData(raw);
    if (promptError !== undefined) {
      throw promptError;
    }
    const reply = replyData as { info?: Record<string, unknown>; parts?: unknown };
    const structured = reply?.info?.["structured_output"];
    if (structured !== undefined) {
      const parsed = schema.safeParse(structured);
      if (parsed.success) return { ok: true, value: parsed.data };
      return { ok: false, issues: summarizeIssues(formatZodIssues(parsed.error.issues)) };
    }
    const text = lastTextPart(reply?.parts);
    if (typeof text !== "string") {
      return { ok: false, issues: "empty reply" };
    }
    let candidate: unknown;
    try {
      candidate = extractJsonCandidate(text);
    } catch {
      return { ok: false, issues: `unparseable JSON (replyLen=${text.length})` };
    }
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { ok: true, value: parsed.data };
    return { ok: false, issues: summarizeIssues(formatZodIssues(parsed.error.issues)) };
  }

  private async withDeadline<T>(deadline: number, onExpire: () => void, fn: () => Promise<T>): Promise<T> {
    const remaining = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onExpire();
        reject(timeoutError());
      }, remaining);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private fail<T>(
    code: AiErrorCode,
    sessionId: string,
    started: number,
    opts?: ExecOpts,
    replyLen = 0,
  ): AiTaskResult<T> {
    const promptLen = opts ? opts.prompt.length : 0;
    return {
      ok: false,
      error: { code, message: `${code} (promptLen=${promptLen}, replyLen=${replyLen})` },
      sessionId,
      durationMs: Date.now() - started,
      promptVersion: PROMPT_VERSION,
    };
  }
}

function mapServerError(err: unknown, opts: ExecOpts): AiErrorCode {
  void opts;
  if (err !== null && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const status = record.status ?? record.statusCode;
    if (status === 401 || status === 403) return "ai_auth";
    const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
    const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
    const dataMessage =
      record.data !== null && typeof record.data === "object"
        ? String((record.data as Record<string, unknown>).message ?? "").toLowerCase()
        : "";
    const joined = `${name} ${message} ${dataMessage}`;
    if (joined.includes("unauthorized") || joined.includes("forbidden") || joined.includes("auth")) {
      return "ai_auth";
    }
    if (joined.includes("fetch failed") || joined.includes("econnrefused") || joined.includes("enotfound")) {
      return "ai_unavailable";
    }
  }
  return describeTransportError(err).code;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  const code = (err as { code?: unknown }).code;
  return code === "ABORT_ERR" || code === 20;
}

function formatZodIssues(issues: Array<{ path: Array<PropertyKey>; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

function summarizeIssues(issues: string): string {
  return issues.length > 500 ? `${issues.slice(0, 500)}…` : issues;
}

function lastReplyLength(raw: unknown): number {
  const { data } = unwrapData(raw);
  const reply = data as { parts?: unknown };
  const text = lastTextPart(reply?.parts);
  return typeof text === "string" ? text.length : 0;
}
