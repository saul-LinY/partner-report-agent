import type { ProjectProfileNote } from "./project-profile.js";
import type {
  ProgressProject,
  ProjectKeyEvent,
  ProjectOutlookStep,
  ProjectProgressResponse,
} from "./project-progress.js";

/** Shared by the leadership web pages and the member's own App view so both show the same figures. */

export type ProjectProfileItem = {
  id: string;
  partnerId: string;
  projectName: string;
  note: ProjectProfileNote;
  updatedAt: string;
  sessions: number;
  failed: boolean;
};

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
export const BLOCKER_WINDOW_DAYS = 14;

export const dayDistance = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export type ProjectState = "ok" | "stalled" | "blocked";
export const stateLabels: Record<ProjectState, string> = {
  ok: "进行中",
  stalled: "停滞",
  blocked: "有卡点",
};

/** One project card on a member's page. */
export type MemberProject = {
  project: ProgressProject;
  profile: ProjectProfileItem | undefined;
  steps: ProjectOutlookStep[];
  done: number;
  current: ProjectOutlookStep | undefined;
  blocker: ProjectKeyEvent | undefined;
  state: ProjectState;
  /** Days since the project's last activity; null when it has none. */
  idle: number | null;
  focus: string;
};

/** The four headline figures on a member's page. */
export type MemberHeadline = {
  projectCount: number;
  attention: number;
  activeDays28: number;
  lastActiveDate: string | null;
};

/** The projects a member owns: those with approved (reviewed) progress. */
export function memberProjects(
  memberId: string,
  progress: ProjectProgressResponse,
  activity: Activity,
  profiles: ProjectProfileItem[] = [],
): MemberProject[] {
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

const shiftDay = (date: string, offset: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** The four headline figures on a member's page. */
export function memberHeadline(
  memberId: string,
  projects: MemberProject[],
  activity: Activity,
): MemberHeadline {
  const active = activity.members.find((member) => member.id === memberId);
  const lastActive =
    Object.values(active?.byProject ?? {})
      .map((entry) => entry.lastActiveDate)
      .sort()
      .at(-1) ?? null;
  const recentDays = new Set(
    (active?.events ?? [])
      .map((event) => event.t.slice(0, 10))
      .filter((date) => date >= shiftDay(activity.to, -27)),
  ).size;
  return {
    projectCount: projects.length,
    attention: projects.filter((item) => item.state !== "ok").length,
    activeDays28: recentDays,
    lastActiveDate: lastActive,
  };
}

/** What the App receives from GET /v1/collector/personal-data. */
export type PersonalData = {
  generatedAt: string;
  today: string;
  timezone: string;
  member: { id: string; name: string };
  headline: MemberHeadline;
  projects: MemberProject[];
  /** The range the per-day progress in `projects[].project.days` covers (one calendar month). */
  calendar: { month: string; from: string; to: string };
  activity: {
    timezone: string;
    from: string;
    to: string;
    days: number;
    events: Array<{ t: string; p: string }>;
  };
};
