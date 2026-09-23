import { useQuery } from "@tanstack/react-query";
import getDirectMail from "@/lib/api/client/app/analytics/getDirectMail";

// `enabled` lets a collapsed wrapper keep this query (and its request) parked
// until the section is actually shown; defaults stay true for existing callers.
export default function useDirectMail(period: string = "7d", enabled: boolean = true) {
    return useQuery({
        queryKey: ["analytics", "direct", period],
        queryFn: () => getDirectMail(period),
        enabled,
    })
}
