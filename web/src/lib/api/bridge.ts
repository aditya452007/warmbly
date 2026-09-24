import { runtimeEnv } from "@/lib/runtimeConfig";

// Local AI bridge (Phase 3/6). No auth: it binds localhost only and the
// bridge itself only accepts dashboard origins. Unavailable bridge surfaces
// as a plain Error the pages render as an empty/error state.
export const BRIDGE_URL = runtimeEnv("BRIDGE_URL", import.meta.env.VITE_BRIDGE_URL, "http://127.0.0.1:8787");

export interface BridgeRun {
    id: string;
    status: string;
    business_type: string;
    location: string;
    parallel_agents: number;
    target_leads: number;
    created_at: string;
    updated_at: string;
}

export interface BridgeDraft {
    id: string;
    lead_id: string;
    business_name: string;
    email: string | null;
    website: string | null;
    location: string;
    agent_id: string | null;
    research_summary: string;
    pain_points: string[];
    facts: Array<{ claim: string; sourceUrl: string }>;
    subject: string;
    body: string;
    status: string;
    source: string;
    version: number;
    template_name: string;
    template_version: string;
    rendered_html: string | null;
    offer_urls: string[];
    updated_at: string;
}

async function bridgeFetch<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${BRIDGE_URL}${path}`, {
            ...init,
            headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        });
    } catch {
        throw new Error("AI bridge is unreachable. Start it and try again.");
    }
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
        throw new Error((data && data.error) || `Bridge request failed (${res.status}).`);
    }
    return data as T;
}

export interface BridgeRunRequest {
    businessType: string;
    location: string;
    customInstructions?: string;
    offerUrls?: string[];
    parallelAgents?: number;
    targetLeads?: number;
}

// Kick off the AI pipeline for a campaign: discovery, research, personalized
// drafts synced into Warmbly, and the AI Outreach step shell. Returns
// immediately; progress arrives via listBridgeRuns / getBridgeStatus.
export function startBridgeRun(warmblyCampaignId: string, input: BridgeRunRequest): Promise<{ runId: string }> {
    return bridgeFetch(`/api/campaigns/${warmblyCampaignId}/run`, {
        method: "POST",
        body: JSON.stringify({
            business_type: input.businessType,
            location: input.location,
            custom_instructions: input.customInstructions ?? "",
            offer_urls: input.offerUrls ?? [],
            ...(input.parallelAgents !== undefined ? { parallel_agents: input.parallelAgents } : {}),
            ...(input.targetLeads !== undefined ? { target_leads: input.targetLeads } : {}),
        }),
    });
}

export function listBridgeRuns(warmblyCampaignId: string): Promise<{ runs: BridgeRun[] }> {
    return bridgeFetch(`/api/warmbly/${warmblyCampaignId}/runs`);
}

export function getBridgeStatus(runId: string): Promise<{
    status: string;
    send: { mode: string; email_provider: string };
    agents: { total: number; running: number; completed: number; failed: number };
    leads: Record<string, number>;
    drafts: { total: number; needs_review: number; approved: number; rejected: number; failed: number };
    errors: number;
}> {
    return bridgeFetch(`/api/campaigns/${runId}/status`);
}

export function listBridgeDrafts(runId: string): Promise<{ drafts: BridgeDraft[] }> {
    return bridgeFetch(`/api/campaigns/${runId}/drafts?limit=200`);
}

export function getBridgeDraft(draftId: string): Promise<{ draft: BridgeDraft }> {
    return bridgeFetch(`/api/drafts/${draftId}`);
}

export function getBridgePreview(draftId: string): Promise<{ subject: string; html: string }> {
    return bridgeFetch(`/api/drafts/${draftId}/preview`);
}

export function saveBridgeDraft(
    draftId: string,
    input: { subject: string; body: string; version: number },
): Promise<{ draft: BridgeDraft }> {
    return bridgeFetch(`/api/drafts/${draftId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function approveBridgeDraft(draftId: string): Promise<{ draft: BridgeDraft }> {
    return bridgeFetch(`/api/drafts/${draftId}/approve`, { method: "POST" });
}

export function rejectBridgeDraft(draftId: string): Promise<{ draft: BridgeDraft }> {
    return bridgeFetch(`/api/drafts/${draftId}/reject`, { method: "POST" });
}

export function regenerateBridgeDraft(draftId: string): Promise<{ draft: BridgeDraft }> {
    return bridgeFetch(`/api/drafts/${draftId}/regenerate`, { method: "POST" });
}

export interface BridgeSend {
    id: string;
    draft_id: string;
    draft_version: number;
    recipient: string;
    status: string;
    provider: string;
    provider_message_id: string | null;
    error_message: string | null;
}

export function sendBridgeDraft(
    draftId: string,
    input: { recipient: string; confirmConsent?: boolean; force?: boolean },
): Promise<{ send: BridgeSend; draft: BridgeDraft }> {
    return bridgeFetch(`/api/drafts/${draftId}/send`, { method: "POST", body: JSON.stringify(input) });
}

export interface BridgeSendQueue {
    id: string;
    run_id: string;
    status: string;
    daily_limit: number;
    timezone: string;
    concurrency: number;
    consent_attested: number;
    followup_enabled: number;
    followup_days: string;
    followup_require_approval: number;
    max_live_sends: number;
}

export interface BridgeQueuePreview {
    recipients: number;
    approvedDrafts: number;
    dailyLimit: number;
    sender: string;
    mode: string;
    provider: string;
    followupBehavior: string;
    timezone: string;
}

export interface BridgeQueueMetrics {
    status: string;
    queued: number;
    sending: number;
    sent: number;
    failed: number;
    blocked: number;
    sent_today: number;
    remaining_today: number;
    daily_limit: number;
    timezone: string;
    followups: Array<{ seq: number; day_offset: number; pending: number; sent: number; blocked: number }>;
}

export interface BridgeFollowup {
    id: string;
    queue_id: string;
    lead_id: string;
    parent_draft_id: string;
    seq: number;
    subject: string;
    body: string;
    status: string;
    version: number;
}

export function createSendQueue(
    runId: string,
    input: { dailyLimit?: number; timezone?: string; concurrency?: number; followupDays?: number[]; followupRequireApproval?: boolean; maxLiveSends?: number } = {},
): Promise<{ queue: BridgeSendQueue }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue`, { method: "POST", body: JSON.stringify(input) });
}

export function previewSendQueue(runId: string): Promise<{ preview: BridgeQueuePreview }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/preview`);
}

