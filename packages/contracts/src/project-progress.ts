import { z } from "zod";
import {
  projectStatusSchema,
  type ConfirmedProjectStatus,
} from "./project-status.js";

const DAY = 86_400_000;
export const progressDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const time = Date.parse(`${date}T00:00:00Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === date
    );
  }, "日期无效");
export const projectStages = {
  discovery: "需求梳理",
  development: "开发实现",
  validation: "联调测试",
  delivery: "交付验收",
} as const;
export type ProjectStage = keyof typeof projectStages;
export const progressEventSchema = z
  .object({
    date: progressDateSchema,
    type: z.enum([
      "start",
      "pause",
      "resume",
      "complete",
      "reopen",
      "milestone",
    ]),
    reason: z.string().trim().max(500).default(""),
    projectStatus: projectStatusSchema.optional(),
    statusConfirmedAt: z.string().datetime().optional(),
    stage: z
      .enum(["discovery", "development", "validation", "delivery"])
      .optional(),
  })
  .strict();
export type ProgressEvent = z.infer<typeof progressEventSchema>;
export type ProgressState = "unknown" | "active" | "paused" | "completed";
export const progressEventLabels: Record<ProgressEvent["type"], string> = {
  start: "开始",
  pause: "暂停",
  resume: "恢复",
  complete: "完成",
  reopen: "重新开启",
  milestone: "里程碑",
};
export function addProgressDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}
export function progressDayDistance(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY,
  );
}
export function progressToday(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
/** Day-resolution transitions; descriptive milestones never change state or duration. */
export function validateProgressEvents(
  events: ProgressEvent[],
  today: string,
): string | null {
  let state: ProgressState = "unknown";
  let previous: ProgressEvent | undefined;
  let previousTransition: ProgressEvent | undefined;
  for (const event of events) {
    if (!progressEventSchema.safeParse(event).success)
      return "请填写有效日期和时间事件。";
    if (event.date > today) return "只能核查今天及之前已发生的事件。";
    if (previous && event.date < previous.date)
      return "请按日期从早到晚排列事件。";
    if ((event.stage || event.projectStatus) && event.type !== "milestone")
      return "项目阶段请记录为里程碑。";
    previous = event;
    if (event.type === "milestone") {
      if (!event.reason.trim())
        return "里程碑请填写具体成果，例如接口联调完成。";
      continue;
    }
    if (
      previousTransition &&
      previousTransition.date === event.date &&
      !(
        ["start", "reopen"].includes(previousTransition.type) &&
        event.type === "complete"
      )
    )
      return "按天记录时，同一天仅支持开始（或重新开启）并完成；其他切换请核查日期。";
    const allowed: Record<ProgressEvent["type"], boolean> = {
      start: state === "unknown",
      pause: state === "active",
      resume: state === "paused",
      complete: state === "active" || state === "paused",
      reopen: state === "completed",
      milestone: true,
    };
    if (!allowed[event.type])
      return `${event.date} 的“${progressEventLabels[event.type]}”与前面的状态不符。请先记录开始，暂停后恢复，完成后可重新开启。`;
    if (event.type === "pause" && !event.reason.trim())
      return "暂停时请注明原因，例如临时支援其他项目。";
    state =
      event.type === "pause"
        ? "paused"
        : event.type === "complete"
          ? "completed"
          : "active";
    previousTransition = event;
  }
  return null;
}
export type ProgressInterval = {
  from: string;
  to: string;
  state: "active" | "paused";
};
export function calculateProgress(events: ProgressEvent[], today: string) {
  const intervals: ProgressInterval[] = [];
  let state: ProgressState = "unknown";
  let since = "";
  for (const event of events.filter(
    (event) => event.date <= today && event.type !== "milestone",
  )) {
    if ((state === "active" || state === "paused") && since) {
      const to =
        event.type === "complete"
          ? event.date
          : addProgressDays(event.date, -1);
      if (to >= since) intervals.push({ from: since, to, state });
    }
    state =
      event.type === "pause"
        ? "paused"
        : event.type === "complete"
          ? "completed"
          : "active";
    since = event.date;
  }
  if ((state === "active" || state === "paused") && since <= today)
    intervals.push({ from: since, to: today, state });
  const startDate =
    events.find((event) => event.type === "start" && event.date <= today)
      ?.date ?? null;
  const completedDate = state === "completed" ? since : null;
  const sum = (kind: ProgressInterval["state"]) =>
    intervals
      .filter((i) => i.state === kind)
      .reduce((n, i) => n + progressDayDistance(i.from, i.to) + 1, 0);
  return {
    state,
    startDate,
    completedDate,
    intervals,
    elapsedDays: startDate
      ? progressDayDistance(startDate, completedDate ?? today) + 1
      : null,
    activeDays: startDate ? sum("active") : null,
    pausedDays: startDate ? sum("paused") : null,
  };
}
export type ProgressMetrics = ReturnType<typeof calculateProgress>;
export type ProgressDay = {
  date: string;
  entries: Array<{
    id: string;
    summary: string;
    source: "reviewed" | "collected";
    reviewId: string | null;
    periodKey: string | null;
  }>;
};
export type ProjectKeyEvent = {
  date: string;
  type: "goal_change" | "milestone" | "decision" | "blocker" | "stage_change";
  title: string;
  detail: string;
  step: string | null;
  periodKey: string | null;
  reviewId: string | null;
  /** Blockers only: the day it stopped being an obstacle; absent while it still blocks. */
  resolvedOn?: string;
  /** Who said so: an approved work card ("model") or a person on the progress page ("manual"). */
  resolvedBy?: "model" | "manual";
  /** Blockers only: what leadership must decide or provide, as the member's card put it. */
  neededSupport?: string | null;
  /** Resolved blockers only: one line on why it stopped blocking (from the resolving card). */
  resolvedEvidence?: string | null;
};
/** A blocker is identified by its date and title within one member's project. */
export const blockerKey = (blocker: { date: string; title: string }) =>
  `${blocker.date}\u0000${blocker.title.trim()}`;
/** A resolution an approved work card recorded for an earlier blocker. */
export type CardBlockerResolution = {
  date: string;
  title: string;
  resolvedOn: string;
  evidence?: string | null;
};
/** A person's explicit choice; it overrides what work cards say. */
export type BlockerMark = {
  date: string;
  title: string;
  resolved: boolean;
  resolvedOn: string;
};
/**
 * Applies resolutions to a project's blockers. A manual mark wins (reopening one the model closed, or
 * closing one the model left open); otherwise the earliest approved card resolution counts.
 */
export function applyBlockerResolutions(
  events: ProjectKeyEvent[],
  cardResolutions: CardBlockerResolution[],
  marks: BlockerMark[],
): ProjectKeyEvent[] {
  const byCard = new Map<
    string,
    { resolvedOn: string; evidence: string | null }
  >();
  for (const resolution of cardResolutions) {
    if (!progressDateSchema.safeParse(resolution.resolvedOn).success) continue;
    const key = blockerKey(resolution);
    const earlier = byCard.get(key);
    if (!earlier || resolution.resolvedOn < earlier.resolvedOn)
      byCard.set(key, {
        resolvedOn: resolution.resolvedOn,
        evidence: resolution.evidence?.trim() || null,
      });
  }
  const byMark = new Map(marks.map((mark) => [blockerKey(mark), mark]));
  return events.map((event): ProjectKeyEvent => {
    const {
      resolvedOn: _on,
      resolvedBy: _by,
      resolvedEvidence: _evidence,
      ...open
    } = event;
    if (event.type !== "blocker") return open;
    const mark = byMark.get(blockerKey(event));
    if (mark)
      return mark.resolved
        ? { ...open, resolvedOn: mark.resolvedOn, resolvedBy: "manual" }
        : open;
    const resolved = byCard.get(blockerKey(event));
    return resolved
      ? {
          ...open,
          resolvedOn: resolved.resolvedOn,
          resolvedBy: "model",
          resolvedEvidence: resolved.evidence,
        }
      : open;
  });
}
export type ProjectOutlookStep = {
  name: string;
  state: "done" | "current" | "todo";
};
export type ProjectOutlook = {
  goal: string;
  roadmap: ProjectOutlookStep[];
  position: string;
  periodKey: string | null;
  reviewId: string | null;
};
export type ProjectAiEvidence = {
  sessionCount: number;
  periodCount: number;
  workCardCount: number;
  lastAnalyzedAt: string | null;
};
export type ProgressProject = {
  currentStatus?: ConfirmedProjectStatus;
  partnerId: string;
  projectId: string;
  projectName: string;
  projectDescription?: string | null;
  version: number;
  events: ProgressEvent[];
  metrics: ProgressMetrics;
  days: ProgressDay[];
  contributionDays: number;
  firstContributionDate: string | null;
  lastContributionDate: string | null;
  undatedCount: number;
  conflictingDays: string[];
  reviewId: string | null;
  lastUpdatedAt: string | null;
  currentFocus: {
    text: string;
    periodKey: string | null;
    reviewId: string | null;
  } | null;
  outlook: ProjectOutlook | null;
  keyEvents: ProjectKeyEvent[];
  aiEvidence: ProjectAiEvidence;
  latestProgress?: {
    date: string;
    summary: string;
    source: "reviewed" | "collected";
  } | null;
  /** The member has withdrawn collection permission for every App source mapped to this project. */
  collectionStopped?: boolean;
};
export type ProjectProgressResponse = {
  today: string;
  timezone: string;
  from: string;
  to: string;
  generatedAt: string;
  members: Array<{
    id: string;
    name: string;
    status: string;
    contributionDays: number;
  }>;
  projects: ProgressProject[];
};
export type ParticipationResponse = {
  version: number;
  events: ProgressEvent[];
  today: string;
  timezone: string;
  history: Array<{
    version: number;
    createdAt: string;
    actorName: string;
    note: string;
    reviewId: string | null;
    events: ProgressEvent[];
  }>;
};

/** Reopening invalidates an earlier stage; completion is confirmed by the lifecycle ledger. */
export function currentProjectStage(
  events: ProgressEvent[],
): ProjectStage | "completed" | null {
  let stage: ProjectStage | "completed" | null = null;
  for (const event of events) {
    if (event.type === "reopen") stage = null;
    if (event.type === "complete") stage = "completed";
    if (event.type === "milestone" && event.stage && stage !== "completed")
      stage = event.stage;
  }
  return stage;
}
