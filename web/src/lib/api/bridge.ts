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

export function listBridgeRuns(warmblyCampaignId: string): Promise<{ runs: BridgeRun[] }> {
    return bridgeFetch(`/api/warmbly/${warmblyCampaignId}/runs`);
}

export function getBridgeStatus(runId: string): Promise<{
    status: string;
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
