// AI draft review: per-lead research, editable subject/body, sandboxed HTML
// preview, save, regenerate, approve/reject. Review-only: nothing here can
// start a campaign or send an email.

import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { CheckIcon, Loader2Icon } from "lucide-react";
import {
    EmptyBlock,
    Page,
    PageBody,
    PageTopbar,
    SectionBar,
    Stat,
    StatStrip,
    TopbarAction,
} from "@/components/layout/Page";
import { useConfirm } from "@/hooks/context/confirm";
import {
    useApproveBridgeDraft,
    useBridgeDrafts,
    useBridgeRuns,
    useBridgeStatus,
} from "@/lib/api/hooks/app/bridge/useBridgeReview";
import type { BridgeDraft } from "@/lib/api/bridge";
import { cn } from "@/lib/utils";
import ReviewDrawer, { draftLabel, draftTone } from "./ReviewDrawer";
import BulkSendPanel from "./BulkSendPanel";
import RepliesPanel from "./RepliesPanel";

export default function AIReviewPage() {
    const [params] = useSearchParams();
    const warmblyCampaignId = params.get("campaign");
    const runParam = params.get("run");
    const confirm = useConfirm();

    const runsQuery = useBridgeRuns(warmblyCampaignId);
    const runs = runsQuery.data?.runs ?? [];
    const runId = runParam ?? runs[0]?.id ?? null;

    const statusQuery = useBridgeStatus(runId);
    const draftsQuery = useBridgeDrafts(runId);
    const drafts = (draftsQuery.data?.drafts ?? []) as BridgeDraft[];
    const [openDraftId, setOpenDraftId] = React.useState<string | null>(null);
    const [selected, setSelected] = React.useState<string[]>([]);
    const approve = useApproveBridgeDraft();

    const visibleIds = React.useMemo(() => new Set(drafts.map((d) => d.id)), [drafts]);
    React.useEffect(() => {
        setSelected((prev) => prev.filter((id) => visibleIds.has(id)));
    }, [visibleIds]);

    const counts = statusQuery.data?.drafts;

    async function approveSelected() {
        if (selected.length === 0) return;
        let ok = 0;
        for (const id of selected) {
            try {
                await approve.mutateAsync(id);
                ok++;
            } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't approve a draft.");
                break;
            }
        }
        if (ok > 0) toast.success(ok === 1 ? "Draft approved" : `${ok} drafts approved`);
        setSelected([]);
    }

    function toggle(id: string) {
        setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    }

    const allSelected = drafts.length > 0 && selected.length === drafts.length;

    return (
        <Page>
            <PageTopbar
                eyebrow="AI Review"
                subtitle={
                    statusQuery.data
                        ? `${statusQuery.data.status.replace(/_/g, " ").toLowerCase()}`
                        : runsQuery.isPending
                            ? "Loading…"
                            : "Review AI drafts"
                }
            >
                <TopbarAction variant="ghost" href="/app/campaigns/ai">
                    Back to AI Campaign
                </TopbarAction>
            </PageTopbar>

            {!warmblyCampaignId && !runParam ? (
                <PageBody>
                    <EmptyBlock
                        title="No campaign selected"
                        body="Open review from an AI campaign run, or pass ?campaign=<id> / ?run=<id>."
                        cta={
                            <TopbarAction variant="ghost" href="/app/campaigns">
                                Campaigns
                            </TopbarAction>
                        }
                    />
                </PageBody>
            ) : runsQuery.isError ? (
                <PageBody>
                    <EmptyBlock
                        title="AI bridge is unreachable"
                        body="Start the bridge on its localhost port and try again."
                        cta={
                            <TopbarAction variant="ghost" onClick={() => runsQuery.refetch()}>
                                Try again
                            </TopbarAction>
                        }
                    />
                </PageBody>
            ) : runsQuery.isPending ? (
                <PageBody>
                    <p className="px-5 py-8 text-[12.5px] text-slate-500">Loading runs…</p>
                </PageBody>
            ) : !runId ? (
                <PageBody>
                    <EmptyBlock
                        title="No AI runs yet"
                        body="Run the AI bridge against this campaign first; drafts appear here for review."
                    />
                </PageBody>
            ) : (
                <>
                    <StatStrip cols={4}>
                        <Stat label="Leads" value={drafts.length} sub="drafts" />
                        <Stat label="Needs review" value={counts?.needs_review ?? 0} sub="to review" />
                        <Stat label="Approved" value={counts?.approved ?? 0} sub="ready later" accent={(counts?.approved ?? 0) > 0} />
                        <Stat label="Failed" value={counts?.failed ?? 0} sub="see errors" last />
                    </StatStrip>

                    {runId && <BulkSendPanel runId={runId} />}

                    {runId && <RepliesPanel runId={runId} />}

                    <SectionBar label="Drafts" count={drafts.length} />
                    <PageBody>
                        {draftsQuery.isPending ? (
                            <p className="px-5 py-8 text-[12.5px] text-slate-500">Loading drafts…</p>
                        ) : draftsQuery.isError ? (
                            <EmptyBlock
                                title="Couldn't load drafts"
                                body="The bridge may have restarted. Try again."
                                cta={
                                    <TopbarAction variant="ghost" onClick={() => draftsQuery.refetch()}>
                                        Try again
                                    </TopbarAction>
                                }
                            />
                        ) : drafts.length === 0 ? (
                            <EmptyBlock
                                title="No drafts yet"
                                body="Drafts appear here once discovery and personalization produce them."
                            />
                        ) : (
                            <div className="divide-y divide-slate-200/60 pb-20">
                                <label className="h-9 px-5 flex items-center gap-3 text-[11.5px] text-slate-500">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        onChange={() => setSelected(allSelected ? [] : drafts.map((d) => d.id))}
                                        aria-label="Select all drafts"
                                        className="size-3.5 accent-sky-600"
                                    />
                                    Select all
                                </label>
                                {drafts.map((d) => (
                                    <div
                                        key={d.id}
                                        className="group min-h-11 px-5 py-1.5 flex items-center gap-3 hover:bg-slate-50 transition-colors"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selected.includes(d.id)}
                                            onChange={() => toggle(d.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            aria-label={`Select draft for ${d.business_name}`}
                                            className="size-3.5 accent-sky-600 shrink-0"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setOpenDraftId(d.id)}
                                            className="flex-1 min-w-0 flex items-center gap-3 text-left"
                                        >
                                            <span className="text-[12.5px] text-slate-900 font-medium truncate max-w-[40%]">
                                                {d.business_name || "Untitled lead"}
                                            </span>
                                            <span className="text-[11.5px] text-slate-400 truncate hidden md:inline">
                                                {d.subject || "No subject yet"}
                                            </span>
                                            <span className={cn("ml-auto text-[10px] uppercase tracking-[0.1em] font-medium shrink-0", draftTone(d.status))}>
                                                {draftLabel(d.status)}
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setOpenDraftId(d.id)}
                                            className="text-[12px] text-sky-600 hover:text-sky-700 font-medium shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                                        >
                                            Review
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </PageBody>

                    {selected.length > 0 && (
                        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-2.5 pl-4 pr-2.5 py-2 rounded-lg bg-slate-900 text-white shadow-xl">
                            <span className="text-[12px] font-medium whitespace-nowrap">
                                {selected.length} selected
                            </span>
                            <button
                                type="button"
                                onClick={() => {
                                    confirm?.show(`Approve ${selected.length} draft${selected.length === 1 ? "" : "s"}?`, approveSelected);
                                }}
                                disabled={approve.isPending}
                                className="h-7 px-2.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-60"
                            >
                                {approve.isPending ? (
                                    <Loader2Icon className="w-3 h-3 animate-spin" />
                                ) : (
                                    <CheckIcon className="w-3 h-3" />
                                )}
                                Approve selected
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelected([])}
                                className="h-7 px-2 text-slate-300 hover:text-white text-[12px] font-medium"
                            >
                                Clear
                            </button>
                        </div>
                    )}

                    {openDraftId && (
                        <ReviewDrawer
                            draftId={openDraftId}
                            onClose={() => setOpenDraftId(null)}
                            sendMode={String(statusQuery.data?.send?.mode ?? "disabled")}
                        />
                    )}
                    <p className="px-5 py-3 text-[11px] text-slate-400">
                        Approval only marks drafts ready for a future send. Nothing here starts a campaign or sends email.{" "}
                        <Link to="/app/campaigns" className="text-sky-600 hover:text-sky-700">
                            Campaigns
                        </Link>
                    </p>
                </>
            )}
        </Page>
    );
}
