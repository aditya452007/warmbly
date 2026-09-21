import { describe, it, expect, beforeEach } from "vitest";
import {
  registerProvider,
  createAiProvider,
  clearProvidersForTests,
  BridgeError,
} from "./factory.js";
import { StubAiProvider } from "./stubProvider.js";

beforeEach(() => {
  clearProvidersForTests();
});

describe("ai provider registry", () => {
  it("throws unknown AI provider and lists registered names", () => {
    registerProvider("alpha", () => new StubAiProvider([]));
    registerProvider("beta", () => new StubAiProvider([]));
    let caught: unknown;
    try {
      createAiProvider("nope", { timeoutMs: 1000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    const message = (caught as Error).message;
    expect(message).toMatch(/unknown AI provider/);
    expect(message).toContain("alpha");
    expect(message).toContain("beta");
    expect(message).toContain("nope");
  });

  it("creates a stub provider registered as stub", async () => {
    registerProvider("stub", () => new StubAiProvider([{ match: () => true, result: "hi" }]));
    const runtime = createAiProvider("stub", { timeoutMs: 1000 });
    expect(runtime.name).toBe("stub");
    const res = await runtime.executeText({
      systemPrompt: "sys",
      prompt: "hello",
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(true);
    expect(res.data).toBe("hi");
  });
});
