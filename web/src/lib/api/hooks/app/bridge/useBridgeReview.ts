import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    approveBridgeDraft,
    getBridgeDraft,
    getBridgePreview,
    getBridgeStatus,
    listBridgeDrafts,
    listBridgeRuns,
    regenerateBridgeDraft,
    rejectBridgeDraft,
    saveBridgeDraft,
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
