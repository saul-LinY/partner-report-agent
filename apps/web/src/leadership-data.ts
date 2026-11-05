import { useQuery } from "@tanstack/react-query";
import type {
  Activity,
  ProjectProfileItem,
} from "@partner-report/contracts/member-overview";
import type { ProjectProgressResponse } from "@partner-report/contracts/project-progress";
import { api } from "./api.js";

/** Plain-language project profiles; the pages work without them while they are being built. */
export function useProjectProfiles() {
  return useQuery({
    queryKey: ["project-profiles"],
    queryFn: () =>
      api<{ items: ProjectProfileItem[] }>("/v1/admin/project-profiles"),
    refetchInterval: 60_000,
  });
}

/** Both queries share keys with the detail views, so requests are deduplicated. */
export function useLeadershipData(days = 28) {
  const activity = useQuery({
    queryKey: ["ai-activity", days],
    queryFn: () => api<Activity>(`/v1/admin/ai-activity?days=${days}`),
    refetchInterval: 60_000,
  });
  const progress = useQuery({
    queryKey: ["project-progress", "calendar", ""],
    queryFn: () => api<ProjectProgressResponse>("/v1/admin/project-progress"),
  });
  return { activity, progress };
}
