// The AI outreach loop on the dashboard.
//
// Everything above this section is campaign-volume shaped; the actionable
// half of this workspace's loop — replies coming back and AI drafts waiting
// on a human — lived two clicks deep inside the AI campaign screen. One row
// of counters plus worker health, straight from the bridge; when the bridge
// is offline the section quietly renders nothing rather than zeros that
// would read as "quiet".

import { Link } from "react-router-dom";
import { ChevronRightIcon } from "lucide-react";

import { EmptyBlock, SectionBar, Stat, StatStrip } from "@/components/layout/Page";
import { useReplyWorkerStatus } from "@/lib/api/hooks/app/bridge/useBridgeReview";

function num(v: number | undefined): string {
    return (v ?? 0).toLocaleString();
}

export default function AiRepliesSection() {
    const q = useReplyWorkerStatus(30_000);

    // Bridge unreachable: the loop still exists, its counters are just not
    // visible from here. Silence beats a fake zero row.
    if (q.isError) return null;

    const s = q.data?.status;
    if (!s) {
        return (
            <>
                <SectionBar label="AI replies" />
                <div className="px-5 py-4 border-b border-slate-200">
                    <div className="h-11 rounded-md bg-slate-50 animate-pulse" />
                </div>
            </>
        );
    }

    const attention = s.failed + s.ambiguous;
    const idle =
        s.enabled &&
        s.awaitingApproval === 0 &&
        s.claimable === 0 &&
        s.analyzing === 0 &&
        attention === 0 &&
        s.processedTotal === 0;

    const healthTone =
        s.state === "RUNNING" ? (s.connected ? "text-emerald-600" : "text-amber-600") : "text-rose-600";
    const healthDot =
        s.state === "RUNNING" ? (s.connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500") : "bg-rose-500";
    const healthLabel =
        s.state === "STOPPED"
            ? s.enabled
                ? "Worker stopped"
                : "Worker off"
            : s.state === "ERROR"
                ? "Worker error"
                : s.connected
                    ? "Syncing"
                    : "Waiting for Warmbly";
    const healthTitle = `Reply worker ${s.state.toLowerCase()}${s.enabled ? "" : " · disabled in bridge config"} · last tick ${
        s.lastTickAt ? new Date(s.lastTickAt).toLocaleString() : "never"
    }`;

    return (
        <>
            <SectionBar label="AI replies">
                <span className={`inline-flex items-center gap-1.5 text-[11px] ${healthTone}`} title={healthTitle}>
                    <span className={`size-1.5 rounded-full ${healthDot}`} aria-hidden />
                    {healthLabel}
                </span>
                <Link
                    to="/app/campaigns/ai"
                    className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-900 transition-colors"
                >
                    Open review
                    <ChevronRightIcon className="w-3 h-3" />
                </Link>
            </SectionBar>

            {idle ? (
                <EmptyBlock
                    title="No replies yet"
                    body="When prospects answer, replies are analyzed here and AI drafts queue for your approval before anything sends."
                />
            ) : (
                <StatStrip cols={4}>
                    <Stat
                        label="Awaiting approval"
                        value={num(s.awaitingApproval)}
                        sub="AI drafts need you"
                        accent={s.awaitingApproval > 0}
                    />
                    <Stat label="To analyze" value={num(s.claimable)} sub="replies queued" />
                    <Stat label="Analyzing now" value={num(s.analyzing)} sub="on the worker" />
                    <Stat label="Needs attention" value={num(attention)} sub="failed or ambiguous" last />
                </StatStrip>
            )}
        </>
    );
}
