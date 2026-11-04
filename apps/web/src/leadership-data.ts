import { useQuery } from "@tanstack/react-query";
import type {
  ProgressProject,
  ProjectProgressResponse,
} from "@partner-report/contracts/project-progress";
import type { ProjectProfileNote } from "@partner-report/contracts/project-profile";
import { api } from "./api.js";

export type ProjectProfileItem = {
  id: string;
  partnerId: string;
  projectName: string;
  note: ProjectProfileNote;
  updatedAt: string;
  sessions: number;
  failed: boolean;
};

/** Plain-language project profiles; the pages work without them while they are being built. */
export function useProjectProfiles() {
  return useQuery({
    queryKey: ["project-profiles"],
    queryFn: () =>
      api<{ items: ProjectProfileItem[] }>("/v1/admin/project-profiles"),
    refetchInterval: 60_000,
  });
}

export type Activity = {
  timezone: string;
  from: string;
  to: string;
  days: number;
  totals: { dropped: number };
  daily: Array<{ date: string; byProject: Record<string, number> }>;
  members: Array<{
    id: string;
    name: string;
    turns: number;
    sessions: number;
    activeDays: number;
    byDay: Record<string, number>;
    byProject: Record<
      string,
      { turns: number; lastActiveDate: string; byDay: Record<string, number> }
    >;
    /** Every turn at its own minute: t is "YYYY-MM-DDTHH:mm" in team time. */
    events: Array<{ t: string; p: string }>;
  }>;
};

export const STALLED_DAYS = 7;
const BLOCKER_WINDOW_DAYS = 14;

export const dayDistance = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

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

export type ProjectState = "ok" | "stalled" | "blocked";
export const stateLabels: Record<ProjectState, string> = {
  ok: "进行中",
  stalled: "停滞",
  blocked: "有卡点",
};

/** The projects a member owns: those with approved (reviewed) progress. */
export function memberProjects(
  memberId: string,
  progress: ProjectProgressResponse,
  activity: Activity,
  profiles: ProjectProfileItem[] = [],
) {
  const active = activity.members.find((member) => member.id === memberId);
  return progress.projects
    .filter((project) => project.partnerId === memberId)
    .map((project: ProgressProject) => {
      const steps = project.outlook?.roadmap ?? [];
      const blocker = project.keyEvents
        .filter(
          (event) =>
            event.type === "blocker" &&
            dayDistance(event.date, progress.today) <= BLOCKER_WINDOW_DAYS,
        )
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const lastActive =
        active?.byProject[project.projectName]?.lastActiveDate ?? null;
      const idle = lastActive ? dayDistance(lastActive, progress.today) : null;
      const state: ProjectState = blocker
        ? "blocked"
        : idle === null || idle >= STALLED_DAYS
          ? "stalled"
          : "ok";
      const profile = profiles.find(
        (item) =>
          item.partnerId === memberId &&
          item.projectName === project.projectName,
      );
      return {
        project,
        profile,
        steps,
        done: steps.filter((step) => step.state === "done").length,
        current: steps.find((step) => step.state === "current"),
        blocker,
        state,
        idle,
        focus:
          project.currentFocus?.text ||
          project.latestProgress?.summary ||
          profile?.note.status.text ||
          "暂无已审核的进展总结",
      };
    })
    .sort(
      (a, b) => Number(b.state === "blocked") - Number(a.state === "blocked"),
    );
}
