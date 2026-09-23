import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    analyzeReply,
    approveBridgeDraft,
    approveFollowup,
    approveResponse,
    cancelSendQueue,
    createSendQueue,
    draftResponse,
    getBridgeDraft,
    getBridgePreview,
    getBridgeStatus,
    getReplyWorkerStatus,
    getSendQueueMetrics,
    listBridgeDrafts,
    listBridgeRuns,
    listQueueReplies,
    listQueueResponses,
    listSendQueueFollowups,
    pauseSendQueue,
    pollQueueReplies,
    previewSendQueue,
    regenerateBridgeDraft,
    rejectBridgeDraft,
    rejectFollowup,
    rejectResponse,
    resumeSendQueue,
    saveBridgeDraft,
    sendBridgeDraft,
    sendResponse,
    startSendQueue,
} from "@/lib/api/bridge";

const KEY = "bridge";

export function useBridgeRuns(warmblyCampaignId: string | null) {
    return useQuery({
        queryKey: [KEY, "runs", warmblyCampaignId],
        queryFn: () => listBridgeRuns(warmblyCampaignId as string),
        enabled: !!warmblyCampaignId,
        staleTime: 30_000,
        retry: 1,
    });
}

export function useBridgeStatus(runId: string | null) {
    return useQuery({
        queryKey: [KEY, "status", runId],
        queryFn: () => getBridgeStatus(runId as string),
        enabled: !!runId,
        staleTime: 10_000,
        retry: 1,
    });
}

export function useBridgeDrafts(runId: string | null) {
    return useQuery({
        queryKey: [KEY, "drafts", runId],
        queryFn: () => listBridgeDrafts(runId as string),
        enabled: !!runId,
        staleTime: 10_000,
        retry: 1,
    });
}

export function useBridgeDraft(draftId: string | null) {
    return useQuery({
        queryKey: [KEY, "draft", draftId],
        queryFn: () => getBridgeDraft(draftId as string),
        enabled: !!draftId,
        staleTime: 10_000,
        retry: 1,
    });
}

export function useBridgePreview(draftId: string | null, enabled: boolean) {
    return useQuery({
        queryKey: [KEY, "preview", draftId],
        queryFn: () => getBridgePreview(draftId as string),
        enabled: !!draftId && enabled,
        staleTime: 30_000,
        retry: 1,
    });
}

function useInvalidateDrafts() {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: [KEY, "drafts"] });
        void queryClient.invalidateQueries({ queryKey: [KEY, "draft"] });
        void queryClient.invalidateQueries({ queryKey: [KEY, "preview"] });
        void queryClient.invalidateQueries({ queryKey: [KEY, "status"] });
    };
}

export function useSaveBridgeDraft() {
    const invalidate = useInvalidateDrafts();
    return useMutation({
        mutationFn: (input: { id: string; subject: string; body: string; version: number }) =>
            saveBridgeDraft(input.id, input),
        onSuccess: () => invalidate(),
    });
}

export function useApproveBridgeDraft() {
    const invalidate = useInvalidateDrafts();
    return useMutation({
        mutationFn: (id: string) => approveBridgeDraft(id),
        onSuccess: () => invalidate(),
    });
}

export function useRejectBridgeDraft() {
    const invalidate = useInvalidateDrafts();
    return useMutation({
        mutationFn: (id: string) => rejectBridgeDraft(id),
        onSuccess: () => invalidate(),
    });
}

export function useRegenerateBridgeDraft() {
    const invalidate = useInvalidateDrafts();
    return useMutation({
        mutationFn: (id: string) => regenerateBridgeDraft(id),
        onSuccess: () => invalidate(),
    });
}

export function useSendBridgeDraft() {
    const invalidate = useInvalidateDrafts();
    return useMutation({
        mutationFn: (input: { id: string; recipient: string; confirmConsent?: boolean; force?: boolean }) =>
            sendBridgeDraft(input.id, input),
        onSuccess: () => invalidate(),
    });
}

function useInvalidateQueue() {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: [KEY, "queue"] });
        void queryClient.invalidateQueries({ queryKey: [KEY, "queue-preview"] });
        void queryClient.invalidateQueries({ queryKey: [KEY, "queue-followups"] });
    };
}

