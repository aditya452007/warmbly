// Draft review drawer: inspect research, edit subject/body, preview the
// bridge-rendered HTML in a sandbox, save, regenerate, approve or reject.
// Offer URLs are read-only configuration; approval never sends anything.

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import toast from "react-hot-toast";
import { CheckIcon, Loader2Icon, RefreshCcwIcon, XIcon } from "lucide-react";
import { Label, TextInput } from "@/components/ui/field";
import { TopbarAction } from "@/components/layout/Page";
import { useConfirm } from "@/hooks/context/confirm";
import {
    useApproveBridgeDraft,
    useBridgeDraft,
    useBridgePreview,
    useRegenerateBridgeDraft,
    useRejectBridgeDraft,
    useSaveBridgeDraft,
} from "@/lib/api/hooks/app/bridge/useBridgeReview";
import { cn } from "@/lib/utils";

const INVALID_BODY = "Review the AI draft, edit the copy, and approve it for a future send.";

export function draftTone(status: string): string {
    if (status === "APPROVED") return "text-emerald-600";
    if (status === "REJECTED" || status === "FAILED") return "text-red-600";
    return "text-amber-600";
}

export function draftLabel(status: string): string {
    if (status === "NEEDS_REVIEW") return "Draft";
    return status.charAt(0) + status.slice(1).toLowerCase();
}

