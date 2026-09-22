import { describe, it, expect } from "vitest";
import { z } from "zod";
import { OpenCodeAiProvider, type SessionClientLike } from "./opencodeProvider.js";

const SECRET_PROMPT = "research-seed-xyz-never-in-errors";

function textReply(text: string, sessionId = "s1"): unknown {
  return {
    data: {
      info: {},
      parts: [{ type: "text", text }],
    },
  };
}

function makeClient(impl: {
  create?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  prompt?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  abort?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}): { client: SessionClientLike; calls: { create: number; prompt: number; abort: number; bodies: unknown[] } } {
  const calls = { create: 0, prompt: 0, abort: 0, bodies: [] as unknown[] };
  const client: SessionClientLike = {
    session: {
      create: async (args) => {
        calls.create += 1;
        if (impl.create) return impl.create(args);
        return { data: { id: "s1" } };
      },
      prompt: async (args) => {
        calls.prompt += 1;
        calls.bodies.push(args);
        if (impl.prompt) return impl.prompt(args);
        return textReply('{"ok":true}');
      },
      abort: async (args) => {
        calls.abort += 1;
        if (impl.abort) return impl.abort(args);
        return { data: true };
      },
    },
  };
  return { client, calls };
}

describe("OpenCodeAiProvider", () => {
  it("success path returns structured data", async () => {
    const schema = z.object({ hello: z.string() });
    const { client } = makeClient({
      prompt: () => textReply('{"hello":"world"}'),
    });
    const provider = new OpenCodeAiProvider({ timeoutMs: 2000 }, () => client);
    const res = await provider.executeStructured(
      { systemPrompt: "sys", prompt: SECRET_PROMPT, timeoutMs: 2000, title: "t" },
      schema,
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ hello: "world" });
    expect(res.sessionId).toBe("s1");
    await provider.close();
  });

  it("invalid-then-repair retries once with validation errors", async () => {    const schema = z.object({ n: z.number() });
    let n = 0;
    const { client, calls } = makeClient({
      prompt: () => {
        n += 1;
        if (n === 1) return textReply('{"n":"not-a-number"}');
        return textReply('{"n":42}');
      },
    });
    const provider = new OpenCodeAiProvider({ timeoutMs: 2000 }, () => client);
    const res = await provider.executeStructured(
      { systemPrompt: "sys", prompt: SECRET_PROMPT, timeoutMs: 2000 },
      schema,
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ n: 42 });
    expect(calls.prompt).toBe(2);
    // Repair message carries validation detail, never the original prompt.
    const repairBody = calls.bodies[1] as { body?: { parts?: Array<{ text?: string }> } };
    const repairText = repairBody.body?.parts?.[0]?.text ?? "";
    expect(repairText.toLowerCase()).toContain("validation");
    expect(repairText).not.toContain(SECRET_PROMPT);
    await provider.close();
  });

  it("timeout calls abort and maps ai_timeout without prompt text", async () => {
    const { client, calls } = makeClient({
      prompt: () => new Promise<unknown>(() => undefined),
    });
    const provider = new OpenCodeAiProvider({ timeoutMs: 1000 }, () => client);
    const res = await provider.executeText({ systemPrompt: "sys", prompt: SECRET_PROMPT, timeoutMs: 50 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ai_timeout");
    expect(calls.abort).toBeGreaterThanOrEqual(1);
    expect(res.error?.message ?? "").not.toContain(SECRET_PROMPT);
    await provider.close();
  });

  it("connect failure maps ai_unavailable without prompt text", async () => {
    const { client } = makeClient({
      create: () => {
        throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
      },
    });
    const provider = new OpenCodeAiProvider({ timeoutMs: 1000 }, () => client);
    const res = await provider.executeText({ systemPrompt: "sys", prompt: SECRET_PROMPT, timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ai_unavailable");
    expect(res.error?.message ?? "").not.toContain(SECRET_PROMPT);
    await provider.close();
  });
});

describe("OpenCodeAiProvider real transport", () => {
  it("closed port maps ai_unavailable through the real SDK client", async () => {
    const provider = new OpenCodeAiProvider({ baseUrl: "http://127.0.0.1:9", timeoutMs: 3000 });
    const res = await provider.executeText({ systemPrompt: "sys", prompt: "hi", timeoutMs: 3000 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ai_unavailable");
    await provider.close();
  });
});

describe("OpenCodeAiProvider plain-JSON structured output", () => {
  it("never sends the broken server format field; empty reply then repair succeeds", async () => {
    const schema = z.object({ hello: z.string() });
    let n = 0;
    const { client, calls } = makeClient({
      prompt: () => {
        n += 1;
        if (n === 1) return textReply("\n\n");
        return textReply('{"hello":"world"}');
      },
    });
    const provider = new OpenCodeAiProvider({ timeoutMs: 2000 }, () => client);
    const res = await provider.executeStructured(
      { systemPrompt: "sys", prompt: SECRET_PROMPT, timeoutMs: 2000 },
      schema,
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ hello: "world" });
    expect(calls.prompt).toBe(2);
    // Neither attempt carries a format field; the first orders JSON-only.
    for (const sent of calls.bodies) {
      const body = (sent as { body?: { format?: unknown; parts?: Array<{ text?: string }> } }).body;
      expect(body?.format).toBeUndefined();
    }
    const first = (calls.bodies[0] as { body?: { parts?: Array<{ text?: string }> } }).body?.parts?.[0]?.text ?? "";
    expect(first).toContain("ONLY");
    await provider.close();
  });
});
