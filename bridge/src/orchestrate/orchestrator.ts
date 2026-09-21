import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import type { AgentRuntime } from "../ai/types.js";
import { createAiProvider } from "../ai/factory.js";
import { DEFAULT_LANES, OpenCodeDiscoveryProvider, type Lane } from "../ai/discovery.js";
import { buildPersonalizePrompt, buildResearchPrompt, promptVersion } from "../prompts/index.js";
import {
  isHttpUrl,
  leadIdentity,
  normalizeDomain,
  normalizeEmail,
  OutreachSchema,
  ResearchSchema,
  RunRequestSchema,
} from "../domain/validate.js";
import type { RunRequest } from "../domain/types.js";
import { renderOutreach, OUTREACH_TEMPLATE_NAME, OUTREACH_TEMPLATE_VERSION } from "../email/render.js";
import { log } from "../log.js";
import {
  AgentRuns,
  CampaignRuns,
  DiscoveryJobs,
  Drafts,
  Events,
  Leads,
  Research,
  type LeadRow,
} from "../store/repositories.js";
import { ContactSyncBuffer, type SyncRecorder } from "../warmbly/sync.js";
import { mapLeadToContact, mapOutreachToCustomFields } from "../warmbly/contactMapper.js";
import { WarmblyClient } from "../warmbly/client.js";
import { runBounded } from "./pool.js";

export interface OrchestratorDeps {
  config: BridgeConfig;
  runs: CampaignRuns;
  agents: AgentRuns;
  jobs: DiscoveryJobs;
  leads: Leads;
  research: Research;
  drafts: Drafts;
  events: Events;
  warmbly: WarmblyClient;
  createRuntime?: (provider: string) => AgentRuntime;
}

const HEARTBEAT_MS = 15_000;
const LEASE_SECONDS = 120;
const MAX_SUMMARY_CHARS = 800;
const OUTREACH_STEP_NAME = "AI Outreach";
const RUN_DEADLINE_MS = 30 * 60_000;

function utcNow(): string {
  return new Date().toISOString();
}

function deadlineExceeded(startedAt: number): boolean {
  return Date.now() - startedAt > RUN_DEADLINE_MS;
}