export default function ReviewDrawer({ draftId, onClose }: { draftId: string; onClose: () => void }) {
    const confirm = useConfirm();
    const draftQuery = useBridgeDraft(draftId);
    const [previewOpen, setPreviewOpen] = React.useState(false);
    const preview = useBridgePreview(draftId, previewOpen);
    const save = useSaveBridgeDraft();
    const approve = useApproveBridgeDraft();
    const reject = useRejectBridgeDraft();
    const regenerate = useRegenerateBridgeDraft();

    const draft = draftQuery.data?.draft;
    const [subject, setSubject] = React.useState<string | null>(null);
    const [body, setBody] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (draft) {
            setSubject((s) => (s === null ? draft.subject : s));
            setBody((b) => (b === null ? draft.body : b));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft?.id]);

    const dirty = draft != null && subject !== null && body !== null && (subject !== draft.subject || body !== draft.body);
    const busy = save.isPending || approve.isPending || reject.isPending || regenerate.isPending;

    async function onSave() {
        if (!draft || subject === null || body === null) return;
        try {
            await save.mutateAsync({ id: draft.id, subject, body, version: draft.version });
            toast.success("Draft saved");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : INVALID_BODY);
        }
    }

    async function onApprove() {
        if (!draft) return;
        try {
            await approve.mutateAsync(draft.id);
            toast.success("Draft approved");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : INVALID_BODY);
        }
    }

    function onReject() {
        if (!draft) return;
        confirm?.show(`Reject the draft for ${draft.business_name}?`, async () => {
            try {
                await reject.mutateAsync(draft.id);
                toast.success("Draft rejected");
            } catch (e) {
                toast.error(e instanceof Error ? e.message : INVALID_BODY);
            }
        });
    }

    async function onRegenerate() {
        if (!draft) return;
        try {
            await regenerate.mutateAsync(draft.id);
            setSubject(null);
            setBody(null);
            toast.success("Draft regenerated");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : INVALID_BODY);
        }
    }

    return (
        <AnimatePresence>
            <motion.div
                key="overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-[130] flex"
            >
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
                />
                <motion.div
                    key="panel"
                    initial={{ x: "100%" }}
                    animate={{ x: 0 }}
                    exit={{ x: "100%" }}
                    transition={{ type: "tween", duration: 0.2 }}
                    className="relative ml-auto h-full w-full max-w-[560px] bg-white shadow-xl flex flex-col"
                    role="dialog"
                    aria-label={draft ? `Review draft for ${draft.business_name}` : "Review draft"}
                >
                    <div className="shrink-0 px-5 h-12 flex items-center gap-2 border-b border-slate-200">
                        <span className="text-[12.5px] font-medium text-slate-900 truncate">
                            {draft?.business_name ?? "Loading…"}
                        </span>
                        {draft && (
                            <span className={cn("text-[10px] uppercase tracking-[0.1em] font-medium", draftTone(draft.status))}>
                                {draftLabel(draft.status)}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close review"
                            className="ml-auto size-6 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center"
                        >
                            <XIcon className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
                        {draftQuery.isPending ? (
                            <p className="text-[12.5px] text-slate-500">Loading draft…</p>
                        ) : draftQuery.isError || !draft ? (
                            <div className="text-center py-10">
                                <p className="text-[12.5px] text-slate-900 font-medium">Couldn't load this draft</p>
                                <div className="mt-3">
                                    <TopbarAction variant="ghost" onClick={() => draftQuery.refetch()}>
                                        Try again
                                    </TopbarAction>
                                </div>
                            </div>
                        ) : (
                            <>
                                <section>
                                    <h3 className="text-[10px] uppercase tracking-[0.14em] text-slate-400 font-medium mb-1.5">
                                        Business
                                    </h3>
                                    <p className="text-[12.5px] text-slate-900 font-medium">{draft.business_name}</p>
                                    {draft.website && (
                                        <p className="font-mono text-[11px] text-slate-500 truncate">{draft.website}</p>
                                    )}
                                    {draft.email && <p className="text-[12px] text-slate-600">{draft.email}</p>}
                                    {draft.location && <p className="text-[11.5px] text-slate-400">{draft.location}</p>}
                                </section>

                                {draft.research_summary && (
                                    <section>
                                        <h3 className="text-[10px] uppercase tracking-[0.14em] text-slate-400 font-medium mb-1.5">
                                            Research
                                        </h3>
                                        <p className="text-[12px] text-slate-700 leading-relaxed">{draft.research_summary}</p>
                                        {draft.pain_points.length > 0 && (
                                            <ul className="mt-1.5 space-y-1">
                                                {draft.pain_points.map((pain, i) => (
                                                    <li key={i} className="text-[11.5px] text-slate-600 flex gap-1.5">
                                                        <span className="text-slate-300">•</span>
                                                        <span>{pain}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>
                                )}

                                <section className="space-y-1.5">
                                    <Label>
                                        Subject
                                        <TextInput
                                            value={subject ?? ""}
                                            onChange={setSubject}
                                            placeholder="Email subject"
                                            maxLength={120}
                                            className="mt-1.5 w-full"
                                        />
                                    </Label>
                                </section>

                                <section>
                                    <Label>
                                        Email body
                                        <textarea
                                            value={body ?? ""}
                                            onChange={(e) => setBody(e.target.value)}
                                            rows={8}
                                            maxLength={4000}
                                            className="mt-1.5 min-h-40 w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[16px] md:text-[12.5px] text-slate-900 placeholder:text-slate-400 outline-none transition-colors focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                                        />
                                    </Label>
                                </section>

                                <section>
                                    <h3 className="text-[10px] uppercase tracking-[0.14em] text-slate-400 font-medium mb-1.5">
                                        Offer URLs (read-only)
                                    </h3>
                                    <div className="space-y-1">
                                        {draft.offer_urls.map((url, i) => (
                                            <p key={i} className="font-mono text-[11px] text-slate-500 truncate" title={url}>
                                                {url}
                                            </p>
                                        ))}
                                    </div>
                                </section>

                                {previewOpen && (
                                    <section>
                                        <h3 className="text-[10px] uppercase tracking-[0.14em] text-slate-400 font-medium mb-1.5">
                                            Rendered preview
                                        </h3>
                                        {preview.isPending ? (
                                            <p className="text-[12px] text-slate-500">Rendering…</p>
                                        ) : preview.isError || !preview.data ? (
                                            <p className="text-[12px] text-red-600">Couldn't render the preview.</p>
                                        ) : (
                                            <iframe
                                                title={`Email preview for ${draft.business_name}`}
                                                sandbox=""
                                                srcDoc={preview.data.html}
                                                className="w-full h-96 rounded-md border border-slate-200 bg-white"
                                            />
                                        )}
                                    </section>
                                )}
                            </>
                        )}
                    </div>

                    {draft && (
                        <div className="shrink-0 px-5 py-3 border-t border-slate-200 flex items-center gap-1.5 flex-wrap">
                            <TopbarAction
                                variant="ghost"
                                onClick={() => setPreviewOpen((v) => !v)}
                            >
                                {previewOpen ? "Hide preview" : "Preview email"}
                            </TopbarAction>
                            <TopbarAction
                                variant="ghost"
                                icon={regenerate.isPending ? <Loader2Icon className="w-3 h-3 animate-spin" /> : <RefreshCcwIcon className="w-3 h-3" />}
                                onClick={onRegenerate}
                                disabled={busy}
                            >
                                Regenerate
                            </TopbarAction>
                            <div className="ml-auto flex items-center gap-1.5">
                                <TopbarAction
                                    variant="ghost"
                                    onClick={onReject}
                                    disabled={busy}
                                >
                                    Reject
                                </TopbarAction>
                                <TopbarAction
                                    onClick={onSave}
                                    disabled={!dirty || busy}
                                    icon={save.isPending ? <Loader2Icon className="w-3 h-3 animate-spin" /> : undefined}
                                >
                                    Save draft
                                </TopbarAction>
                                <TopbarAction
                                    onClick={onApprove}
                                    disabled={busy || draft.status === "APPROVED"}
                                    icon={<CheckIcon className="w-3 h-3" />}
                                    className="bg-emerald-600 hover:bg-emerald-700"
                                >
                                    Approve
                                </TopbarAction>
                            </div>
                        </div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
