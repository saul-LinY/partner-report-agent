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
  undatedCount: number;
  conflictingDays: string[];
  reviewId: string | null;
  lastUpdatedAt: string | null;
  latestProgress?: {
    date: string;
    summary: string;
    source: "reviewed" | "collected";
  } | null;
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
