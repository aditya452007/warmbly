import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import type { AgentRuntime } from "../ai/types.js";
import { createAiProvider } from "../ai/factory.js";
import { DEFAULT_LANES, OpenCodeDiscoveryProvider, type Lane } from "../ai/discovery.js";
import { buildPersonalizePrompt, buildResearchPrompt, promptVersion } from "../prompts/index.js";
import {
  isHttpUrl,
  escapeHtml,
  leadIdentity,
  normalizeDomain,
  normalizeEmail,
  OutreachSchema,
  ResearchSchema,
  RunRequestSchema,
} from "../domain/validate.js";
import type { RunRequest } from "../domain/types.js";
import { renderOutreach, OUTREACH_TEMPLATE_NAME, OUTREACH_TEMPLATE_VERSION } from "../email/render.js";
import { AI_BODY_VAR } from "../email/template.js";
import { log } from "../log.js";
import {
  AgentRuns,
  CampaignRuns,
  DiscoveryJobs,
  Drafts,
  DRAFT_STATUS,
  Events,
  Leads,
  Research,
  Sends,
  SEND_STATUS,
  type DraftRow,
  type LeadRow,
} from "../store/repositories.js";
import { ContactSyncBuffer, type SyncRecorder } from "../warmbly/sync.js";
import { mapLeadToContact, mapOutreachToCustomFields } from "../warmbly/contactMapper.js";
import { WarmblyClient } from "../warmbly/client.js";
import type { EmailTransport } from "../email/transport/types.js";
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
  sends: Sends;
  warmbly: WarmblyClient;
  createRuntime?: (provider: string) => AgentRuntime;
  getEmailTransport?: () => EmailTransport | null;
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
  private readonly sends: Sends;
  private readonly warmbly: WarmblyClient;
  private readonly createRuntime: (provider: string) => AgentRuntime;
  private readonly getEmailTransport: () => EmailTransport | null;
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
    this.sends = deps.sends;
    this.warmbly = deps.warmbly;
    this.getEmailTransport = deps.getEmailTransport ?? (() => null);
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

  // Crash recovery: expired leases become retryable, stale agents fail,
  // in-flight leads return to resting states, and runs with unfinished work
  // resume from persisted rows (every stage is idempotent). Returns resumed
  // run ids.
  recover(): string[] {
    const now = utcNow();
    const touched = new Set<string>();
    const retried = this.jobs.claimStale(now);
    for (const job of retried) {
      touched.add(job.campaign_run_id);
      this.events.append({ kind: "job.retry_scheduled", campaignRunId: job.campaign_run_id, jobId: job.id });
    }
    const staleAgents = this.agents.findStale(now, LEASE_SECONDS);
    for (const agent of staleAgents) {
      touched.add(agent.campaign_run_id);
      this.agents.finish(agent.id, "FAILED", "lease expired without heartbeat (bridge restarted or crashed)");
      this.events.append({
        kind: "agent.failed",
        campaignRunId: agent.campaign_run_id,
        agentId: agent.id,
        message: "stale lease recovered",
      });
    }
    const resumed: string[] = [];
    const maybeResume = (runId: string) => {
      if (resumed.includes(runId)) return;
      const reset = this.leads.resetStuck(runId);
      const run = this.runs.get(runId);
      if (!run) return;
      const active = ["CREATED", "DISCOVERING", "RESEARCHING", "PERSONALIZING", "WAITING_FOR_AI"].includes(run.status);
      if (active && (reset > 0 || this.leads.hasUnfinishedWork(runId) || this.jobs.pendingCount(runId) > 0)) {
        resumed.push(runId);
        void this.execute(runId).catch((err) => {
          log("error", "resumed run failed", {
            campaignId: runId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };
    for (const runId of touched) maybeResume(runId);
    // Runs with unfinished work but no stale leases (e.g. work died with the
    // process mid-stage) would otherwise sit frozen forever.
    for (const row of this.runs.listResumable()) maybeResume(row.id);
    return resumed;
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

  // Operator-pinned model forwarded verbatim to the runtime, if configured.
  // Tolerant of partial configs (tests): unset or malformed means default.
  private modelOpt(): { providerID: string; modelID: string } | undefined {
    const raw = typeof this.config.OPENCODE_MODEL === "string" ? this.config.OPENCODE_MODEL.trim() : "";
    if (!raw) return undefined;
    const slash = raw.indexOf("/");
    if (slash <= 0 || slash === raw.length - 1) return undefined;
    return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
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
    const leaseUntil = () => new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    this.jobs.start(jobId, leaseUntil());
    const beat = setInterval(() => {
      try {
        this.agents.heartbeat(agentId);
        this.jobs.extendLease(jobId, leaseUntil());
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
      const discovery = new OpenCodeDiscoveryProvider(runtime, {
        timeoutMs: this.config.AI_JOB_TIMEOUT_MS,
        model: this.modelOpt(),
      });
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
    const model = this.modelOpt();
    log("info", "run executing", {
      campaignId: runId,
      provider: this.config.AI_PROVIDER,
      model: model ? `${model.providerID}/${model.modelID}` : "server-default",
    });

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
          model: this.modelOpt(),
        });
        if (ping.sessionId) this.trackSession(ping.sessionId);
        providerReady = ping.ok;
        if (providerReady) break;
      } catch (err) {
        providerReady = false;
        log("warn", "provider probe failed", {
          campaignId: runId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
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
      const draftCounts = this.drafts.countsByStatus(runId);
      const reviewable =
        (draftCounts.NEEDS_REVIEW ?? 0) + (draftCounts.RENDERED ?? 0) + (draftCounts.APPROVED ?? 0);
      // READY_FOR_REVIEW when drafts await humans; incomplete/failed leads
      // never count as ready on their own.
      this.runs.setStatus(
        runId,
        terminalFails > 0 ? "PARTIALLY_COMPLETED" : reviewable > 0 ? "READY_FOR_REVIEW" : "COMPLETED",
      );
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
          model: this.modelOpt(),
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
      this.leads.setStatus(lead.id, "RESEARCHED");
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
          model: this.modelOpt(),
        },
        OutreachSchema,
      );
      if (result.sessionId) this.trackSession(result.sessionId);
      if (!result.ok || !result.data) throw new Error(`personalize failed: ${result.error?.code ?? "unknown"}`);
      await this.storePersonalized(runId, run, lead, result.data.subject, result.data.body, "ai");
      this.events.append({ kind: "email.rendered", campaignRunId: runId, leadId: lead.id });
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

  // Shared render-store-attach path for AI output, human edits, and
  // regeneration. Offer URLs always come from the run row, never the caller.
  private async storePersonalized(
    runId: string,
    run: RunRequest,
    lead: LeadRow,
    subject: string,
    body: string,
    source: "ai" | "human",
  ): Promise<string | null> {
    const offers = run.offerUrls.slice(0, 3);
    const rendered = await renderOutreach({ aiSubject: subject, aiBodyText: body, offers });
    const existing = this.drafts.getByLead(lead.id);
    this.drafts.upsert({
      id: existing?.id ?? randomUUID(),
      leadId: lead.id,
      subject: rendered.subject,
      body,
      templateName: OUTREACH_TEMPLATE_NAME,
      templateVersion: OUTREACH_TEMPLATE_VERSION,
      renderedHtml: rendered.snapshot,
      offerSnapshot: [...run.offerUrls],
      status: DRAFT_STATUS.NEEDS_REVIEW,
    });
    if (source === "human" && existing) {
      this.drafts.updateContent({
        id: existing.id,
        subject: rendered.subject,
        body,
        renderedHtml: rendered.snapshot,
        version: existing.version,
      });
    }
    this.leads.setStatus(lead.id, "PERSONALIZED");
    return await this.attachToContact(runId, lead, rendered.subject, body);
  }

  // Lookup-first contact attach: a crash between contact sync and this update
  // cannot duplicate. Returns the contact id or null when there is no email.
  private async attachToContact(
    runId: string,
    lead: LeadRow,
    subject: string,
    body: string,
  ): Promise<string | null> {
    let contactId = lead.warmbly_contact_id;
    if (!contactId && lead.email) {
      const found = await this.warmbly.lookupContactByEmail(lead.email);
      contactId = found?.id ?? null;
    }
    if (contactId) {
      await this.warmbly.updateContact(contactId, {
        custom_fields: {
          ...(await this.existingCustomFields(contactId)),
          ...mapOutreachToCustomFields(subject, body),
          ai_status: "personalized",
        },
      });
      this.leads.setSynced(lead.id, contactId);
      this.leads.setStatus(lead.id, "SYNCED_TO_WARMBLY");
    }
    return contactId;
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
    const offers = run.offerUrls.slice(0, 3);
    const shell = await renderOutreach({ aiSubject: "AI Outreach", aiBodyText: "Personalized per contact.", offers });
    await this.warmbly.updateStep(run.warmblyCampaignId, step.id, {
      // Name the shell so reruns find and refresh it instead of piling up
      // duplicate steps.
      name: OUTREACH_STEP_NAME,
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
    const draftCounts = this.drafts.countsByStatus(runId);
    const needsReview = (draftCounts.NEEDS_REVIEW ?? 0) + (draftCounts.RENDERED ?? 0);
    const sendMode = this.config.SEND_MODE;
    const emailProvider = (typeof this.config.EMAIL_PROVIDER === "string" ? this.config.EMAIL_PROVIDER : "").trim().toLowerCase() || "none";
    return {
      status: run.status,
      send: { mode: sendMode, email_provider: emailProvider },
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
      drafts: {
        total: Object.values(draftCounts).reduce((n, v) => n + v, 0),
        needs_review: needsReview,
        approved: draftCounts.APPROVED ?? 0,
        rejected: draftCounts.REJECTED ?? 0,
        failed: draftCounts.FAILED ?? 0,
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

  listRunsForCampaign(warmblyCampaignId: string): unknown[] {
    return this.runs.listByWarmblyCampaign(warmblyCampaignId).map((r) => ({
      id: r.id,
      status: r.status,
      business_type: r.business_type,
      location: r.location,
      parallel_agents: r.parallel_agents,
      target_leads: r.target_leads,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  listLeads(runId: string, limit: number, offset: number): unknown[] {    return this.leads.listByRun(runId, limit, offset).map((l) => ({
      id: l.id,
      business_name: l.business_name,
      website: l.website,
      email: l.email,
      status: l.status,
      sync_status: l.sync_status,
      warmbly_contact_id: l.warmbly_contact_id,
    }));
  }

  // Legacy AI rows were stored as RENDERED before the review lifecycle;
  // they mean the same as NEEDS_REVIEW.
  private static reviewStatus(stored: string): string {
    return stored === "RENDERED" ? DRAFT_STATUS.NEEDS_REVIEW : stored;
  }

  private draftShape(draft: DraftRow, lead: LeadRow, offers: string[], research: {
    summary: string;
    painPoints: string[];
    facts: Array<{ claim: string; sourceUrl: string }>;
  } | null) {
    return {
      id: draft.id,
      lead_id: draft.lead_id,
      business_name: lead.business_name,
      email: lead.email,
      website: lead.website,
      location: lead.city ?? lead.country ?? "",
      agent_id: lead.agent_id,
      research_summary: research?.summary ?? "",
      pain_points: research?.painPoints ?? [],
      facts: research?.facts ?? [],
      subject: draft.subject,
      body: draft.body,
      status: BridgeOrchestrator.reviewStatus(draft.status),
      source: draft.source,
      version: draft.version,
      template_name: draft.template_name,
      template_version: draft.template_version,
      rendered_html: draft.rendered_html_snapshot,
      offer_urls: offers,
      updated_at: draft.updated_at,
    };
  }

  private runOffers(runId: string): { run: RunRequest; offers: string[] } {
    const stored = this.runs.get(runId);
    if (!stored) throw new Error("unknown campaign run");
    const offers = [stored.offer_url_1, stored.offer_url_2, stored.offer_url_3].filter(
      (u): u is string => !!u,
    );
    return {
      run: {
        warmblyCampaignId: stored.warmbly_campaign_id,
        businessType: stored.business_type,
        location: stored.location,
        customInstructions: stored.custom_instructions,
        offerUrls: offers,
        parallelAgents: stored.parallel_agents,
        targetLeads: stored.target_leads,
      },
      offers,
    };
  }

  listDrafts(runId: string, limit: number, offset: number): unknown[] {
    this.runOffers(runId);
    return this.drafts.listByRun(runId, limit, offset).map((row) => {
      const lead = this.leads.get(row.lead_id);
      const research = this.research.get(row.lead_id);
      const stored = this.runs.get(runId);
      const offers = [stored?.offer_url_1, stored?.offer_url_2, stored?.offer_url_3].filter(
        (u): u is string => !!u,
      );
      return this.draftShape(
        row,
        lead ?? {
          id: row.lead_id,
          campaign_run_id: runId,
          agent_id: null,
          identity: "",
          business_name: "",
          website: null,
          website_domain: null,
          email: null,
          phone: null,
          address: null,
          city: null,
          country: null,
          source_urls: "[]",
          confidence: 0,
          status: "",
          sync_status: "",
          warmbly_contact_id: null,
          sync_attempts: 0,
          sync_error: null,
          created_at: "",
          updated_at: "",
        },
        offers,
        research
          ? { summary: research.summary, painPoints: research.painPoints as string[], facts: research.facts as Array<{ claim: string; sourceUrl: string }> }
          : null,
      );
    });
  }

  getDraft(draftId: string): unknown {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("draft not found");
    const lead = this.leads.get(draft.lead_id);
    if (!lead) throw new Error("draft not found");
    const { offers } = this.runOffers(lead.campaign_run_id);
    const research = this.research.get(lead.id);
    return this.draftShape(
      draft,
      lead,
      offers,
      research
        ? { summary: research.summary, painPoints: research.painPoints as string[], facts: research.facts as Array<{ claim: string; sourceUrl: string }> }
        : null,
    );
  }

  // Human save: validate, re-render with the run's own offers, persist with
  // optimistic concurrency, refresh Warmbly vars. Offer URLs are never
  // accepted from the caller, so editing cannot alter them.
  async saveDraft(draftId: string, input: { subject: string; body: string; version: number }): Promise<unknown> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("draft not found");
    const lead = this.leads.get(draft.lead_id);
    if (!lead) throw new Error("draft not found");
    const { run } = this.runOffers(lead.campaign_run_id);
    const parsed = OutreachSchema.safeParse({ subject: input.subject, body: input.body });
    if (!parsed.success) {
      throw new Error(`invalid draft: ${parsed.error.issues[0]?.message ?? "rejected"}`);
    }
    const offers = run.offerUrls.slice(0, 3);
    const rendered = await renderOutreach({ aiSubject: parsed.data.subject, aiBodyText: parsed.data.body, offers });
    const saved = this.drafts.updateContent({
      id: draft.id,
      subject: rendered.subject,
      body: parsed.data.body,
      renderedHtml: rendered.snapshot,
      version: input.version,
    });
    if (!saved) {
      const fresh = new Error("draft changed underneath; reload and reapply your edit");
      (fresh as { code?: string }).code = "draft_conflict";
      throw fresh;
    }
    const freshLead = this.leads.get(lead.id);
    if (freshLead) await this.attachToContact(lead.campaign_run_id, freshLead, rendered.subject, parsed.data.body);
    this.events.append({ kind: "draft.saved", campaignRunId: lead.campaign_run_id, leadId: lead.id });
    return this.getDraft(draftId);
  }

  approveDraft(draftId: string): unknown {
    const draft = this.drafts.get(draftId);
    const lead = draft ? this.leads.get(draft.lead_id) : undefined;
    if (!draft || !lead) throw new Error("draft not found");
    // Approval is a local business state only: it never starts, enqueues,
    // or sends anything.
    this.drafts.setStatus(draftId, DRAFT_STATUS.APPROVED);
    this.events.append({ kind: "draft.approved", campaignRunId: lead.campaign_run_id, leadId: draft.lead_id });
    return this.getDraft(draftId);
  }

  rejectDraft(draftId: string): unknown {
    const draft = this.drafts.get(draftId);
    const lead = draft ? this.leads.get(draft.lead_id) : undefined;
    if (!draft || !lead) throw new Error("draft not found");
    this.drafts.setStatus(draftId, DRAFT_STATUS.REJECTED);
    this.events.append({ kind: "draft.rejected", campaignRunId: lead.campaign_run_id, leadId: draft.lead_id });
    return this.getDraft(draftId);
  }

  // Regeneration reuses the exact personalize path (fresh session, same
  // research, no offer URLs) and stores the result as NEEDS_REVIEW.
  async regenerateDraft(draftId: string): Promise<unknown> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("draft not found");
    const lead = this.leads.get(draft.lead_id);
    if (!lead) throw new Error("draft not found");
    const { run } = this.runOffers(lead.campaign_run_id);
    const runtime = this.createRuntime(this.config.AI_PROVIDER);
    try {
      const stored = this.research.get(lead.id);
      const built = buildPersonalizePrompt({
        businessName: lead.business_name,
        website: lead.website ?? "unknown",
        location: run.location,
        businessType: run.businessType,
        researchSummary: stored?.summary ?? "",
        painPoints: (stored?.painPoints as string[] | undefined)?.join("; ") ?? "",
        facts: (stored?.facts as Array<{ claim: string; sourceUrl: string }> | undefined)
          ?.map((f) => `${f.claim} (${f.sourceUrl})`)
          .join("; ") ?? "",
        customInstructions: run.customInstructions,
        maxSubjectChars: 120,
        maxBodyChars: 4000,
      });
      const result = await runtime.executeStructured(
        {
          systemPrompt: built.system,
          prompt: built.text,
          timeoutMs: this.config.AI_JOB_TIMEOUT_MS,
          title: `regenerate:${lead.id}`,
          model: this.modelOpt(),
        },
        OutreachSchema,
      );
      if (result.sessionId) this.trackSession(result.sessionId);
      if (!result.ok || !result.data) throw new Error(`regenerate failed: ${result.error?.code ?? "unknown"}`);
      await this.storePersonalized(lead.campaign_run_id, run, lead, result.data.subject, result.data.body, "ai");
      this.events.append({ kind: "draft.regenerated", campaignRunId: lead.campaign_run_id, leadId: lead.id });
      return this.getDraft(draftId);
    } finally {
      try {
        await runtime.close();
      } catch {
        // Provider close is best effort.
      }
    }
  }

  // Single controlled send. Two production paths, both gated identically:
  // - local: Warmbly-native test-email through an org mailbox into Mailpit.
  //   No enrollment, no start, Warmbly tracking off by Warmbly's design.
  // - live: bridge Brevo transport to one controlled recipient. Only path
  //   available because Warmbly workers speak mailbox providers, never Brevo.
  // Never invokes AI: sending is fully deterministic from stored state.
  async sendDraft(
    draftId: string,
    input: { recipient: string; confirmConsent?: boolean; force?: boolean },
  ): Promise<unknown> {
    const mode = this.config.SEND_MODE;
    if (mode !== "local" && mode !== "live") {
      throw new SendRefused("config", "sending is disabled (SEND_MODE must be local or live)");
    }
    const draft = this.drafts.get(draftId);
    if (!draft) throw new SendRefused("safety", "draft not found");
    if (draft.status !== DRAFT_STATUS.APPROVED) {
      throw new SendRefused("safety", `only approved drafts may be sent (status is ${draft.status})`);
    }
    const recipient = (input.recipient ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      throw new SendRefused("config", "a valid recipient email is required");
    }
    const lead = this.leads.get(draft.lead_id);
    if (!lead) throw new SendRefused("safety", "draft not found");
    const { run } = this.runOffers(lead.campaign_run_id);

    const prior = this.sends.getByDraftVersion(draft.id, draft.version);
    if (prior?.status === SEND_STATUS.SENT) {
      throw new SendRefused("safety", "this draft version was already sent; edit and re-approve to send again");
    }
    if (prior && prior.status !== SEND_STATUS.RETRYABLE) {
      throw new SendRefused("safety", `send already ${prior.status.toLowerCase()}`);
    }
    if (prior?.status === SEND_STATUS.RETRYABLE && !input.force) {
      throw new SendRefused(
        "safety",
        "previous attempt may have been accepted; retry explicitly with force to accept the duplicate risk",
      );
    }

    let suppressed = false;
    try {
      suppressed = await this.warmbly.isSuppressed(recipient);
    } catch (err) {
      throw new SendRefused("config", `suppression check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (suppressed) {
      throw new SendRefused("safety", "recipient is on the workspace suppression list");
    }

    let subscribed: boolean | null = null;
    let contactId: string | null = lead.warmbly_contact_id;
    if (lead.email) {
      try {
        const found = await this.warmbly.lookupContactByEmail(lead.email);
        contactId = found?.id ?? contactId;
      } catch {
        // Lookup failure must not gate a send; subscription below stays unknown.
      }
    }
    if (contactId) {
      try {
        const contact = await this.warmbly.getContact(contactId);
        subscribed = contact.subscribed;
      } catch {
        // Unreadable contact state fails closed below for live sends.
      }
    }
    // AI-discovered contacts carry subscribed=false (no recorded consent).
    // For a live send the operator must explicitly attest consent per send;
    // the attestation is recorded on the send row. Never flipped silently.
    if (mode === "live" && subscribed === false && !input.confirmConsent) {
      throw new SendRefused("safety", "contact has no recorded consent; confirm explicitly to send this one message");
    }

    const idempotencyKey = `send:${draft.id}:v${draft.version}`;
    const sendId = prior?.id ?? randomUUID();
    // createdHere tracks ownership: only the attempt that created the row may
    // resolve it. A gate refusal deletes a self-created row (nothing was
    // attempted); a reused row is left exactly as it was.
    const createdHere = !prior;
    if (createdHere) {
      this.sends.create({
        id: sendId,
        draftId: draft.id,
        version: draft.version,
        idempotencyKey,
        recipient,
        provider: mode === "live" ? "brevo" : "warmbly-test",
      });
    } else if (input.force) {
      this.sends.markForceRetried(sendId);
    }
    this.sends.setStatus(sendId, SEND_STATUS.SENDING);
    this.events.append({ kind: "send.started", campaignRunId: lead.campaign_run_id, leadId: lead.id, message: mode });

    try {
      if (mode === "local") {
        const providerMessageId = await this.sendViaWarmblyTestEmail(run, lead, draft, recipient, contactId);
        this.sends.setStatus(sendId, SEND_STATUS.SENT, undefined, providerMessageId);
      } else {
        const providerMessageId = await this.sendViaBrevo(draft, run, recipient);
        this.sends.setStatus(sendId, SEND_STATUS.SENT, undefined, providerMessageId);
      }
      this.events.append({ kind: "send.succeeded", campaignRunId: lead.campaign_run_id, leadId: lead.id });
      return { send: this.sends.getByDraftVersion(draft.id, draft.version), draft: this.getDraft(draftId) };
    } catch (err) {
      if (err instanceof SendRefused) {
        // Gate refusal: nothing reached any provider, so a self-created row
        // is removed and a reused row is untouched. The refusal is audit-only.
        if (createdHere) this.sends.delete(sendId);
        this.events.append({
          kind: "send.refused",
          campaignRunId: lead.campaign_run_id,
          leadId: lead.id,
          message: err.message.slice(0, 200),
        });
        throw err;
      }
      const retryable = isRetryableSendError(err);
      this.sends.setStatus(
        sendId,
        retryable ? SEND_STATUS.RETRYABLE : SEND_STATUS.FAILED,
        err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      );
      this.events.append({
        kind: "send.failed",
        campaignRunId: lead.campaign_run_id,
        leadId: lead.id,
        message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      throw err;
    }
  }

  // Warmbly-native single send: the prepared AI step rendered for the real
  // contact, mailed through the first org mailbox. Never enrolls, never
  // starts; Warmbly marks it [TEST] with tracking off.
  private async sendViaWarmblyTestEmail(
    run: RunRequest,
    lead: LeadRow,
    draft: DraftRow,
    recipient: string,
    contactId: string | null,
  ): Promise<string> {
    const accounts = await this.warmbly.listAccounts();
    if (accounts.length === 0) throw new SendRefused("config", "no sending mailbox connected in Warmbly");
    const steps = await this.warmbly.listSteps(run.warmblyCampaignId);
    const step = steps.find((s) => s.name === OUTREACH_STEP_NAME) ?? steps[0];
    if (!step) throw new SendRefused("config", "campaign has no prepared step to send");
    const sent = await this.warmbly.sendTestEmail({
      campaignId: run.warmblyCampaignId,
      accountId: accounts[0].id,
      recipient,
      stepId: step.id,
      ...(contactId ? { contactId } : {}),
    });
    return `warmbly-test:${sent.step_id}`;
  }

  // Bridge-direct Brevo send: the APPROVED stored subject/body re-rendered
  // deterministically (no AI) with the run's own offers, then delivered
  // verbatim. Sender is the approved From address, never the SMTP login.
  private async sendViaBrevo(draft: DraftRow, run: RunRequest, recipient: string): Promise<string> {
    const transport = this.getEmailTransport();
    if (!transport || transport.name !== "brevo") {
      throw new SendRefused("config", "live sending requires EMAIL_PROVIDER=brevo");
    }
    const rendered = await renderOutreach({ aiSubject: draft.subject, aiBodyText: draft.body, offers: run.offerUrls.slice(0, 3) });
    const from = typeof (transport as unknown as { defaultFrom?: () => { email: string; name?: string } }).defaultFrom === "function"
      ? (transport as unknown as { defaultFrom: () => { email: string; name?: string } }).defaultFrom()
      : { email: "" };
    if (!from.email) throw new SendRefused("config", "no approved sender address configured");
    const html = rendered.stepHtml.split(AI_BODY_VAR).join(escapeHtml(draft.body));
    const result = await transport.send({
      from,
      to: [{ email: recipient }],
      subject: rendered.subject,
      html,
      text: draft.body,
      headers: { "X-Bridge-Draft": draft.id, "X-Bridge-Run": "send" },
    });
    return result.messageId || `brevo:${draft.id}:v${draft.version}`;
  }

  listSends(draftId: string): unknown[] {
    return this.sends.listByDraft(draftId);
  }
}

// Refusals are terminal operator/safety decisions, never retried.
export class SendRefused extends Error {
  readonly kind: "config" | "safety";
  constructor(kind: "config" | "safety", message: string) {
    super(message);
    this.name = "SendRefused";
    this.kind = kind;
  }
}

function isRetryableSendError(err: unknown): boolean {
  if (err instanceof SendRefused) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "temp" || code === "connection" || code === "timeout") return true;
  const status = (err as { status?: unknown }).status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const message = String((err as { message?: unknown }).message ?? err).toLowerCase();
  return /timeout|timed out|econn|enotfound|eai_again|429|5\d\d|temporar/.test(message);
}

