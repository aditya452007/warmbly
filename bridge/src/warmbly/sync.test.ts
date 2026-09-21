import { describe, expect, it, vi } from "vitest";
import { mapLeadToContact, mapOutreachToCustomFields } from "./contactMapper.js";
import { ContactSyncBuffer } from "./sync.js";
import type { WarmblyClient } from "./client.js";

describe("contactMapper", () => {
  it("maps to flat string fields with truncation", () => {
    const c = mapLeadToContact(
      { businessName: "Smile Dental", email: "hi@smile.example", phone: null, website: "https://smile.example" },
      { summary: "s".repeat(500), painPoints: ["p1".repeat(200), "p2"] },
      "California",
      "agent-1",
    );
    expect(c.company).toBe("Smile Dental");
    expect(typeof c.custom_fields?.research_summary_short).toBe("string");
    expect(c.custom_fields?.research_summary_short.length).toBeLessThanOrEqual(200);
    expect(c.custom_fields?.ai_status).toBe("qualified");
    expect(c.custom_fields?.agent_id).toBe("agent-1");
  });

  it("escapes outreach body for template substitution", () => {
    const vars = mapOutreachToCustomFields("Hi", "<b>x</b> & y");
    expect(vars.ai_body).toBe("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});

describe("ContactSyncBuffer", () => {
  it("flushes by batch size with stable keys", async () => {
    const created = [{ id: "c1" }, { id: "c2" }];
    const client = { createContactsBulk: vi.fn(async () => created) } as unknown as WarmblyClient;
    const marks: string[] = [];
    const recorder = {
      markSynced: (leadId: string, contactId: string) => void marks.push(`${leadId}=${contactId}`),
      markSyncFailed: () => undefined,
    };
    const buf = new ContactSyncBuffer(client, "run1", recorder, { batchSize: 2 });
    buf.add("l1", { first_name: "", last_name: "", email: "a@x.com" });
    buf.add("l2", { first_name: "", last_name: "", email: "b@x.com" });
    await buf.close();
    expect(client.createContactsBulk).toHaveBeenCalledTimes(1);
    expect(marks).toEqual(["l1=c1", "l2=c2"]);
  });

  it("resolves ambiguous failure via lookup then update", async () => {
    const client = {
      createContactsBulk: vi.fn(async () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      }),
      lookupContactByEmail: vi.fn(async () => ({ id: "existing" })),
      updateContact: vi.fn(async () => undefined),
    } as unknown as WarmblyClient;
    const synced: string[] = [];
    const recorder = {
      markSynced: (leadId: string, contactId: string) => void synced.push(`${leadId}=${contactId}`),
      markSyncFailed: () => undefined,
    };
    const buf = new ContactSyncBuffer(client, "run1", recorder, { batchSize: 10 });
    buf.add("l1", { first_name: "", last_name: "", email: "a@x.com", custom_fields: { website: "w" } });
    await buf.close();
    expect(client.lookupContactByEmail).toHaveBeenCalledWith("a@x.com");
    expect(client.updateContact).toHaveBeenCalled();
    expect(synced).toEqual(["l1=existing"]);
  });
});
