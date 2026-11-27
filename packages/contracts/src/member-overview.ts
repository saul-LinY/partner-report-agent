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
/** After this many idle days a project is shelved: it leaves the attention list, open blockers included. */
export const SHELVED_DAYS = 30;
export const dayDistance = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export type ProjectState = "ok" | "stalled" | "blocked" | "shelved";
export const stateLabels: Record<ProjectState, string> = {
  ok: "进行中",
  stalled: "停滞",
  blocked: "有卡点",
  shelved: "已搁置",
};
/** Card order on member pages: what needs leadership first, shelved projects last. */
const STATE_ORDER: Record<ProjectState, number> = {
  blocked: 0,
  stalled: 1,
  ok: 2,
  shelved: 3,
};

/** One project card on a member's page. */
export type MemberProject = {
  project: ProgressProject;
  profile: ProjectProfileItem | undefined;
  steps: ProjectOutlookStep[];
  done: number;
  current: ProjectOutlookStep | undefined;
  /** The newest open blocker raised on the latest work card. */
  blocker: ProjectKeyEvent | undefined;
  /** Blockers raised on the latest work card and already resolved, newest first. */
  resolved: ProjectKeyEvent[];
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

/**
 * The projects a member owns: those with approved (reviewed) progress.
 * `periodKey` is the latest published work card's period; blockers from other periods are ignored.
 */
export function memberProjects(
  memberId: string,
  progress: ProjectProgressResponse,
  activity: Activity,
  profiles: ProjectProfileItem[],
  periodKey: string | undefined,
): MemberProject[] {
  const active = activity.members.find((member) => member.id === memberId);
  return progress.projects
    .filter((project) => project.partnerId === memberId)
    .map((project: ProgressProject) => {
      const steps = project.outlook?.roadmap ?? [];
      const blockers = project.keyEvents.filter(
        (event) =>
          event.type === "blocker" &&
          periodKey !== undefined &&
          event.periodKey === periodKey,
      );
      const blocker = blockers
        .filter((event) => !event.resolvedOn)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const lastActive =
        active?.byProject[project.projectName]?.lastActiveDate ?? null;
      const idle = lastActive ? dayDistance(lastActive, progress.today) : null;
      const resolved = blockers
        .filter((event) => event.resolvedOn)
        .sort((a, b) => b.resolvedOn!.localeCompare(a.resolvedOn!));
      // A project the member stopped collecting gets no new evidence, so it is stalled at once.
      // Long silence outranks an open blocker: an abandoned project should not stay on the attention list.
      const state: ProjectState = project.collectionStopped
        ? "stalled"
        : idle !== null && idle >= SHELVED_DAYS
          ? "shelved"
          : blocker
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
        resolved,
        state,
        idle,
        focus:
          project.currentFocus?.text ||
          project.latestProgress?.summary ||
          profile?.note.status.text ||
          "暂无已审核的进展总结",
      };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
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
    attention: projects.filter(
      (item) => item.state === "blocked" || item.state === "stalled",
    ).length,
    activeDays28: recentDays,
    lastActiveDate: lastActive,
  };
}

/** One kind of item in a project's weekly progress: the newest few, and how many there are in all. */
export type PersonalWeekItems = { items: string[]; total: number };

export type PersonalWeekProject = {
  name: string;
  /** The project profile's one-liner. */
  oneLine: string | null;
  /** Kept sessions this period. */
  sessions: number;
  /** Conversation turns this period. */
  turns: number;
  /** Last turn this period, "YYYY-MM-DDTHH:mm" in team time. */
  lastAt: string | null;
  /** Last activity ever; shown when there is no session this week. */
  lastActiveDate: string | null;
  /** kind=outcome: the newest 3 (plain, else text). */
  outcomes: PersonalWeekItems;
  /** kind=decision: the newest 2. */
  decisions: PersonalWeekItems;
  /** kind=blocker: the newest 2. */
  problems: PersonalWeekItems;
};

/** 负责的项目 on the App: the leadership page's moving projects (ok or blocked) of the member, live, allowed ones only. */
export type PersonalOwnedProject = {
  name: string;
  oneLine: string | null;
  /** The newest approved work card's focus, else the profile's status; null when neither exists. */
  focus: string | null;
  intro: string | null;
  /** Days the member worked on it, from approved progress. */
  contributionDays: number;
  features: string[];
  openIssues: string[];
};

/** What the App receives from GET /v1/collector/personal-data: this week's progress and figures only. */
export type PersonalData = {
  generatedAt: string;
  timezone: string;
  member: { id: string; name: string };
  /** ISO instants. */
  period: {
    periodKey: string;
    startsAt: string;
    cutoffAt: string;
    autoApproveAt: string;
    publishAt: string;
  };
  /** The newest upload from the member's non-test devices. */
  lastUpload: { at: string; status: string } | null;
  totals: {
    sessions: number;
    turns: number;
    activeDays: number;
    elapsedDays: number;
  };
  /** Every kept turn in [startsAt, min(now, cutoffAt)), "YYYY-MM-DDTHH:mm" in team time. */
  events: Array<{ t: string; p: string }>;
  /** Most turns first; projects with no session this period last. */
  projects: PersonalWeekProject[];
  /** 工作投入: the member's turns over the activity window up to now, allowed projects only. Dates are team days. */
  history: {
    from: string;
    to: string;
    events: Array<{ t: string; p: string }>;
  };
  /** 负责的项目: most turns in the last 28 days first. */
  owned: PersonalOwnedProject[];
};
