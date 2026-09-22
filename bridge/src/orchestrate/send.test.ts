import { describe, expect, it, vi } from "vitest";
import { openBridgeDb, closeDb } from "../db.js";
import { AgentRuns, CampaignRuns, DiscoveryJobs, Drafts, Events, Leads, Research, Sends } from "../store/repositories.js";
import { WarmblyClient } from "../warmbly/client.js";
import { BridgeOrchestrator } from "./orchestrator.js";
import type { BridgeConfig } from "../config.js";
import type { EmailMessage, EmailTransport } from "../email/transport/types.js";
import { SmtpError } from "../email/transport/types.js";

const OFFERS = ["https://example.com/offer-one"];

function mockWarmbly(overrides: Record<string, unknown> = {}) {
  const testEmailCalls: unknown[] = [];
  const client = {
    listAccounts: async () => [{ id: "a1", email: "mailbox@example.com", status: "active" }],
    listSteps: async () => [{ id: "s1", name: "AI Outreach" }],
    sendTestEmail: async (args: unknown) => {
      testEmailCalls.push(args);
      return { recipient: "t@example.org", subject: "[TEST] Hi", step_id: "s1" };
    },
    lookupContactByEmail: async () => ({ id: "c1" }),
    getContact: async () => ({ id: "c1", email: "lead@example.com", subscribed: false, custom_fields: {} }),
    updateContact: async () => undefined,
    isSuppressed: async () => false,
    ...overrides,
  } as unknown as WarmblyClient;
  return { client, testEmailCalls };
}

function mockTransport(impl: Partial<EmailTransport> = {}) {
  const sent: EmailMessage[] = [];
  const transport = {
    name: "brevo",
    verify: async () => undefined,
    send: async (message: EmailMessage) => {
      sent.push(message);
      return { messageId: "mock-msg-1" };
    },
    close: async () => undefined,
    defaultFrom: () => ({ email: "hello@example.com", name: "Bridge" }),
    ...impl,
  } as unknown as EmailTransport & { sent: EmailMessage[] };
  (transport as { sent: EmailMessage[] }).sent = sent;
  return transport;
}

function setup(mode: "disabled" | "local" | "live", transport?: EmailTransport | null, warmblyOverrides: Record<string, unknown> = {}) {
  const db = openBridgeDb(":memory:");
  const mock = mockWarmbly(warmblyOverrides);
  const config = {
    SEND_MODE: mode,
    EMAIL_PROVIDER: "brevo",
    AI_JOB_TIMEOUT_MS: 5000,
    AI_RETRY_ATTEMPTS: 0,
    OPENCODE_MODEL: "",
  } as BridgeConfig;
  const orchestrator = new BridgeOrchestrator({
    config,
    runs: new CampaignRuns(db),
    agents: new AgentRuns(db),
    jobs: new DiscoveryJobs(db),
    leads: new Leads(db),
    research: new Research(db),
    drafts: new Drafts(db),
    events: new Events(db),
    sends: new Sends(db),
    warmbly: mock.client,
    createRuntime: () => {
      throw new Error("AI must not run during send");
    },
    getEmailTransport: () => transport ?? null,
  });
  new CampaignRuns(db).create({
    id: "run-1",
    warmblyCampaignId: "camp-1",
    businessType: "Plumbers",
    location: "Austin",
    customInstructions: "",
    offerUrls: OFFERS,
    parallelAgents: 1,
    targetLeads: 5,
  });
  new Leads(db).insert({
    id: "lead-1",
    campaignRunId: "run-1",
    identity: "domain:shop.example",
    businessName: "Shop",
    website: "https://shop.example",
    email: "lead@example.com",
    sourceUrls: ["https://maps.example/s"],
    status: "QUALIFIED",
  });
  new Drafts(db).upsert({
    id: "draft-1",
    leadId: "lead-1",
    subject: "Hello Shop",
    body: "Concrete body text here.",
    templateName: "warmbly-outreach",
    templateVersion: "1",
    renderedHtml: "<p>x</p>",
    offerSnapshot: OFFERS,
    status: "APPROVED",
  });
  return { db, mock, orchestrator };
}

describe("send gates", () => {
  it("refuses disabled mode, non-approved drafts, and bad input", async () => {
    const env = setup("disabled", mockTransport());
    try {
      await expect(env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org" })).rejects.toThrow(/disabled/);
    } finally {
      closeDb(env.db);
    }
    const env2 = setup("live", mockTransport());
    try {
      const drafts = new Drafts(env2.db);
      drafts.setStatus("draft-1", "NEEDS_REVIEW");
      await expect(env2.orchestrator.sendDraft("draft-1", { recipient: "t@example.org" })).rejects.toThrow(/only approved/);
      await expect(env2.orchestrator.sendDraft("nope", { recipient: "t@example.org" })).rejects.toThrow(/draft not found/);
      drafts.setStatus("draft-1", "APPROVED");
      await expect(env2.orchestrator.sendDraft("draft-1", { recipient: "not-an-email" })).rejects.toThrow(/recipient/);
    } finally {
      closeDb(env2.db);
    }
  });

  it("blocks suppressed recipients without retry", async () => {
    const env = setup("live", mockTransport(), { isSuppressed: async () => true });
    try {
      await expect(
        env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true }),
      ).rejects.toThrow(/suppression/);
      const sends = new Sends(env.db);
      expect(sends.listByDraft("draft-1")).toHaveLength(0);
    } finally {
      closeDb(env.db);
    }
  });

  it("requires explicit consent for unsubscribed live sends", async () => {
    const env = setup("live", mockTransport());
    try {
      await expect(env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org" })).rejects.toThrow(/consent/);
      const out = (await env.orchestrator.sendDraft("draft-1", {
        recipient: "t@example.org",
        confirmConsent: true,
      })) as { send: { status: string } };
      expect(out.send.status).toBe("SENT");
    } finally {
      closeDb(env.db);
    }
  });
});

