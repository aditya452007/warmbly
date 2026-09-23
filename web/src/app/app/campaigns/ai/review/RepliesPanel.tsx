// Replies panel: inbound replies matched to bridge-sent threads, OpenCode
// intent analysis, and human-gated responses. Analysis is automatic;
// drafting and sending always need an explicit human action.

import React from "react";
import toast from "react-hot-toast";
import { Loader2Icon } from "lucide-react";
import { PageBody, SectionBar } from "@/components/layout/Page";
import { useConfirm } from "@/hooks/context/confirm";
import {
    useAnalyzeReply,
    useApproveResponse,
    useDraftResponse,
    usePollQueueReplies,
    useQueueReplies,
    useQueueResponses,
    useRejectResponse,
    useReplyWorkerStatus,
    useSendResponse,
} from "@/lib/api/hooks/app/bridge/useBridgeReview";
import type { BridgeReply, BridgeResponse } from "@/lib/api/bridge";
import { cn } from "@/lib/utils";

function intentTone(intent: string | null): string {
    switch (intent) {
        case "INTERESTED":
            return "text-emerald-600";
        case "QUESTION":
            return "text-amber-600";
        case "OBJECTION":
        case "NOT_INTERESTED":
        case "UNSUBSCRIBE":
            return "text-red-600";
        case "WRONG_PERSON":
        case "AUTO_REPLY":
            return "text-slate-400";
        case "OTHER":
            return "text-slate-500";
        default:
            return "text-slate-400";
    }
}

function stateTone(state: string): string {
    switch (state) {
        case "ANALYZED":
            return "text-emerald-600";
        case "AMBIGUOUS":
        case "FAILED":
            return "text-red-600";
        case "RETRYABLE":
        case "ANALYZING":
            return "text-amber-600";
        default:
            return "text-slate-400";
    }
}

