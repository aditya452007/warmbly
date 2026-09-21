import { z } from "zod";
import { classify, WarmblyApiError } from "./errors.js";

// Deliberately narrow client: contacts (bulk/search/lookup/update) plus
// campaign read and draft step preparation. Start/stop/send methods MUST NOT
// be added here; this phase never sends email.
export interface WarmblyClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
  fetchFn?: typeof fetch;
}

const ContactSchema = z.object({ id: z.string() }).passthrough();
const CampaignSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    kind: z.string(),
    daily_limit: z.number().nullable().optional(),
  })
  .passthrough();
const StepSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    body_html: z.string().nullable().optional(),
  })
  .passthrough();

export interface AddContact {
  first_name: string;
  last_name: string;
  email: string;
  company?: string;
  phone?: string;
  custom_fields?: Record<string, string>;
  subscribed?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WarmblyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: WarmblyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.maxAttempts = Math.max(1, opts.maxAttempts);
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private scrub(message: string): string {
    return message.replace(/wmbly_[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]");
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: "Bearer [REDACTED]",
          "Content-Type": "application/json",
        };
        const realHeaders: Record<string, string> = {
          ...headers,
          Authorization: `Bearer ${this.apiKey}`,
        };
        if (idempotencyKey) realHeaders["Idempotency-Key"] = idempotencyKey;
        const res = await this.fetchFn(`${this.baseUrl}/v1${path}`, {
          method,
          headers: realHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          if (attempt < this.maxAttempts) {
            await sleep(waitMs);
            continue;
          }
        }
        const text = await res.text();
        let parsed: { error?: string; message?: string; code?: string; request_id?: string } = {};
        try {
          parsed = text ? (JSON.parse(text) as typeof parsed) : {};
        } catch {
          parsed = { message: text.slice(0, 500) };
        }
        if (!res.ok) {
          throw new WarmblyApiError(
            res.status,
            parsed.code ?? "unknown",
            this.scrub(parsed.message ?? parsed.error ?? `request failed with ${res.status}`),
            parsed.request_id,
          );
        }
        return (text ? JSON.parse(text) : null) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof WarmblyApiError) {
          if (classify(err.status, err.code) === "retryable" && attempt < this.maxAttempts) {
            await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
            continue;
          }
          throw err;
        }
        // Network failure or timeout (status 0): retryable.
        if (attempt < this.maxAttempts) {
          await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
          continue;
        }
        throw new WarmblyApiError(0, "network", this.scrub(err instanceof Error ? err.message : "network failure"));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new WarmblyApiError(0, "network", "request failed without response");
  }

  async getCampaign(id: string): Promise<z.infer<typeof CampaignSchema>> {
    const data = await this.request<unknown>("GET", `/campaigns/${id}`);
    return CampaignSchema.parse(data);
  }

  // Unauthenticated liveness probe against the backend root (not /v1).
  async ping(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000));
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async listSteps(campaignId: string): Promise<Array<z.infer<typeof StepSchema>>> {
    const data = await this.request<unknown>("GET", `/campaigns/${campaignId}/steps`);
    return z.array(StepSchema).parse(data);
  }

  async createStep(campaignId: string): Promise<z.infer<typeof StepSchema>> {
    const data = await this.request<unknown>("POST", `/campaigns/${campaignId}/steps`);
    return StepSchema.parse(data);
  }

  async updateStep(campaignId: string, stepId: string, patch: { subject: string; bodyHtml: string }): Promise<void> {
    await this.request("PATCH", `/campaigns/${campaignId}/steps/${stepId}`, {
      subject: patch.subject,
      body_html: patch.bodyHtml,
    });
  }

  async lookupContactByEmail(email: string): Promise<{ id: string } | null> {
    const data = await this.request<unknown>("GET", `/contacts/lookup?email=${encodeURIComponent(email)}`);
    const parsed = z.object({ contact: ContactSchema.nullable() }).parse(data);
    return parsed.contact ? { id: parsed.contact.id } : null;
  }

  async getContact(id: string): Promise<{ id: string; custom_fields: Record<string, string> }> {
    const data = await this.request<unknown>("GET", `/contacts/${id}`);
    const parsed = z
      .object({ id: z.string(), custom_fields: z.record(z.string(), z.string()).optional() })
      .passthrough()
      .parse(data);
    return { id: parsed.id, custom_fields: parsed.custom_fields ?? {} };
  }

  async searchContacts(query: string, limit = 20): Promise<Array<{ id: string }>> {
    const data = await this.request<unknown>("POST", `/contacts/search?limit=${limit}`, { query });
    const parsed = z.object({ data: z.array(ContactSchema) }).parse(data);
    return parsed.data.map((c) => ({ id: c.id }));
  }

  async createContactsBulk(contacts: AddContact[], idempotencyKey?: string): Promise<Array<{ id: string }>> {
    const out: Array<{ id: string }> = [];
    for (let i = 0; i < contacts.length; i += 500) {
      const chunk = contacts.slice(i, i + 500);
      const key = idempotencyKey ? `${idempotencyKey}:chunk${i / 500}` : undefined;
      const data = await this.request<unknown>("POST", "/contacts", chunk, key);
      const parsed = z.array(ContactSchema).parse(data);
      out.push(...parsed.map((c) => ({ id: c.id })));
    }
    return out;
  }

  async updateContact(id: string, patch: { custom_fields?: Record<string, string>; company?: string }): Promise<void> {
    await this.request("PATCH", `/contacts/${id}`, patch);
  }
}
