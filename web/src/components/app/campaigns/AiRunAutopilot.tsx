// AiRunAutopilot — watches the AI bridge run attached to this campaign and
// finishes the job without a manual launch: once discovery, research and
// personalization are done and the campaign is startable, it starts sending
// via Warmbly's own engine (caps, schedule, mailboxes). The bridge only feeds
// leads and per-contact copy, so no draft approval is needed to launch.

import { useEffect, useRef } from "react";
import toast from "react-hot-toast";
import { AlertTriangleIcon, CheckCircle2Icon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useBridgeRuns, useBridgeStatus } from "@/lib/api/hooks/app/bridge/useBridgeReview";
import useStartCampaign from "@/lib/api/hooks/app/campaigns/useStartCampaign";
import { canStartCampaign } from "@/components/app/campaigns/useCampaignActions";
import { checkPermission } from "@/hooks/usePermission";

const ACTIVE_STATUSES = new Set(["CREATED", "DISCOVERING", "RESEARCHING", "PERSONALIZING"]);
const DONE_STATUSES = new Set(["READY_FOR_REVIEW", "PARTIALLY_COMPLETED", "COMPLETED"]);

const RUN_LABEL: Record<string, string> = {
    CREATED: "Queued",
    DISCOVERING: "Finding leads",
    RESEARCHING: "Researching businesses",
    PERSONALIZING: "Writing emails",
    WAITING_FOR_AI: "Waiting for the AI",
    READY_FOR_REVIEW: "Drafts ready",
    PARTIALLY_COMPLETED: "Finished with some gaps",
    COMPLETED: "Finished",
    FAILED: "AI run failed",
    CANCELLED: "AI run cancelled",
};

interface Props {
    campaignId: string;
    campaignStatus: string;
}

export default function AiRunAutopilot({ campaignId, campaignStatus }: Props) {
    const runsQuery = useBridgeRuns(campaignId);
    const runs = runsQuery.data?.runs ?? [];
    // Runs arrive unordered: pick the newest by creation time.
    const latest = runs.length
        ? [...runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
        : null;
    const runActive = !!latest && ACTIVE_STATUSES.has(latest.status);
    const statusQuery = useBridgeStatus(latest?.id ?? null, runActive ? 5000 : false);
    const status = statusQuery.data;
    const startCampaign = useStartCampaign();

    // Launch once per run. The set survives re-renders and polls; a failed
    // start is NOT retried automatically, so a validation error can't turn
    // into a spam loop — the header Start button is the manual fallback.
    const attempted = useRef(new Set<string>());

    useEffect(() => {
        if (!latest || !status) return;
        if (!DONE_STATUSES.has(status.status)) return;
        if (attempted.current.has(latest.id)) return;
        if (!canStartCampaign(campaignStatus)) return;
        attempted.current.add(latest.id);
        // Members without send permission keep the manual header button.
        if (!checkPermission("SEND_CAMPAIGNS")) return;
        startCampaign
            .mutateAsync(campaignId)
            .then(() => toast.success("AI finished drafting — campaign started and sending."))
            .catch((err: unknown) =>
                toast.error(err instanceof Error ? err.message : "Couldn't start the campaign automatically.", {
                    duration: 8000,
                }),
            );
    }, [latest, status, campaignStatus, campaignId, startCampaign]);

    if (!latest) return null;
    // Bridge unreachable: stay quiet rather than flashing an empty banner.
    if (!status && statusQuery.isError) return null;

    const s = status?.status ?? latest.status;
    const label = RUN_LABEL[s] ?? s;
    const leads = status?.leads;
    const detail = leads
        ? `${leads.discovered} found · ${leads.synced} synced · ${status?.drafts.total ?? 0} drafts`
        : `target ${latest.target_leads} leads`;

    const tone =
        s === "FAILED" || s === "CANCELLED"
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : s === "WAITING_FOR_AI"
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : DONE_STATUSES.has(s)
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-sky-200 bg-sky-50 text-sky-700";

    const icon =
        s === "FAILED" || s === "CANCELLED" ? (
            <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0" />
        ) : s === "WAITING_FOR_AI" ? (
            <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0" />
        ) : DONE_STATUSES.has(s) ? (
            <CheckCircle2Icon className="w-3.5 h-3.5 shrink-0" />
        ) : (
            <Loader2Icon className="w-3.5 h-3.5 shrink-0 animate-spin" />
        );

    let hint = "";
    if (s === "WAITING_FOR_AI") hint = "Open Review drafts to continue.";
    else if (DONE_STATUSES.has(s)) {
        if (campaignStatus === "active") hint = "Sending is live.";
        else if (!checkPermission("SEND_CAMPAIGNS")) hint = "Press Start to begin sending.";
        else if (startCampaign.isPending) hint = "Starting sending…";
        else if (attempted.current.has(latest.id)) hint = "Sending starts in a moment…";
    } else if (s === "FAILED") hint = "Check the AI bridge logs, then retry from the AI page.";

    return (
        <div className="shrink-0 px-3 sm:px-5 pt-3">
            <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[11.5px] ${tone}`}>
                {icon}
                <span className="font-medium">AI</span>
                <span className="min-w-0 truncate">{label}</span>
                {detail && <span className="hidden md:inline opacity-80">— {detail}</span>}
                {hint && <span className="ml-auto shrink-0 opacity-80">{hint}</span>}
            </div>
        </div>
    );
}
