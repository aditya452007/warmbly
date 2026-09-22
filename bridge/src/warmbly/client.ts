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

  async updateStep(
    campaignId: string,
    stepId: string,
    patch: { subject: string; bodyHtml: string; name?: string },
  ): Promise<void> {
    await this.request("PATCH", `/campaigns/${campaignId}/steps/${stepId}`, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      subject: patch.subject,
      body_html: patch.bodyHtml,
    });
  }

  async lookupContactByEmail(email: string): Promise<{ id: string } | null> {
    const data = await this.request<unknown>("GET", `/contacts/lookup?email=${encodeURIComponent(email)}`);
    const parsed = z.object({ contact: ContactSchema.nullable() }).parse(data);
    return parsed.contact ? { id: parsed.contact.id } : null;
  }

  async getContact(id: string): Promise<{ id: string; email: string; subscribed: boolean; custom_fields: Record<string, string> }> {
    const data = await this.request<unknown>("GET", `/contacts/${id}`);
    const parsed = z
      .object({
        id: z.string(),
        email: z.string().optional(),
        subscribed: z.boolean().optional(),
        custom_fields: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .parse(data);
    return { id: parsed.id, email: parsed.email ?? "", subscribed: parsed.subscribed ?? false, custom_fields: parsed.custom_fields ?? {} };
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

  // Sending mailboxes. Returns id/email/status rows; the caller picks
  // deterministically and lets Warmbly's own send validation be authoritative.
  async listAccounts(): Promise<Array<{ id: string; email: string; status: string }>> {
    const data = await this.request<unknown>("GET", "/emails");
    const parsed = z
      .object({ data: z.array(z.object({ id: z.string(), email: z.string(), status: z.string().optional() }).passthrough()) })
      .parse(data);
    return parsed.data.map((a) => ({ id: a.id, email: a.email, status: a.status ?? "" }));
  }

  // Warmbly-native single send: renders a campaign step (optionally for a
  // real contact) and mails it through an org mailbox. Never starts or
  // enrolls anything; tracking is off and the subject carries [TEST] by
  // Warmbly's design.
  async sendTestEmail(args: {
    campaignId: string;
    accountId: string;
    recipient: string;
    stepId?: string;
    contactId?: string;
  }): Promise<{ recipient: string; subject: string; step_id: string }> {
    const data = await this.request<unknown>("POST", `/campaigns/${args.campaignId}/test-email`, {
      account_id: args.accountId,
      recipient: args.recipient,
      ...(args.stepId ? { step_id: args.stepId } : {}),
      ...(args.contactId ? { contact_id: args.contactId } : {}),
    });
    const parsed = z.object({ recipient: z.string(), subject: z.string(), step_id: z.string() }).passthrough().parse(data);
    return { recipient: parsed.recipient, subject: parsed.subject, step_id: parsed.step_id };
  }

  // Workspace suppression list lookup for one address. Any hit blocks
  // sending; misses never fail closed here (a failed lookup is reported by
  // the caller as its own error class).
  async isSuppressed(email: string): Promise<boolean> {
    const data = await this.request<unknown>(`GET`, `/suppressions?q=${encodeURIComponent(email)}&limit=10`);
    const parsed = z
      .object({ data: z.array(z.object({ email: z.string().optional() }).passthrough()).optional() })
      .passthrough()
      .parse(data);
    const rows = parsed.data ?? [];
    const needle = email.trim().toLowerCase();
    const domain = needle.split("@")[1] ?? "";
    return rows.some((r) => {
      const entry = (r.email ?? "").trim().toLowerCase();
      if (!entry) return false;
      if (!entry.includes("@")) return domain !== "" && (domain === entry || domain.endsWith(`.${entry}`));
      return entry === needle;
    });
  }

  // Reply sync reads. The bridge key needs READ_UNIBOX; without it these
  // throw and the poller treats the source as unavailable (retryable, never
  // fabricated). Replies only exist here when the reply mailbox is connected
  // to Warmbly; otherwise there is nothing to poll.
  async searchUniboxThreads(args: { address: string; direction?: string; since?: string; limit?: number }): Promise<UniboxThreadPreview[]> {
    const q = new URLSearchParams({ address: args.address, limit: String(args.limit ?? 25) });
    if (args.direction) q.set("direction", args.direction);
    if (args.since) q.set("since", args.since);
    const data = await this.request<unknown>("GET", `/unibox?${q.toString()}`);
    const parsed = z
      .object({ data: z.array(UniboxThreadPreviewSchema).optional() })
      .passthrough()
      .parse(data);
    return parsed.data ?? [];
  }

  async getUniboxThread(threadId: string): Promise<UniboxThreadMessage[]> {
    const data = await this.request<unknown>("GET", `/unibox/thread?thread_id=${encodeURIComponent(threadId)}`);
    const parsed = z
      .object({ data: z.array(UniboxThreadMessageSchema).optional() })
      .passthrough()
      .parse(data);
    return parsed.data ?? [];
  }
}

const UniboxThreadPreviewSchema = z
  .object({
    id: z.string().optional(),
    thread_id: z.string(),
    from_addr: z.array(z.string()).optional(),
    to_addr: z.array(z.string()).optional(),
    subject: z.string().optional(),
    snippet: z.string().optional(),
    internal_date: z.string().optional(),
    message_count: z.number().optional(),
  })
  .passthrough();

export interface UniboxThreadPreview extends z.infer<typeof UniboxThreadPreviewSchema> {}

const UniboxThreadMessageSchema = z
  .object({
    id: z.string(),
    thread_id: z.string().optional(),
    from_addr: z.array(z.string()).optional(),
    to_addr: z.array(z.string()).optional(),
    subject: z.string().optional(),
    snippet: z.string().optional(),
    body_text: z.string().optional(),
    message_id: z.string().optional(),
    in_reply_to: z.array(z.string()).optional(),
    internal_date: z.string().optional(),
  })
  .passthrough();

export interface UniboxThreadMessage extends z.infer<typeof UniboxThreadMessageSchema> {}