export default function RepliesPanel({ runId }: { runId: string }) {
    const confirm = useConfirm();
    const repliesQuery = useQueueReplies(runId);
    const responsesQuery = useQueueResponses(runId);
    const workerQuery = useReplyWorkerStatus(30_000);
    const replies = (repliesQuery.data?.replies ?? []) as BridgeReply[];
    const metrics = repliesQuery.data?.metrics;
    const worker = workerQuery.data?.status;
    const responsesData = responsesQuery.data?.responses;
    const responseByReply = React.useMemo(
        () => new Map((responsesData ?? [] as BridgeResponse[]).map((r) => [r.reply_id, r])),
        [responsesData],
    );

    const poll = usePollQueueReplies();
    const analyze = useAnalyzeReply();
    const draft = useDraftResponse();
    const approve = useApproveResponse();
    const send = useSendResponse();
    const reject = useRejectResponse();

    const [instructionFor, setInstructionFor] = React.useState<string | null>(null);
    const [instruction, setInstruction] = React.useState("");

    async function runMutation(fn: () => Promise<unknown>, ok: string) {
        try {
            await fn();
            toast.success(ok);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Reply action failed.");
        }
    }

    return (
        <>
            <SectionBar label="Replies" count={metrics?.replies} />
            <PageBody>
                {worker && (
                    <div className="px-5 py-2 flex items-center gap-3 border-b border-slate-200/60 text-[11.5px] text-slate-500">
                        <span className={cn("inline-flex items-center gap-1 font-medium", worker.connected ? "text-emerald-600" : worker.state === "ERROR" ? "text-red-600" : "text-slate-400")}>
                            <span className={cn("w-1.5 h-1.5 rounded-full", worker.connected ? "bg-emerald-500" : worker.state === "ERROR" ? "bg-red-500" : "bg-slate-300")} />
                            Inbox worker: {worker.enabled ? (worker.state === "RUNNING" ? "connected" : worker.state.toLowerCase()) : "disabled"}
                        </span>
                        {worker.lastTickAt && <span>last sync {new Date(worker.lastTickAt).toLocaleTimeString()}</span>}
                        <span className="ml-auto">
                            {worker.claimable} pending · {worker.analyzing} analyzing · {worker.awaitingApproval} awaiting approval{worker.ambiguous > 0 ? ` · ${worker.ambiguous} ambiguous` : ""}{worker.failed > 0 ? ` · ${worker.failed} failed` : ""}
                        </span>
                    </div>
                )}
                <div className="px-5 py-3 flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => runMutation(() => poll.mutateAsync(runId), "Reply check done")}
                        disabled={poll.isPending}
                        className="h-7 px-2.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[12px] font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
                    >
                        {poll.isPending && <Loader2Icon className="w-3 h-3 animate-spin" />}
                        Check replies
                    </button>
                    <span className="text-[11.5px] text-slate-400">
                        {metrics ? `${metrics.replies} matched · ${metrics.analyzed} analyzed` : "Polls the connected reply mailbox for answers to bridge-sent threads."}
                    </span>
                </div>
                {repliesQuery.isPending ? (
                    <p className="px-5 py-4 text-[12.5px] text-slate-500">Loading replies…</p>
                ) : replies.length === 0 ? (
                    <p className="px-5 py-4 text-[12.5px] text-slate-500">
                        No replies matched yet. Replies appear here once the lead answers a bridge-sent message.
                    </p>
                ) : (
                    <div className="divide-y divide-slate-200/60 pb-4">
                        {replies.map((r) => {
                            const response = responseByReply.get(r.id);
                            return (
                                <div key={r.id} className="px-5 py-3 space-y-1.5">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-[12.5px] text-slate-900 font-medium truncate">{r.subject || "(no subject)"}</span>
                                        <span className={cn("text-[10px] uppercase tracking-[0.1em] font-medium shrink-0", stateTone(r.process_state))}>
                                            {r.process_state}
                                        </span>
                                        {r.analysis_intent && (
                                            <span className={cn("text-[10px] uppercase tracking-[0.1em] font-medium shrink-0", intentTone(r.analysis_intent))}>
                                                {r.analysis_intent}
                                            </span>
                                        )}
                                        {r.analysis_confidence != null && (
                                            <span className="text-[11px] text-slate-400 shrink-0">{Math.round(r.analysis_confidence * 100)}%</span>
                                        )}
                                        <span className="ml-auto text-[11px] text-slate-400 truncate shrink-0">{r.from_email}</span>
                                    </div>
                                    <p className="text-[12px] text-slate-600 line-clamp-2">{r.analysis_summary ?? r.body_text.slice(0, 200)}</p>
                                    {r.analysis_action && <p className="text-[11.5px] text-slate-500">Suggested: {r.analysis_action}</p>}
                                    <div className="flex items-center gap-2 pt-0.5">
                                        {!r.analyzed_at && (
                                            <button
                                                type="button"
                                                onClick={() => runMutation(() => analyze.mutateAsync(r.id), "Reply analyzed")}
                                                disabled={analyze.isPending}
                                                className="h-6 px-2 rounded-md border border-slate-300 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50"
                                            >
                                                Analyze
                                            </button>
                                        )}
                                        {!response && r.analyzed_at && (
                                            instructionFor === r.id ? (
                                                <span className="flex items-center gap-1.5">
                                                    <input
                                                        value={instruction}
                                                        onChange={(e) => setInstruction(e.target.value)}
                                                        placeholder="Instruction (optional for positive)…"
                                                        className="h-6 px-2 w-64 rounded-md border border-slate-300 text-[11.5px]"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            runMutation(() => draft.mutateAsync({ id: r.id, instruction }).then(() => {
                                                                setInstructionFor(null);
                                                                setInstruction("");
                                                            }), "Response drafted for review");
                                                        }}
                                                        disabled={draft.isPending}
                                                        className="h-6 px-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[11.5px] font-medium"
                                                    >
                                                        Draft
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setInstructionFor(null);
                                                            setInstruction("");
                                                        }}
                                                        className="h-6 px-2 text-[11.5px] text-slate-500 hover:text-slate-700 font-medium"
                                                    >
                                                        Cancel
                                                    </button>
                                                </span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (r.analysis_intent === "INTERESTED" || r.analysis_intent === "QUESTION") {
                                                            runMutation(() => draft.mutateAsync({ id: r.id }), "Response drafted for review");
                                                        } else {
                                                            setInstructionFor(r.id);
                                                        }
                                                    }}
                                                    disabled={draft.isPending}
                                                    className="h-6 px-2 rounded-md border border-slate-300 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50"
                                                >
                                                    Draft response
                                                </button>
                                            )
                                        )}
                                        {response && response.status === "NEEDS_REVIEW" && (
                                            <>
                                                <span className="text-[11.5px] text-slate-500 truncate">Draft: {response.subject}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => runMutation(() => approve.mutateAsync(response.id), "Response approved and ready")}
                                                    disabled={approve.isPending}
                                                    className="h-6 px-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11.5px] font-medium"
                                                >
                                                    Approve
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => runMutation(() => reject.mutateAsync(response.id), "Response rejected")}
                                                    className="h-6 px-2 rounded-md border border-slate-300 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50"
                                                >
                                                    Reject
                                                </button>
                                            </>
                                        )}
                                        {response && response.status === "APPROVED" && (
                                            <>
                                                <span className="text-[11.5px] text-emerald-600 font-medium">Approved — ready to send</span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        confirm?.show(`Send this threaded response to ${r.from_email}?`, () =>
                                                            runMutation(() => send.mutateAsync(response.id), "Response sent"),
                                                        );
                                                    }}
                                                    disabled={send.isPending}
                                                    className="h-6 px-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[11.5px] font-medium"
                                                >
                                                    Send now
                                                </button>
                                            </>
                                        )}
                                        {response && response.status === "SENT" && (
                                            <span className="text-[11.5px] text-emerald-600 font-medium">Response sent</span>
                                        )}
                                        {response && response.status === "BLOCKED" && (
                                            <span className="text-[11.5px] text-red-600 font-medium">Response blocked</span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </PageBody>
        </>
    );
}
