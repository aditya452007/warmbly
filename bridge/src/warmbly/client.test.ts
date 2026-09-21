import { describe, expect, it, vi } from "vitest";
import { WarmblyClient, type AddContact } from "./client.js";
import { classify, WarmblyApiError } from "./errors.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function makeClient(calls: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = calls[Math.min(i++, calls.length - 1)];
    return jsonResponse(next.status, next.body, next.headers) as unknown as Response;
  });
  const client = new WarmblyClient({
    baseUrl: "http://localhost:8080",
    apiKey: "wmbly_testkey12345678",
    timeoutMs: 2000,
    maxAttempts: 3,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, seen, fetchFn };
}

const contact = (email: string): AddContact => ({ first_name: "", last_name: "", email, company: "Acme" });

describe("WarmblyClient", () => {
  it("posts bulk arrays with idempotency key", async () => {
    const { client, seen } = makeClient([{ status: 200, body: [{ id: "c1" }, { id: "c2" }] }]);
    const out = await client.createContactsBulk([contact("a@x.com"), contact("b@x.com")], "run:contacts:0");
    expect(out).toEqual([{ id: "c1" }, { id: "c2" }]);
    const init = seen[0].init;
    expect(seen[0].url).toBe("http://localhost:8080/v1/contacts");
    expect(JSON.parse(init.body as string)).toHaveLength(2);
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("run:contacts:0:chunk0");
  });

  it("retries 429 honoring Retry-After then succeeds", async () => {
    const { client, fetchFn } = makeClient([
      { status: 429, body: { error: "x", message: "slow", code: "rate_limit_exceeded" }, headers: { "Retry-After": "0" } },
      { status: 200, body: [{ id: "c1" }] },
    ]);
    const out = await client.createContactsBulk([contact("a@x.com")]);
    expect(out).toEqual([{ id: "c1" }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws classified errors without retrying 401, and redacts the key", async () => {
    const { client, fetchFn } = makeClient([{ status: 401, body: { error: "x", message: "bad", code: "unauthorized" } }]);
    const err = await client.createContactsBulk([contact("a@x.com")]).catch((e) => e);
    expect(err).toBeInstanceOf(WarmblyApiError);
    expect(classify(err.status, err.code)).toBe("config");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(err.message)).not.toContain("wmbly_testkey");
  });

  it("classifies 409 conflict and 400 permanent", () => {
    expect(classify(409, "contact_email_taken")).toBe("conflict");
    expect(classify(400, "x")).toBe("permanent");
    expect(classify(500, "x")).toBe("retryable");
  });

  it("lookup returns null on miss envelope", async () => {
    const { client } = makeClient([{ status: 200, body: { contact: null } }]);
    expect(await client.lookupContactByEmail("nobody@x.com")).toBe(null);
  });
});