export function useSendQueueMetrics(runId: string | null, refetchInterval?: number) {
    return useQuery({
        queryKey: [KEY, "queue", runId],
        queryFn: () => getSendQueueMetrics(runId as string),
        enabled: !!runId,
        staleTime: 5_000,
        refetchInterval,
        retry: false,
    });
}

export function useSendQueuePreview(runId: string | null, enabled: boolean) {
    return useQuery({
        queryKey: [KEY, "queue-preview", runId],
        queryFn: () => previewSendQueue(runId as string),
        enabled: !!runId && enabled,
        staleTime: 10_000,
        retry: 1,
    });
}

export function useSendQueueFollowups(runId: string | null) {
    return useQuery({
        queryKey: [KEY, "queue-followups", runId],
        queryFn: () => listSendQueueFollowups(runId as string),
        enabled: !!runId,
        staleTime: 10_000,
        retry: false,
    });
}

export function useCreateSendQueue() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (runId: string) => createSendQueue(runId),
        onSuccess: () => invalidate(),
    });
}

export function useStartSendQueue() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (input: { runId: string; confirmed: boolean; consentAttested: boolean }) =>
            startSendQueue(input.runId, { confirmed: input.confirmed, consentAttested: input.consentAttested }),
        onSuccess: () => invalidate(),
    });
}

export function usePauseSendQueue() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (runId: string) => pauseSendQueue(runId),
        onSuccess: () => invalidate(),
    });
}

export function useResumeSendQueue() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (runId: string) => resumeSendQueue(runId),
        onSuccess: () => invalidate(),
    });
}

export function useCancelSendQueue() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (runId: string) => cancelSendQueue(runId),
        onSuccess: () => invalidate(),
    });
}

export function useApproveFollowup() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (id: string) => approveFollowup(id),
        onSuccess: () => invalidate(),
    });
}

export function useRejectFollowup() {
    const invalidate = useInvalidateQueue();
    return useMutation({
        mutationFn: (id: string) => rejectFollowup(id),
        onSuccess: () => invalidate(),
    });
}

function useInvalidateReplies() {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: [KEY, "replies"] });
        void queryClient.invalidateQueries({ queryKey: [KEY, "responses"] });
    };
}

export function useQueueReplies(runId: string | null) {
    return useQuery({
        queryKey: [KEY, "replies", runId],
        queryFn: () => listQueueReplies(runId as string),
        enabled: !!runId,
        staleTime: 10_000,
        retry: false,
    });
}

export function useQueueResponses(runId: string | null) {
    return useQuery({
        queryKey: [KEY, "responses", runId],
        queryFn: () => listQueueResponses(runId as string),
        enabled: !!runId,
        staleTime: 10_000,
        retry: false,
    });
}

export function usePollQueueReplies() {
    const invalidate = useInvalidateReplies();
    return useMutation({
        mutationFn: (runId: string) => pollQueueReplies(runId),
        onSuccess: () => invalidate(),
    });
}

export function useAnalyzeReply() {
    const invalidate = useInvalidateReplies();
    return useMutation({
        mutationFn: (id: string) => analyzeReply(id),
        onSuccess: () => invalidate(),
    });
}

export function useDraftResponse() {
    const invalidate = useInvalidateReplies();
    return useMutation({
        mutationFn: (input: { id: string; instruction?: string }) => draftResponse(input.id, input.instruction ?? ""),
        onSuccess: () => invalidate(),
    });
}

export function useApproveResponse() {
    const invalidate = useInvalidateReplies();
    return useMutation({
        mutationFn: (id: string) => approveResponse(id),
        onSuccess: () => invalidate(),
    });
}

export function useSendResponse() {
    const invalidate = useInvalidateReplies();
    return useMutation({
        mutationFn: (id: string) => sendResponse(id),
        onSuccess: () => invalidate(),
    });
}

export function useReplyWorkerStatus(refetchInterval?: number) {
    return useQuery({
        queryKey: [KEY, "reply-worker"],
        queryFn: getReplyWorkerStatus,
        staleTime: 5_000,
        refetchInterval,
        retry: false,
    });
}

export function useRejectResponse() {
    const invalidate = useInvalidateReplies();
    return useMutation({
        mutationFn: (id: string) => rejectResponse(id),
        onSuccess: () => invalidate(),
    });
}