describe("local path via Warmbly test-email", () => {
  it("renders through the mailbox pipeline without AI or transport", async () => {
    const transport = mockTransport();
    const sendSpy = vi.spyOn(transport, "send");
    const env = setup("local", transport);
    try {
      const out = (await env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org" })) as {
        send: { status: string; provider: string };
      };
      expect(out.send.status).toBe("SENT");
      expect(out.send.provider).toBe("warmbly-test");
      expect(env.mock.testEmailCalls).toHaveLength(1);
      expect(env.mock.testEmailCalls[0]).toMatchObject({
        campaignId: "camp-1",
        accountId: "a1",
        recipient: "t@example.org",
        stepId: "s1",
        contactId: "c1",
      });
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      closeDb(env.db);
    }
  });

  it("fails closed with no mailbox", async () => {
    const env = setup("local", mockTransport(), { listAccounts: async () => [] });
    try {
      await expect(env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org" })).rejects.toThrow(/mailbox/);
    } finally {
      closeDb(env.db);
    }
  });
});

describe("live path via Brevo transport", () => {
  it("sends exact approved bytes with the approved sender", async () => {
    const transport = mockTransport();
    const env = setup("live", transport);
    try {
      await env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true });
      expect(transport.sent).toHaveLength(1);
      const msg = transport.sent[0];
      expect(msg.to).toEqual([{ email: "t@example.org" }]);
      expect(msg.from).toEqual({ email: "hello@example.com", name: "Bridge" });
      expect(msg.subject).toBe("Hello Shop");
      expect(msg.html).not.toContain("{{.ai_body}}");
      expect(msg.html).toContain("Concrete body text here.");
      for (const url of OFFERS) expect(msg.html).toContain(url);
      expect(env.mock.testEmailCalls).toHaveLength(0);
      const sends = new Sends(env.db);
      expect(sends.listByDraft("draft-1")[0]).toMatchObject({ status: "SENT", provider: "brevo" });
    } finally {
      closeDb(env.db);
    }
  });

  it("refuses without a brevo transport", async () => {
    const env = setup("live", null);
    try {
      await expect(
        env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true }),
      ).rejects.toThrow(/EMAIL_PROVIDER=brevo/);
    } finally {
      closeDb(env.db);
    }
  });

  it("blocks double sends, allows resend after re-approved edit", async () => {
    const env = setup("live", mockTransport());
    try {
      await env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true });
      await expect(
        env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true }),
      ).rejects.toThrow(/already sent/);
      const drafts = new Drafts(env.db);
      const row = drafts.get("draft-1");
      expect(row).toBeDefined();
      drafts.updateContent({ id: "draft-1", subject: "V2", body: "Edited body content.", renderedHtml: "<p>v2</p>", version: row?.version ?? 1 });
      drafts.setStatus("draft-1", "APPROVED");
      const out = (await env.orchestrator.sendDraft("draft-1", {
        recipient: "t@example.org",
        confirmConsent: true,
      })) as { send: { status: string } };
      expect(out.send.status).toBe("SENT");
    } finally {
      closeDb(env.db);
    }
  });

  it("marks transient failures retryable and permanent ones failed", async () => {
    const flaky = mockTransport({
      send: async () => {
        throw new SmtpError("temp", "mailbox busy");
      },
    });
    const env = setup("live", flaky);
    try {
      await expect(
        env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true }),
      ).rejects.toThrow(/busy/);
      const sends = new Sends(env.db);
      expect(sends.listByDraft("draft-1")[0].status).toBe("SEND_RETRYABLE");
      // Retry without force is refused; with force it proceeds.
      await expect(env.orchestrator.sendDraft("draft-1", { recipient: "t@example.org" })).rejects.toThrow(/force/);
      let calls = 0;
      (flaky as unknown as { send: unknown }).send = async () => {
        calls++;
        return { messageId: "m2" };
      };
      const out = (await env.orchestrator.sendDraft("draft-1", {
        recipient: "t@example.org",
        confirmConsent: true,
        force: true,
      })) as { send: { status: string } };
      expect(out.send.status).toBe("SENT");
      expect(calls).toBe(1);
    } finally {
      closeDb(env.db);
    }

    const doomed = setup("live", mockTransport({
      send: async () => {
        throw new SmtpError("perm", "rejected");
      },
    }));
    try {
      await expect(
        doomed.orchestrator.sendDraft("draft-1", { recipient: "t@example.org", confirmConsent: true }),
      ).rejects.toThrow(/rejected/);
      expect(new Sends(doomed.db).listByDraft("draft-1")[0].status).toBe("SEND_FAILED");
    } finally {
      closeDb(doomed.db);
    }
  });

  it("exposes send mode in status", async () => {
    const env = setup("live", mockTransport());
    try {
      const status = env.orchestrator.getStatus("run-1") as { send: { mode: string; email_provider: string } };
      expect(status.send).toEqual({ mode: "live", email_provider: "brevo" });
    } finally {
      closeDb(env.db);
    }
  });
});
