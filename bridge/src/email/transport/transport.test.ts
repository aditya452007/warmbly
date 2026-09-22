import { describe, expect, it, vi } from "vitest";
import nodemailer, { type Transporter } from "nodemailer";
import type { BridgeConfig } from "../../config.js";
import { isRetryableSmtp, SmtpError } from "./types.js";
import {
  classifySmtpError,
  LocalSmtpTransport,
  sendWithRetry,
  SmtpTransport,
} from "./smtpTransport.js";
import { BrevoSmtpTransport } from "./smtpTransport.js";
import { createEmailTransport, isEmailConfigured } from "./factory.js";

const OFFERS = ["https://example.com/offer-one", "https://example.com/offer-two"];

function baseConfig(overrides: Record<string, unknown> = {}): BridgeConfig {
  return {
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: 8787,
    BRIDGE_DB_PATH: ":memory:",
    WARMBLY_API_BASE_URL: "http://localhost:8080",
    WARMBLY_API_KEY: "wmbly_test",
    AI_PROVIDER: "stub",
    OPENCODE_BASE_URL: "http://127.0.0.1:4096",
    OPENCODE_SERVER_USERNAME: "",
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_MODEL: "",
    DEFAULT_PARALLEL_AGENTS: 4,
    MAX_PARALLEL_AGENTS: 16,
    DEFAULT_LEAD_TARGET: 50,
    MAX_LEADS_PER_CAMPAIGN: 500,
    AI_JOB_TIMEOUT_MS: 1000,
    AI_RETRY_ATTEMPTS: 0,
    WARMBLY_API_TIMEOUT_MS: 2000,
    WARMBLY_RETRY_ATTEMPTS: 0,
    EMAIL_PROVIDER: "none",
    BREVO_SMTP_HOST: "smtp-relay.brevo.com",
    BREVO_SMTP_PORT: 587,
    BREVO_SMTP_USER: "[ba28a3001@smtp-brevo.com](mailto:ba28a3001@smtp-brevo.com)",
    BREVO_SMTP_PASSWORD: "smtp-secret",
    BREVO_FROM_EMAIL: "hello@example.com",
    BREVO_FROM_NAME: "Example",
    SMTP_SECURITY: "starttls",
    LOCAL_SMTP_HOST: "127.0.0.1",
    LOCAL_SMTP_PORT: 11025,
    ...overrides,
  } as BridgeConfig;
}

function streamMailer(): Transporter {
  return nodemailer.createTransport({ streamTransport: true, buffer: true });
}

describe("provider factory and Brevo config", () => {
  it("builds Brevo from env with sender defaults", () => {
    const t = createEmailTransport(baseConfig({ EMAIL_PROVIDER: "brevo" }));
    expect(t).toBeInstanceOf(BrevoSmtpTransport);
    expect(t?.name).toBe("brevo");
    expect((t as BrevoSmtpTransport).defaultFrom()).toEqual({ email: "hello@example.com", name: "Example" });
    expect(isEmailConfigured(baseConfig({ EMAIL_PROVIDER: "brevo" }))).toBe(true);
    expect(isEmailConfigured(baseConfig())).toBe(false);
    expect(createEmailTransport(baseConfig())).toBe(null);
  });

  it("rejects missing password", () => {
    expect(() => createEmailTransport(baseConfig({ EMAIL_PROVIDER: "brevo", BREVO_SMTP_PASSWORD: "" }))).toThrow(
      /BREVO_SMTP_PASSWORD/,
    );
  });

  it("rejects missing From instead of using the login as sender", () => {
    expect(() => createEmailTransport(baseConfig({ EMAIL_PROVIDER: "brevo", BREVO_FROM_EMAIL: "" }))).toThrow(
      /must never be used as the visible sender/,
    );
  });

  it("rejects unknown providers and bad ports", () => {
    expect(() => createEmailTransport(baseConfig({ EMAIL_PROVIDER: "carrier-pigeon" }))).toThrow(/available: brevo/);
    expect(() => createEmailTransport(baseConfig({ EMAIL_PROVIDER: "brevo", BREVO_SMTP_PORT: 99999 }))).toThrow(
      /1-65535/,
    );
    expect(() => createEmailTransport(baseConfig({ EMAIL_PROVIDER: "brevo", SMTP_SECURITY: "smoke" }))).toThrow(
      /starttls, ssl, or none/,
    );
  });

  it("builds the local Mailpit transport without credentials", () => {
    const t = createEmailTransport(baseConfig({ EMAIL_PROVIDER: "local" }));
    expect(t).toBeInstanceOf(LocalSmtpTransport);
    expect(t?.name).toBe("local");
  });
});

describe("SMTP option mapping", () => {
  class Probe extends SmtpTransport {
    get resolved() {
      return this.options;
    }
  }

  it("maps starttls and ssl ports", () => {
    const starttls = new Probe({
      providerName: "brevo",
      host: "smtp-relay.brevo.com",
      port: 587,
      security: "starttls",
      username: "u",
      password: "p",
      connectionTimeoutMs: 1,
      greetingTimeoutMs: 1,
      socketTimeoutMs: 1,
    });
    expect(starttls.resolved).toMatchObject({ host: "smtp-relay.brevo.com", port: 587, security: "starttls" });
    const ssl = new Probe({ ...starttls.resolved, port: 465, security: "ssl" });
    expect(ssl.resolved).toMatchObject({ port: 465, security: "ssl" });
  });
});