// The orchestrator owns all campaign state transitions. Agents report
// results; only this class writes run/agent/lead status. The AI runtime and
// Warmbly are external engines behind ports; neither is trusted with state.
export class BridgeOrchestrator {
  private readonly config: BridgeConfig;
  private readonly runs: CampaignRuns;
  private readonly agents: AgentRuns;
  private readonly jobs: DiscoveryJobs;
  private readonly leads: Leads;
  private readonly research: Research;
  private readonly drafts: Drafts;
  private readonly events: Events;
  private readonly warmbly: WarmblyClient;
  private readonly createRuntime: (provider: string) => AgentRuntime;
  private readonly activeSessions = new Set<string>();
  private readonly activeJobs = new Set<string>();
  private shuttingDown = false;

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.runs = deps.runs;
    this.agents = deps.agents;
    this.jobs = deps.jobs;
    this.leads = deps.leads;
    this.research = deps.research;
    this.drafts = deps.drafts;
    this.events = deps.events;
    this.warmbly = deps.warmbly;
    this.createRuntime =
      deps.createRuntime ??
      ((provider) =>
        createAiProvider(provider, {
          baseUrl: this.config.OPENCODE_BASE_URL,
          username: this.config.OPENCODE_SERVER_USERNAME,
          password: this.config.OPENCODE_SERVER_PASSWORD,
          timeoutMs: this.config.AI_JOB_TIMEOUT_MS,
        }));
  }

  // Crash recovery: expired leases become retryable, stale agents fail, runs
  // with pending work resume from persisted rows (every stage is idempotent).
  recover(): string[] {
    const now = utcNow();
    const retried = this.jobs.claimStale(now);
    for (const job of retried) {
      this.events.append({ kind: "job.retry_scheduled", campaignRunId: job.campaign_run_id, jobId: job.id });
    }
    const staleAgents = this.agents.findStale(now, LEASE_SECONDS);
    for (const agent of staleAgents) {
      this.agents.finish(agent.id, "FAILED", "lease expired without heartbeat (bridge restarted or crashed)");
      this.events.append({
        kind: "agent.failed",
        campaignRunId: agent.campaign_run_id,
        agentId: agent.id,
        message: "stale lease recovered",
      });
    }
    return retried.map((j) => j.campaign_run_id);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const jobId of this.activeJobs) {
      try {
        this.jobs.fail(jobId, "bridge shutting down", true);
      } catch {
        // Best effort on the way out.
      }
    }
    this.activeJobs.clear();
    this.activeSessions.clear();
  }

  get shutting(): boolean {
    return this.shuttingDown;
  }

  async pingWarmbly(): Promise<boolean> {
    try {
      return await this.warmbly.ping();
    } catch {
      return false;
    }
  }

  private runControl(runId: string): { paused: boolean; cancelled: boolean } {
    const run = this.runs.get(runId);
    return { paused: run?.status === "PAUSED", cancelled: run?.status === "CANCELLED" || this.shuttingDown };
  }

  private async waitWhilePaused(runId: string): Promise<boolean> {
    while (!this.shuttingDown) {
      const control = this.runControl(runId);
      if (control.cancelled) return false;
      if (!control.paused) return true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  // Validates, persists, verifies dependencies, then executes in background.
  async startRun(input: RunRequest): Promise<string> {
    const parsed = RunRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`invalid run request: ${parsed.error.issues[0]?.message ?? "rejected"}`);
    }
    const req = parsed.data;
    if (req.parallelAgents > this.config.MAX_PARALLEL_AGENTS) {
      throw new Error(`parallelAgents exceeds configured maximum ${this.config.MAX_PARALLEL_AGENTS}`);
    }
    if (req.targetLeads > this.config.MAX_LEADS_PER_CAMPAIGN) {
      throw new Error(`targetLeads exceeds configured maximum ${this.config.MAX_LEADS_PER_CAMPAIGN}`);
    }
    const id = randomUUID();
    this.runs.create({
      id,
      warmblyCampaignId: req.warmblyCampaignId,
      businessType: req.businessType,
      location: req.location,
      customInstructions: req.customInstructions,
      offerUrls: req.offerUrls,
      parallelAgents: req.parallelAgents,
      targetLeads: req.targetLeads,
    });
    this.events.append({ kind: "campaign.started", campaignRunId: id, message: `${req.businessType} in ${req.location}` });
    void this.execute(id).catch((err) => {
      log("error", "run execution failed", { campaignId: id, error: err instanceof Error ? err.message : String(err) });
    });
    return id;
  }

  pauseRun(runId: string): void {
    this.runs.setStatus(runId, "PAUSED");
    this.events.append({ kind: "campaign.paused", campaignRunId: runId });
  }

  resumeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error("unknown campaign run");
    if (run.status !== "PAUSED" && run.status !== "FAILED") {
      throw new Error(`cannot resume a run in status ${run.status}`);
    }
    this.runs.setStatus(runId, "DISCOVERING");
    this.events.append({ kind: "campaign.resumed", campaignRunId: runId });
    void this.execute(runId).catch((err) => {
      log("error", "run resume failed", { campaignId: runId, error: err instanceof Error ? err.message : String(err) });
    });
  }

  cancelRun(runId: string): void {
    this.runs.setStatus(runId, "CANCELLED");
    this.events.append({ kind: "campaign.cancelled", campaignRunId: runId });
  }

  private trackSession(sessionId: string): void {
    this.activeSessions.add(sessionId);
  }

  // One isolated discovery worker: its own agent row, job lease, and AI
  // session. A throw here fails this worker only; siblings continue.
  private async runDiscoveryWorker(args: {
    runId: string;
    run: RunRequest;
    agentNumber: number;
    lane: Lane;
    runtime: AgentRuntime;
    recorder: SyncRecorder;
    buffer: ContactSyncBuffer;
    pVersion: string;
    startedAt: number;
  }): Promise<{ found: number; duplicates: number }> {
    const { runId, run, agentNumber, lane, runtime, recorder, buffer, pVersion, startedAt } = args;
    const agentId = randomUUID();
    const jobId = randomUUID();
    this.agents.create({ id: agentId, campaignRunId: runId, agentNumber, lane: lane.id });
    this.jobs.enqueue({ id: jobId, campaignRunId: runId, agentRunId: agentId, payload: JSON.stringify({ lane: lane.id }) });
    this.activeJobs.add(jobId);
    const beat = setInterval(() => {
      try {
        this.agents.heartbeat(agentId);
      } catch {
        // Heartbeat is best effort; lease expiry recovers a dead worker.
      }
    }, HEARTBEAT_MS);
    this.events.append({ kind: "agent.started", campaignRunId: runId, agentId, message: `lane ${lane.id}` });
    let found = 0;
    let duplicates = 0;
    try {
      this.agents.heartbeat(agentId);
      this.agents.setTask(agentId, `discovering:${lane.id}`);
      if (!(await this.waitWhilePaused(runId))) {
        this.agents.finish(agentId, "CANCELLED", "run cancelled");
        this.jobs.fail(jobId, "run cancelled", false);
        return { found, duplicates };
      }
      const discovery = new OpenCodeDiscoveryProvider(runtime, { timeoutMs: this.config.AI_JOB_TIMEOUT_MS });
      const wire = await discovery.discover({
        businessType: run.businessType,
        location: run.location,
        customInstructions: run.customInstructions,
        lane,
        maxLeads: Math.max(1, Math.ceil(run.targetLeads / run.parallelAgents) + 2),
        promptVersion: pVersion,
      });
      for (const item of wire) {
        if (this.runControl(runId).cancelled || deadlineExceeded(startedAt)) break;
        if (!(await this.waitWhilePaused(runId))) break;
        const email = normalizeEmail(item.email);
        const domain = item.website && isHttpUrl(item.website) ? normalizeDomain(item.website) : null;
        const sourceUrls = (item.source_urls ?? []).filter(isHttpUrl);
        if (sourceUrls.length === 0) {
          duplicates += 1;
          continue;
        }
        let identity: string;
        try {
          identity = leadIdentity(domain, email);
        } catch {
          duplicates += 1;
          continue;
        }
        const leadId = randomUUID();
        const inserted = this.leads.insert({
          id: leadId,
          campaignRunId: runId,
          agentId,
          identity,
          businessName: item.business_name.trim(),
          website: item.website ?? null,
          websiteDomain: domain,
          email,
          phone: item.phone?.trim() || null,
          address: item.address?.trim() || null,
          city: item.city?.trim() || null,
          country: item.country?.trim() || null,
          sourceUrls,
          confidence: item.confidence ?? 0,
          status: "DISCOVERED",
        });
        if (inserted.duplicate) {
          duplicates += 1;
          this.events.append({ kind: "lead.duplicate", campaignRunId: runId, agentId, message: identity });
          continue;
        }
        found += 1;
        this.events.append({ kind: "lead.discovered", campaignRunId: runId, agentId, leadId, message: item.business_name });
        // Checkpoint immediately: persist first, then attempt Warmbly sync for
        // leads that already carry an email. A crash after this point loses
        // nothing already returned.
        if (email) {
          buffer.add(leadId, {
            first_name: "",
            last_name: "",
            email,
            company: item.business_name.trim(),
            ...(item.phone?.trim() ? { phone: item.phone.trim() } : {}),
            custom_fields: {
              website: item.website ?? "",
              location: run.location,
              research_summary_short: "",
              pain_1: "",
              pain_2: "",
              agent_id: agentId,
              ai_status: "discovered",
            },
          });
        }
      }
      this.jobs.complete(jobId);
      this.agents.addLeads(agentId, found);
      this.agents.addDuplicates(agentId, duplicates);
      this.agents.finish(agentId, "SUCCEEDED");
      return { found, duplicates };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.agents.addErrors(agentId, 1);
      this.agents.finish(agentId, "FAILED", message.slice(0, 500));
      this.jobs.fail(jobId, message.slice(0, 500), true);
      this.events.append({ kind: "agent.failed", campaignRunId: runId, agentId, message: message.slice(0, 200) });
      throw err;
    } finally {
      clearInterval(beat);
      this.activeJobs.delete(jobId);
      try {
        await buffer.flush();
      } catch {
        // Sync retries resume from persisted pending rows.
      }
    }
  }

  private async execute(runId: string): Promise<void> {
    const startedAt = Date.now();
    const stored = this.runs.get(runId);
    if (!stored) return;
    const run: RunRequest = {
      warmblyCampaignId: stored.warmbly_campaign_id,
      businessType: stored.business_type,
      location: stored.location,
      customInstructions: stored.custom_instructions,
      offerUrls: [stored.offer_url_1, stored.offer_url_2, stored.offer_url_3].filter(
        (u): u is string => !!u,
      ),
      parallelAgents: stored.parallel_agents,
      targetLeads: stored.target_leads,
    };
    const pVersion = promptVersion();
    const runtime = this.createRuntime(this.config.AI_PROVIDER);

    // Dependency gates before any AI session: Warmbly reachable first, then
    // the AI provider. A down provider parks the run instead of failing it.
    try {
      await this.warmbly.getCampaign(run.warmblyCampaignId);
    } catch (err) {
      this.runs.setStatus(runId, "FAILED", `warmbly unreachable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
      return;
    }
    let providerReady = false;
    for (let attempt = 1; attempt <= this.config.AI_RETRY_ATTEMPTS + 1; attempt++) {
      try {
        const ping = await runtime.executeText({
          systemPrompt: "Reply with exactly: ok",
          prompt: "Reply with exactly: ok",
          timeoutMs: 30_000,
          title: "provider-probe",
        });
        if (ping.sessionId) this.trackSession(ping.sessionId);
        providerReady = ping.ok;
        if (providerReady) break;
      } catch {
        providerReady = false;
      }
      if (!providerReady && attempt <= this.config.AI_RETRY_ATTEMPTS) {
        this.runs.setStatus(runId, "WAITING_FOR_AI");
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    if (!providerReady) {
      this.runs.setStatus(runId, "WAITING_FOR_AI", "AI provider unreachable after retries");
      this.events.append({ kind: "campaign.waiting_for_ai", campaignRunId: runId });
      return;
    }

    const recorder: SyncRecorder = {
      markSynced: (leadId, contactId) => {
        this.leads.setSynced(leadId, contactId);
        this.events.append({ kind: "warmbly.contact_sync_succeeded", campaignRunId: runId, leadId, message: contactId });
      },
      markSyncFailed: (leadId, error, retryable) => {
        this.leads.setSyncFailed(leadId, error.slice(0, 500));
        this.events.append({
          kind: "warmbly.contact_sync_failed",
          campaignRunId: runId,
          leadId,
          message: `${retryable ? "retryable" : "permanent"}: ${error.slice(0, 200)}`,
        });
      },
    };
    const buffer = new ContactSyncBuffer(this.warmbly, runId, recorder, { batchSize: 25, flushIntervalMs: 5000 });

    try {
      // Stage 1: discovery across isolated workers.
      this.runs.setStatus(runId, "DISCOVERING");
      const lanes = DEFAULT_LANES;
      const agentCount = Math.min(run.parallelAgents, this.config.MAX_PARALLEL_AGENTS);
      const discoveryResults = await runBounded(agentCount, Array.from({ length: agentCount }, (_, i) => {
        const lane = lanes[i % lanes.length];
        return () =>
          this.runDiscoveryWorker({
            runId,
            run,
            agentNumber: i + 1,
            lane,
            runtime,
            recorder,
            buffer,
            pVersion,
            startedAt,
          });
      }));
      await buffer.close();
      const succeeded = discoveryResults.filter((r) => r.ok).length;
      const failed = discoveryResults.length - succeeded;
      if (succeeded === 0) {
        this.runs.setStatus(runId, "FAILED", "all discovery workers failed");
        return;
      }
      if (!(await this.waitWhilePaused(runId))) {
        this.runs.setStatus(runId, "CANCELLED");
        return;
      }

      // Stage 2: research each discovered lead in a fresh isolated session.
      this.runs.setStatus(runId, "RESEARCHING");
      const discovered = this.leads.listByStatus(runId, "DISCOVERED", run.targetLeads * 2 + 20);
      await runBounded(agentCount, discovered.map((lead) => () => this.researchLead(runId, run, lead, runtime, pVersion)));
      if (!(await this.waitWhilePaused(runId))) {
        this.runs.setStatus(runId, "CANCELLED");
        return;
      }

      // Stage 3: personalize qualified leads, again one session per lead.
      this.runs.setStatus(runId, "PERSONALIZING");
      const qualified = this.leads.listByStatus(runId, "QUALIFIED", run.targetLeads + 20).slice(0, run.targetLeads);
      await runBounded(agentCount, qualified.map((lead) => () => this.personalizeLead(runId, run, lead, runtime, pVersion)));
      if (!(await this.waitWhilePaused(runId))) {
        this.runs.setStatus(runId, "CANCELLED");
        return;
      }

      // Stage 4: prepare one draft step shell on the Warmbly campaign.
      await this.prepareOutreachStep(runId, run);

      const counts = this.leads.countsByStatus(runId);
      const terminalFails = (counts.FAILED ?? 0) + failed;
      this.runs.setStatus(runId, terminalFails > 0 ? "PARTIALLY_COMPLETED" : "COMPLETED");
      this.events.append({ kind: "campaign.completed", campaignRunId: runId, message: `synced=${counts.SYNCED_TO_WARMBLY ?? 0}` });
    } catch (err) {
      this.runs.setStatus(runId, "FAILED", (err instanceof Error ? err.message : String(err)).slice(0, 500));
    } finally {
      try {
        await buffer.close();
      } catch {
        // Rows already persist; sync resumes from pending.
      }
      try {
        await runtime.close();
      } catch {
        // Provider close is best effort.
      }
    }
  }

  private async researchLead(
    runId: string,
    run: RunRequest,
    lead: LeadRow,
    runtime: AgentRuntime,
    pVersion: string,
  ): Promise<void> {
    if (this.runControl(runId).cancelled) return;
    this.leads.setStatus(lead.id, "RESEARCHING");
    try {
      const built = buildResearchPrompt({
        businessName: lead.business_name,
        website: lead.website ?? "unknown",
        location: run.location,
        businessType: run.businessType,
        maxSummaryChars: MAX_SUMMARY_CHARS,
      });
      const result = await runtime.executeStructured(
        {
          systemPrompt: built.system,
          prompt: built.text,
          timeoutMs: this.config.AI_JOB_TIMEOUT_MS,
          title: `research:${lead.id}`,
        },
        ResearchSchema,
      );
      if (result.sessionId) this.trackSession(result.sessionId);
      if (!result.ok || !result.data) throw new Error(`research failed: ${result.error?.code ?? "unknown"}`);
      this.research.upsert(lead.id, {
        summary: result.data.summary,
        painPoints: result.data.pain_points,
        facts: result.data.facts,
      });
      // Qualification: an email plus at least a website or solid confidence.
      // Rejected leads stay local with their research; nothing is discarded.
      const qualifies = !!lead.email && (!!lead.website_domain || lead.confidence >= 0.2);
      this.leads.setStatus(lead.id, qualifies ? "QUALIFIED" : "REJECTED");
      this.events.append({
        kind: qualifies ? "lead.researched" : "lead.rejected",
        campaignRunId: runId,
        leadId: lead.id,
      });
    } catch (err) {
      this.leads.setStatus(lead.id, "FAILED");
      this.events.append({
        kind: "agent.tool_error",
        campaignRunId: runId,
        leadId: lead.id,
        message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }

  private async personalizeLead(
    runId: string,
    run: RunRequest,
    lead: LeadRow,
    runtime: AgentRuntime,
    pVersion: string,
  ): Promise<void> {
    void pVersion;
    if (this.runControl(runId).cancelled) return;
    this.leads.setStatus(lead.id, "PERSONALIZING");
    try {
      const stored = this.research.get(lead.id) ?? { summary: "", painPoints: [] as string[], facts: [] as Array<{ claim: string; sourceUrl: string }> };
      const built = buildPersonalizePrompt({
        businessName: lead.business_name,
        website: lead.website ?? "unknown",
        location: run.location,
        businessType: run.businessType,
        researchSummary: stored?.summary ?? "",
        painPoints: stored?.painPoints.join("; ") ?? "",
        facts: stored?.facts.map((f) => `${f.claim} (${f.sourceUrl})`).join("; ") ?? "",
        customInstructions: run.customInstructions,
        maxSubjectChars: 120,
        maxBodyChars: 4000,
      });
      const result = await runtime.executeStructured(
        {
          systemPrompt: built.system,
          prompt: built.text,
          timeoutMs: this.config.AI_JOB_TIMEOUT_MS,
          title: `personalize:${lead.id}`,
        },
        OutreachSchema,
      );
      if (result.sessionId) this.trackSession(result.sessionId);
      if (!result.ok || !result.data) throw new Error(`personalize failed: ${result.error?.code ?? "unknown"}`);
      const offers = [...run.offerUrls, "", "", ""].slice(0, 3) as [string, string, string];
      const rendered = await renderOutreach({ aiSubject: result.data.subject, aiBodyText: result.data.body, offers });
      this.drafts.upsert({
        id: randomUUID(),
        leadId: lead.id,
        subject: rendered.subject,
        body: result.data.body,
        templateName: OUTREACH_TEMPLATE_NAME,
        templateVersion: OUTREACH_TEMPLATE_VERSION,
        renderedHtml: rendered.snapshot,
        offerSnapshot: [...run.offerUrls],
        status: "RENDERED",
      });
      this.leads.setStatus(lead.id, "PERSONALIZED");
      // Attach personalization to the Warmbly contact (lookup-first, so a
      // crash between contact sync and this update cannot duplicate).
      let contactId = lead.warmbly_contact_id;
      if (!contactId && lead.email) {
        const found = await this.warmbly.lookupContactByEmail(lead.email);
        contactId = found?.id ?? null;
      }
      if (contactId) {
        await this.warmbly.updateContact(contactId, {
          custom_fields: {
            ...(await this.existingCustomFields(contactId)),
            ...mapOutreachToCustomFields(rendered.subject, result.data.body),
          },
        });
        this.leads.setSynced(lead.id, contactId);
        this.leads.setStatus(lead.id, "SYNCED_TO_WARMBLY");
      }
      this.leads.setStatus(lead.id, "RENDERED");
      this.events.append({ kind: "email.rendered", campaignRunId: runId, leadId: lead.id });
      if (contactId) this.leads.setStatus(lead.id, "SYNCED_TO_WARMBLY");
    } catch (err) {
      this.leads.setStatus(lead.id, "FAILED");
      this.events.append({
        kind: "agent.tool_error",
        campaignRunId: runId,
        leadId: lead.id,
        message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }

  // PATCH replaces the whole custom-field map, so merge against the stored
  // contact read. Without the merge, personalization would wipe the
  // discovery fields (website, location) written at sync time.
  private async existingCustomFields(contactId: string): Promise<Record<string, string>> {
    try {
      const contact = await this.warmbly.getContact(contactId);
      return contact.custom_fields ?? {};
    } catch {
      return {};
    }
  }

  // One master draft step shell: fixed layout + {{.ai_subject}} subject and
  // {{.ai_body}} variable with the exact offer set. Never starts anything.
  private async prepareOutreachStep(runId: string, run: RunRequest): Promise<void> {
    const counts = this.leads.countsByStatus(runId);
    const rendered = (counts.RENDERED ?? 0) + (counts.SYNCED_TO_WARMBLY ?? 0);
    if (rendered === 0) return;
    const steps = await this.warmbly.listSteps(run.warmblyCampaignId);
    let step = steps.find((s) => s.name === OUTREACH_STEP_NAME);
    if (!step) step = await this.warmbly.createStep(run.warmblyCampaignId);
    const offers = [...run.offerUrls, "", "", ""].slice(0, 3) as [string, string, string];
    const shell = await renderOutreach({ aiSubject: "AI Outreach", aiBodyText: "Personalized per contact.", offers });
    await this.warmbly.updateStep(run.warmblyCampaignId, step.id, {
      subject: "{{.ai_subject}}",
      bodyHtml: shell.stepHtml,
    });
    this.events.append({ kind: "campaign.step_prepared", campaignRunId: runId, message: step.id });
  }

  getStatus(runId: string): Record<string, unknown> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("unknown campaign run");
    const agents = this.agents.listByRun(runId);
    const counts = this.leads.countsByStatus(runId);
    return {
      status: run.status,
      agents: {
        total: agents.length,
        running: agents.filter((a) => a.status === "RUNNING").length,
        completed: agents.filter((a) => a.status === "SUCCEEDED").length,
        failed: agents.filter((a) => a.status === "FAILED").length,
      },
      leads: {
        discovered: Object.entries(counts).reduce((n, [k, v]) => (k === "REJECTED" || k === "FAILED" ? n : n + v), 0),
        duplicates: agents.reduce((n, a) => n + a.duplicates, 0),
        qualified: counts.QUALIFIED ?? 0,
        personalized: (counts.PERSONALIZED ?? 0) + (counts.RENDERED ?? 0) + (counts.SYNCED_TO_WARMBLY ?? 0),
        rendered: counts.RENDERED ?? 0,
        synced: counts.SYNCED_TO_WARMBLY ?? 0,
      },
      errors: agents.reduce((n, a) => n + a.errors, 0),
    };
  }

  listAgents(runId: string): unknown[] {
    return this.agents.listByRun(runId).map((a) => ({
      agent_id: a.id,
      lane: a.lane,
      status: a.status,
      current_task: a.current_task,
      session_state: a.session_id ? "active" : "none",
      leads_found: a.leads_found,
      duplicates: a.duplicates,
      research_completed: 0,
      emails_generated: 0,
      errors: a.errors,
      last_activity: a.last_heartbeat,
      started_at: a.started_at,
      finished_at: a.finished_at,
    }));
  }

  listLeads(runId: string, limit: number, offset: number): unknown[] {
    return this.leads.listByRun(runId, limit, offset).map((l) => ({
      id: l.id,
      business_name: l.business_name,
      website: l.website,
      email: l.email,
      status: l.status,
      sync_status: l.sync_status,
      warmbly_contact_id: l.warmbly_contact_id,
    }));
  }
}
