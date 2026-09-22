// Bulk sending panel: bounded, paced delivery of APPROVED drafts with
// deterministic follow-ups. Queue creation is inert; only an explicit
// confirmed + consent-attested start enqueues and pumps.

import React from "react";
import toast from "react-hot-toast";
import { Loader2Icon } from "lucide-react";
import { PageBody, SectionBar, Stat, StatStrip } from "@/components/layout/Page";
import { useConfirm } from "@/hooks/context/confirm";
import {
    useApproveFollowup,
    useCancelSendQueue,
    useCreateSendQueue,
    usePauseSendQueue,
    useRejectFollowup,
    useResumeSendQueue,
    useSendQueueFollowups,
    useSendQueueMetrics,
    useSendQueuePreview,
    useStartSendQueue,
} from "@/lib/api/hooks/app/bridge/useBridgeReview";

export default function BulkSendPanel({ runId }: { runId: string }) {
    const confirm = useConfirm();
    const metricsQuery = useSendQueueMetrics(runId, 10_000);
    const metrics = metricsQuery.data?.metrics;
    const queueMissing =
        metricsQuery.isError && (metricsQuery.error as Error | null)?.message === "no send queue";

    const create = useCreateSendQueue();
    const start = useStartSendQueue();
    const pause = usePauseSendQueue();
    const resume = useResumeSendQueue();
    const cancel = useCancelSendQueue();
    const approveFu = useApproveFollowup();
    const rejectFu = useRejectFollowup();

    const [wantStart, setWantStart] = React.useState(false);
    const [confirmed, setConfirmed] = React.useState(false);
    const [attested, setAttested] = React.useState(false);
    const previewQuery = useSendQueuePreview(runId, wantStart && !queueMissing);
    const preview = previewQuery.data?.preview;
    const followupsQuery = useSendQueueFollowups(runId);
    const pendingFollowups = (followupsQuery.data?.followups ?? []).filter((f) => f.status === "NEEDS_REVIEW");

    async function runMutation(fn: () => Promise<unknown>, ok: string) {
        try {
            await fn();
            toast.success(ok);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Bulk action failed.");
        }
    }

    return (
        <>
            <SectionBar label="Bulk sending" count={metrics ? metrics.sent : undefined} />
            <PageBody>
                {metricsQuery.isPending ? (
                    <p className="px-5 py-4 text-[12.5px] text-slate-500">Loading send queue…</p>
                ) : queueMissing ? (
                    <div className="px-5 py-4 flex items-center gap-3">
                        <p className="text-[12.5px] text-slate-500">
                            No send queue yet. Preparing one changes nothing until you explicitly start it.
                        </p>
                        <button
                            type="button"
                            onClick={() => runMutation(() => create.mutateAsync(runId), "Send queue prepared")}
                            disabled={create.isPending}
                            className="h-7 px-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[12px] font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
                        >
                            {create.isPending && <Loader2Icon className="w-3 h-3 animate-spin" />}
                            Prepare queue
                        </button>
                    </div>
                ) : !metrics ? (
                    <p className="px-5 py-4 text-[12.5px] text-slate-500">Send queue unavailable.</p>
                ) : metrics.status === "DRAFT" && !wantStart ? (
                    <div className="px-5 py-4 flex items-center gap-3">
                        <p className="text-[12.5px] text-slate-500">
                            Queue prepared. Review the preview, then start explicitly. Approvals alone never send.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                setConfirmed(false);
                                setAttested(false);
                                setWantStart(true);
                            }}
                            className="h-7 px-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[12px] font-medium"
                        >
                            Review to start
                        </button>
                    </div>
                ) : metrics.status === "DRAFT" ? (
                    <div className="px-5 py-4 space-y-3">
                        {previewQuery.isPending ? (
                            <p className="text-[12.5px] text-slate-500">Loading preview…</p>
                        ) : previewQuery.isError || !preview ? (
                            <p className="text-[12.5px] text-slate-500">Couldn't load the send preview.</p>
                        ) : (
                            <dl className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[12px]">
                                <div><dt className="text-slate-400 uppercase tracking-[0.1em] text-[10px]">Recipients</dt><dd className="text-slate-900 font-medium">{preview.recipients}</dd></div>
                                <div><dt className="text-slate-400 uppercase tracking-[0.1em] text-[10px]">Daily limit</dt><dd className="text-slate-900 font-medium">{preview.dailyLimit}</dd></div>
                                <div><dt className="text-slate-400 uppercase tracking-[0.1em] text-[10px]">Sender</dt><dd className="text-slate-900 font-medium truncate">{preview.sender}</dd></div>
                                <div><dt className="text-slate-400 uppercase tracking-[0.1em] text-[10px]">Mode</dt><dd className="text-slate-900 font-medium">{preview.mode} / {preview.provider}</dd></div>
                                <div><dt className="text-slate-400 uppercase tracking-[0.1em] text-[10px]">Follow-ups</dt><dd className="text-slate-900 font-medium">{preview.followupBehavior}</dd></div>
                                <div><dt className="text-slate-400 uppercase tracking-[0.1em] text-[10px]">Timezone</dt><dd className="text-slate-900 font-medium">{preview.timezone}</dd></div>
                            </dl>
                        )}
                        <label className="flex items-center gap-2 text-[12.5px] text-slate-700">
                            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="size-3.5 accent-sky-600" />
                            I reviewed the recipients, sender, mode, and follow-up behavior above.
                        </label>
                        <label className="flex items-center gap-2 text-[12.5px] text-slate-700">
                            <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="size-3.5 accent-sky-600" />
                            I attest we are authorized to email these recipients (campaign-level consent).
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                disabled={!confirmed || !attested || start.isPending}
                                onClick={() => {
                                    confirm?.show(`Start bulk sending to ${preview?.recipients ?? 0} recipients?`, () =>
                                        runMutation(
                                            () => start.mutateAsync({ runId, confirmed: true, consentAttested: true }).then(() => setWantStart(false)),
                                            "Bulk sending started",
                                        ),
                                    );
                                }}
                                className="h-7 px-2.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium disabled:opacity-50"
                            >
                                Start sending
                            </button>
                            <button type="button" onClick={() => setWantStart(false)} className="h-7 px-2 text-[12px] text-slate-500 hover:text-slate-700 font-medium">
                                Back
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <StatStrip cols={4}>
                            <Stat label="Queued" value={metrics.queued} sub={`sending ${metrics.sending}`} />
                            <Stat label="Sent" value={metrics.sent} sub={`today ${metrics.sent_today}`} accent={metrics.sent > 0} />
                            <Stat label="Remaining today" value={metrics.remaining_today} sub={`limit ${metrics.daily_limit}`} />
                            <Stat label="Blocked / failed" value={metrics.blocked + metrics.failed} sub={metrics.status} last />
                        </StatStrip>
                        {(metrics.status === "ACTIVE" || metrics.status === "PAUSED") && (
                            <div className="px-5 flex items-center gap-2">
                                {metrics.status === "ACTIVE" ? (
                                    <button
                                        type="button"
                                        onClick={() => runMutation(() => pause.mutateAsync(runId), "Sending paused")}
                                        disabled={pause.isPending}
                                        className="h-7 px-2.5 rounded-md border border-slate-300 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
                                    >
                                        Pause
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => runMutation(() => resume.mutateAsync(runId), "Sending resumed")}
                                        disabled={resume.isPending}
                                        className="h-7 px-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[12px] font-medium"
                                    >
                                        Resume
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => {
                                        confirm?.show("Cancel bulk sending? Queued items stop; sent history stays.", () =>
                                            runMutation(() => cancel.mutateAsync(runId), "Bulk sending cancelled"),
                                        );
                                    }}
                                    disabled={cancel.isPending}
                                    className="h-7 px-2.5 rounded-md border border-red-200 text-[12px] font-medium text-red-600 hover:bg-red-50"
                                >
                                    Cancel
                                </button>
                                <span className="text-[11.5px] text-slate-400">
                                    {(metrics.followups ?? []).map((f) => `Follow-up #${f.seq}: ${f.sent} sent, ${f.pending} pending, ${f.blocked} blocked`).join(" · ")}
                                </span>
                            </div>
                        )}
                        {pendingFollowups.length > 0 && (
                            <div className="px-5 space-y-1.5">
                                <p className="text-[10px] uppercase tracking-[0.14em] text-slate-400">Follow-ups awaiting approval</p>
                                {pendingFollowups.map((f) => (
                                    <div key={f.id} className="flex items-center gap-2 text-[12.5px]">
                                        <span className="text-slate-900 font-medium truncate">#{f.seq} {f.subject || "(generating…)"}</span>
                                        <button
                                            type="button"
                                            onClick={() => runMutation(() => approveFu.mutateAsync(f.id), "Follow-up approved")}
                                            className="h-6 px-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11.5px] font-medium"
                                        >
                                            Approve
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => runMutation(() => rejectFu.mutateAsync(f.id), "Follow-up rejected")}
                                            className="h-6 px-2 rounded-md border border-slate-300 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50"
                                        >
                                            Reject
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </PageBody>
        </>
    );
}