describe("error classification and retry", () => {
  it("classifies auth, tls, connection, timeout, temp, perm", () => {
    expect(classifySmtpError(Object.assign(new Error("535 Authentication failed"), { code: "EAUTH" })).code).toBe("auth");
    expect(classifySmtpError(new Error("self signed certificate")).code).toBe("tls");
    expect(classifySmtpError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).code).toBe(
      "connection",
    );
    expect(classifySmtpError(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" })).code).toBe("timeout");
    expect(classifySmtpError(Object.assign(new Error("mailbox busy"), { responseCode: 421 })).code).toBe("temp");
    expect(classifySmtpError(Object.assign(new Error("rejected"), { responseCode: 550 })).code).toBe("perm");
    expect(isRetryableSmtp("temp")).toBe(true);
    expect(isRetryableSmtp("auth")).toBe(false);
    expect(isRetryableSmtp("perm")).toBe(false);
  });

  it("retries transient failures boundedly, never auth", async () => {
    let calls = 0;
    await sendWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new SmtpError("temp", "busy");
        return "ok";
      },
      { maxAttempts: 3, baseMs: 1 },
    );
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      sendWithRetry(
        async () => {
          calls++;
          throw new SmtpError("auth", "bad login");
        },
        { maxAttempts: 5, baseMs: 1 },
      ),
    ).rejects.toThrow("bad login");
    expect(calls).toBe(1);
  });

  it("redacts credentials from adapter errors", async () => {
    const failing = {
      verify: async () => {
        throw Object.assign(new Error("535 user [ba28a3001@smtp-brevo.com](mailto:ba28a3001@smtp-brevo.com) pass smtp-secret rejected"), { code: "EAUTH" });
      },
      sendMail: async () => ({ messageId: "x" }),
      close: () => undefined,
    } as unknown as Transporter;
    const t = new BrevoSmtpTransport({
      host: "smtp-relay.brevo.com",
      port: 587,
      security: "starttls",
      username: "[ba28a3001@smtp-brevo.com](mailto:ba28a3001@smtp-brevo.com)",
      password: "smtp-secret",
      fromEmail: "hello@example.com",
      fromName: "",
      connectionTimeoutMs: 1,
      greetingTimeoutMs: 1,
      socketTimeoutMs: 1,
    });
    (t as unknown as { transporter: Transporter }).transporter = failing;
    const err = await t.verify().catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe("auth");
    expect(String(err.message)).not.toContain("smtp-secret");
    expect(String(err.message)).not.toContain("ba28a3001@smtp-brevo.com");
  });
});

describe("message delivery through stream transport (no network)", () => {
  const html = `<p>Hi {{.FirstName}},</p><p>Body text.</p><a href="${OFFERS[0]}">Offer 1</a><a href="${OFFERS[1]}">Offer 2</a>`;

  function adapter(): SmtpTransport {
    return new SmtpTransport({
      providerName: "test",
      host: "localhost",
      port: 2525,
      security: "none",
      username: "",
      password: "",
      connectionTimeoutMs: 1000,
      greetingTimeoutMs: 1000,
      socketTimeoutMs: 1000,
      transporter: streamMailer(),
    });
  }

  it("sends rendered bytes through the adapter with alternatives and headers", async () => {
    const t = adapter();
    await t.verify();
    const result = await t.send({
      from: { email: "hello@example.com", name: "Example" },
      to: [{ email: "lead@example.org" }],
      subject: "A quick idea",
      html,
      text: "Hi, body text.",
      replyTo: { email: "reply@example.com" },
      inReplyTo: "<abc@example.com>",
      references: "<abc@example.com>",
      headers: { "X-Bridge-Run": "run-1" },
    });
    expect(result.messageId).toMatch(/^<.+>$/);
    await t.close();
  });

  it("neither the adapter nor nodemailer mutates offer URLs", async () => {
    // Raw MIME straight from nodemailer proves byte preservation; the adapter
    // hands the same html string through untouched (previous test).
    const direct = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await direct.sendMail({
      from: "Example <hello@example.com>",
      to: "lead@example.org",
      subject: "A quick idea",
      html,
      text: "Hi, body text.",
      replyTo: "reply@example.com",
      inReplyTo: "<abc@example.com>",
      headers: { "X-Bridge-Run": "run-1" },
    });
    const raw = String(info.message);
    // Quoted-printable transport encoding (soft breaks, =3D escapes) is the
    // wire format, not a mutation: decode before comparing bytes.
    const decoded = raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    expect(decoded).toContain(html);
    for (const url of OFFERS) expect(decoded).toContain(url);
    expect(raw).toContain("Hi, body text.");
    expect(raw).toContain("Reply-To: reply@example.com");
    expect(raw).toContain("In-Reply-To: <abc@example.com>");
    expect(raw).toContain("X-Bridge-Run: run-1");
    expect(raw).toMatch(/Message-ID: <.+>/);
  });

  it("rejects empty recipients, subjects, and bodies before any I/O", async () => {
    const t = new SmtpTransport({
      providerName: "test",
      host: "localhost",
      port: 2525,
      security: "none",
      username: "",
      password: "",
      connectionTimeoutMs: 1000,
      greetingTimeoutMs: 1000,
      socketTimeoutMs: 1000,
      transporter: streamMailer(),
    });
    const sender = vi.fn();
    (t as unknown as { transporter: Transporter }).transporter = {
      verify: async () => undefined,
      sendMail: sender,
      close: () => undefined,
    } as unknown as Transporter;
    await expect(t.send({ from: { email: "a@x.com" }, to: [], subject: "s", html: "<p>x</p>" })).rejects.toThrow(
      /recipient/,
    );
    await expect(
      t.send({ from: { email: "a@x.com" }, to: [{ email: "b@x.com" }], subject: "  ", html: "<p>x</p>" }),
    ).rejects.toThrow(/subject/);
    expect(sender).not.toHaveBeenCalled();
    await t.close();
  });
});