export function startSendQueue(
    runId: string,
    input: { confirmed: boolean; consentAttested: boolean },
): Promise<{ queue: BridgeSendQueue; enqueued: number }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/start`, { method: "POST", body: JSON.stringify(input) });
}

export function pauseSendQueue(runId: string): Promise<{ queue: BridgeSendQueue }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/pause`, { method: "POST" });
}

export function resumeSendQueue(runId: string): Promise<{ queue: BridgeSendQueue }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/resume`, { method: "POST" });
}

export function cancelSendQueue(runId: string): Promise<{ queue: BridgeSendQueue }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/cancel`, { method: "POST" });
}

export function getSendQueueMetrics(runId: string): Promise<{ metrics: BridgeQueueMetrics }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue`);
}

export function listSendQueueFollowups(runId: string): Promise<{ followups: BridgeFollowup[] }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/followups?limit=200`);
}

export function approveFollowup(followupId: string): Promise<{ followup: BridgeFollowup }> {
    return bridgeFetch(`/api/followups/${followupId}/approve`, { method: "POST" });
}

export function rejectFollowup(followupId: string): Promise<{ followup: BridgeFollowup }> {
    return bridgeFetch(`/api/followups/${followupId}/reject`, { method: "POST" });
}

export interface BridgeReply {
    id: string;
    lead_id: string;
    from_email: string;
    subject: string;
    body_text: string;
    received_at: string | null;
    process_state: string;
    source: string;
    error_message: string | null;
    analysis_intent: string | null;
    analysis_confidence: number | null;
    analysis_summary: string | null;
    analysis_action: string | null;
    requires_response: number | null;
    analyzed_at: string | null;
}

export interface BridgeResponse {
    id: string;
    lead_id: string;
    reply_id: string;
    subject: string;
    body: string;
    status: string;
    version: number;
}

export function pollQueueReplies(runId: string): Promise<{ poll: { ingested: number; analyzed: number; errors: number } }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/poll-replies`, { method: "POST" });
}

export function listQueueReplies(runId: string): Promise<{ replies: BridgeReply[]; metrics: { replies: number; analyzed: number; intents: Record<string, number> } }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/replies?limit=200`);
}

export function listQueueResponses(runId: string): Promise<{ responses: BridgeResponse[] }> {
    return bridgeFetch(`/api/campaigns/${runId}/send-queue/responses?limit=200`);
}

export function analyzeReply(replyId: string, force = false): Promise<{ reply: BridgeReply }> {
    return bridgeFetch(`/api/replies/${replyId}/analyze`, { method: "POST", body: JSON.stringify({ force }) });
}

export function draftResponse(replyId: string, instruction = ""): Promise<{ response: BridgeResponse }> {
    return bridgeFetch(`/api/replies/${replyId}/draft-response`, { method: "POST", body: JSON.stringify({ instruction }) });
}

export function approveResponse(responseId: string): Promise<{ response: BridgeResponse }> {
    return bridgeFetch(`/api/responses/${responseId}/approve`, { method: "POST" });
}

export function sendResponse(responseId: string): Promise<{ response: BridgeResponse }> {
    return bridgeFetch(`/api/responses/${responseId}/send`, { method: "POST" });
}

export interface BridgeReplyWorkerStatus {
    enabled: boolean;
    state: "STOPPED" | "RUNNING" | "ERROR";
    connected: boolean;
    lastTickAt: string | null;
    lastError: string | null;
    claimable: number;
    analyzing: number;
    awaitingApproval: number;
    failed: number;
    ambiguous: number;
    processedTotal: number;
    failureTotal: number;
}

export function getReplyWorkerStatus(): Promise<{ status: BridgeReplyWorkerStatus }> {
    return bridgeFetch(`/api/reply-worker/status`);
}

export function rejectResponse(responseId: string): Promise<{ response: BridgeResponse }> {
    return bridgeFetch(`/api/responses/${responseId}/reject`, { method: "POST" });
}
