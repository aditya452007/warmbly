import type { AddContact, WarmblyClient } from "./client.js";
import { classify, WarmblyApiError } from "./errors.js";

// Batched contact sync with idempotent resume. A crash between the POST and
// the local state update is resolved by email lookup + update instead of a
// blind re-create (Warmbly upserts by email anyway).
export interface SyncRecorder {
  markSynced(leadId: string, contactId: string): void;
  markSyncFailed(leadId: string, error: string, retryable: boolean): void;
}

export interface SyncBufferOptions {
  batchSize?: number;
  flushIntervalMs?: number;
}

export class ContactSyncBuffer {
  private readonly client: WarmblyClient;
  private readonly runId: string;
  private readonly batchSize: number;
  private readonly recorder: SyncRecorder;
  private queue: Array<{ leadId: string; contact: AddContact }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchSeq = 0;

  constructor(client: WarmblyClient, runId: string, recorder: SyncRecorder, opts?: SyncBufferOptions) {
    this.client = client;
    this.runId = runId;
    this.recorder = recorder;
    this.batchSize = opts?.batchSize ?? 25;
    if (opts?.flushIntervalMs && opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush().catch(() => undefined), opts.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  add(leadId: string, contact: AddContact): void {
    this.queue.push({ leadId, contact });
    if (this.queue.length >= this.batchSize) {
      void this.flush().catch(() => undefined);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const key = `${this.runId}:contacts:${this.batchSeq++}`;
    try {
      const created = await this.client.createContactsBulk(
        batch.map((b) => b.contact),
        key,
      );
      batch.forEach((item, i) => {
        const hit = created[i];
        if (hit) this.recorder.markSynced(item.leadId, hit.id);
        else this.recorder.markSyncFailed(item.leadId, "bulk response short", true);
      });
    } catch (err) {
      if (err instanceof WarmblyApiError && classify(err.status, err.code) !== "retryable") {
        for (const item of batch) this.recorder.markSyncFailed(item.leadId, err.message, false);
        return;
      }
      // Ambiguous outcome (timeout/network/429/5xx after send): resolve each
      // lead by email lookup, then update in place. Never blindly re-create.
      for (const item of batch) {
        try {
          const found = await this.client.lookupContactByEmail(item.contact.email);
          if (found) {
            if (item.contact.custom_fields) {
              await this.client.updateContact(found.id, { custom_fields: item.contact.custom_fields });
            }
            this.recorder.markSynced(item.leadId, found.id);
          } else {
            const created = await this.client.createContactsBulk([item.contact], `${key}:${item.leadId}`);
            if (created[0]) this.recorder.markSynced(item.leadId, created[0].id);
            else this.recorder.markSyncFailed(item.leadId, "bulk response short", true);
          }
        } catch (inner) {
          const msg = inner instanceof Error ? inner.message : "sync failed";
          const retryable = !(inner instanceof WarmblyApiError) || classify(inner.status, inner.code) === "retryable";
          this.recorder.markSyncFailed(item.leadId, msg, retryable);
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
