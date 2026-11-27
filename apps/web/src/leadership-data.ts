import { useQuery } from "@tanstack/react-query";
import type { LeadershipSnapshot } from "@partner-report/contracts/leadership";
import type { ProjectState } from "@partner-report/contracts/member-overview";
import { api } from "./api.js";

/** Status words on the leadership pages; the colours are only red, amber and green. */
export const stateText: Record<ProjectState, string> = {
  ok: "正常",
  stalled: "停滞",
  blocked: "有卡点",
  shelved: "已搁置",
};
/**
 * The weekly leadership panel: one published snapshot (progress, activity, profiles, reviews) per period.
 * It only changes when the next one is published, so it refetches a minute after `next.publishAt` (giving the worker
 * time to publish) and, while the schedule still points at a passed publish time, every minute after that.
 */
export function useLeadershipSnapshot() {
  return useQuery({
    queryKey: ["leadership-snapshot"],
    queryFn: () => api<LeadershipSnapshot>("/v1/admin/leadership-snapshot"),
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const publishAt = query.state.data?.schedule.next.publishAt;
      if (!publishAt) return false;
      const wait = Date.parse(publishAt) - Date.now();
      // Browser timers overflow past ~24.8 days; a weekly schedule never gets near that.
      return Math.min(Math.max(wait + 60_000, 60_000), 2_147_000_000);
    },
  });
}
