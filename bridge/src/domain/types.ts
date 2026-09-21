// Domain status vocabularies and record shapes. Statuses are typed unions;
// the store layer persists them as TEXT and revalidates on read.

export const CAMPAIGN_RUN_STATUS = [
  "CREATED",
  "DISCOVERING",
  "RESEARCHING",
  "PERSONALIZING",
  "READY",
  "PAUSED",
  "PARTIALLY_COMPLETED",
  "COMPLETED",
  "WAITING_FOR_AI",
  "FAILED",
  "CANCELLED",
] as const;
export type CampaignRunStatus = (typeof CAMPAIGN_RUN_STATUS)[number];

export const LEAD_STATUS = [
  "DISCOVERED",
  "RESEARCHING",
  "RESEARCHED",
  "QUALIFIED",
  "REJECTED",
  "PERSONALIZING",
  "PERSONALIZED",
  "RENDERED",
  "SYNCED_TO_WARMBLY",
  "FAILED",
] as const;
export type LeadStatus = (typeof LEAD_STATUS)[number];

export const JOB_STATUS = ["QUEUED", "RUNNING", "SUCCEEDED", "RETRYABLE", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const AGENT_RUN_STATUS = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUS)[number];

export type SyncStatus = "pending" | "synced" | "failed";

export interface RunRequest {
  warmblyCampaignId: string;
  businessType: string;
  location: string;
  customInstructions: string;
  offerUrls: string[];
  parallelAgents: number;
  targetLeads: number;
}

export interface Lane {
  id: string;
  label: string;
  guidance: string;
}

export interface RawLead {
  businessName: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  sourceUrls: string[];
  confidence: number;
}

export interface Research {
  summary: string;
  painPoints: string[];
  facts: Array<{ claim: string; sourceUrl: string }>;
}

export interface Outreach {
  subject: string;
  body: string;
}

// Domain result of one isolated AI execution. Carries data or a coded
// failure; never provider SDK types, never raw provider output on failure.
export interface AiTaskResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  sessionId: string;
  durationMs: number;
  promptVersion: string;
}
