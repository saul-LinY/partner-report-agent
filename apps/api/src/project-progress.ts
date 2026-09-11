import { readProjectStatus } from "@partner-report/contracts/project-status";
import {
  calculateProgress,
  progressDateSchema,
  type ProgressEvent,
  type ProgressProject,
} from "@partner-report/contracts/project-progress";

type Card = {
  id: string;
  partner_id: string;
  project_id: string;
  project_name: string;
  project_description?: string | null;
  review_id: string;
  period_key: string;
  review_status: string;
  payload: Record<string, any>;
  updated_at: Date | string;
};
type Participation = {
  partner_id: string;
  project_id: string;
  project_name: string;
  project_description?: string | null;
  version: number;
  events: ProgressEvent[];
  updated_at: Date | string;
};
export function assembleProjectProgress(input: {
  cards: Card[];
  participations: Participation[];
  today: string;
  from: string;
  to: string;
}) {
  const projects = new Map<string, ProgressProject>();
  const allDays = new Map<string, Set<string>>();
  const memberDays = new Map<string, Set<string>>();
  const latestSourceTimes = new Map<string, number>();
  const get = (row: {
    partner_id: string;
    project_id: string;
    project_name: string;
    project_description?: string | null;
    updated_at: Date | string;
  }) => {
    const key = `${row.partner_id}:${row.project_id}`;
    let project = projects.get(key);
    if (!project) {
      project = {
        partnerId: row.partner_id,
        projectId: row.project_id,
        projectName: row.project_name,
        projectDescription: row.project_description?.trim() || null,
        version: 0,
        events: [],
        metrics: calculateProgress([], input.today),
        days: [],
        contributionDays: 0,
        undatedCount: 0,
        conflictingDays: [],
        reviewId: null,
        lastUpdatedAt: null,
        latestProgress: null,
      };
      projects.set(key, project);
      allDays.set(key, new Set());
    }
    const updated = new Date(row.updated_at).toISOString();
    if (!project.lastUpdatedAt || project.lastUpdatedAt < updated)
      project.lastUpdatedAt = updated;
    return project;
  };
  const add = (
    project: ProgressProject,
    date: unknown,
    entry: ProgressProject["days"][number]["entries"][number],
    updatedAt: Date | string,
  ) => {
    if (
      typeof date !== "string" ||
      !progressDateSchema.safeParse(date).success ||
      date > input.today
    ) {
      project.undatedCount++;
      return;
    }
    allDays.get(`${project.partnerId}:${project.projectId}`)!.add(date);
    const member = memberDays.get(project.partnerId) ?? new Set<string>();
    member.add(date);
    memberDays.set(project.partnerId, member);
    const key = `${project.partnerId}:${project.projectId}`;
    const time = new Date(updatedAt).getTime();
    if (
      !project.latestProgress ||
      date > project.latestProgress.date ||
      (date === project.latestProgress.date &&
        (time > (latestSourceTimes.get(key) ?? 0) ||
          (time === latestSourceTimes.get(key) && entry.source === "reviewed")))
    ) {
      project.latestProgress = {
        date,
        summary: entry.summary,
        source: entry.source,
      };
      latestSourceTimes.set(key, time);
    }
    if (date < input.from || date > input.to) return;
    let day = project.days.find((day) => day.date === date);
    if (!day) {
      day = { date, entries: [] };
      project.days.push(day);
    }
    if (
      !day.entries.some(
        (existing) =>
          existing.summary === entry.summary &&
          existing.source === entry.source,
      )
    )
      day.entries.push(entry);
  };
  // Daily progress is the approved weekly card content, never raw collection summaries.
  for (const card of input.cards) {
    if (card.review_status !== "approved") continue;
    const project = get(card);
    // Cards arrive newest first, so the link points to the latest approved weekly card.
    project.reviewId ??= card.review_id;
    const status = readProjectStatus(card.payload);
    if (status && !project.currentStatus)
      project.currentStatus = {
        value: status,
        reason:
          typeof card.payload.projectStatusReason === "string"
            ? card.payload.projectStatusReason
            : "",
        confirmedAt:
          card.payload.projectStatusConfirmedAt ??
          new Date(card.updated_at).toISOString(),
        periodKey: card.period_key,
        reviewId: card.review_id,
        source: "work_card",
      };
    const entries = Array.isArray(card.payload.dailyProgress)
      ? card.payload.dailyProgress
      : [];
    for (const [index, entry] of entries.entries()) {
      if (typeof entry?.summary !== "string" || !entry.summary.trim()) continue;
      add(
        project,
        entry.date,
        {
          id: `${card.id}:${index}`,
          summary: entry.summary,
          source: "reviewed",
          reviewId: card.review_id,
          periodKey: card.period_key,
        },
        card.updated_at,
      );
    }
    if (!entries.length) project.undatedCount++;
  }
  for (const row of input.participations) {
    const project = get(row);
    project.events = row.events;
    project.version = row.version;
    project.metrics = calculateProgress(row.events, input.today);
    for (const event of row.events) {
      if (
        event.type === "milestone" &&
        event.projectStatus &&
        event.statusConfirmedAt &&
        (!project.currentStatus ||
          event.statusConfirmedAt > project.currentStatus.confirmedAt)
      )
        project.currentStatus = {
          value: event.projectStatus,
          reason: event.reason,
          confirmedAt: event.statusConfirmedAt,
          periodKey: null,
          reviewId: null,
          source: "manual",
        };
    }
  }
  for (const [key, project] of projects) {
    const days = allDays.get(key)!;
    project.contributionDays = days.size;
    project.days.sort((a, b) => a.date.localeCompare(b.date));
    if (project.metrics.startDate)
      project.conflictingDays = [...days]
        .filter(
          (date) =>
            !project.metrics.intervals.some(
              (interval) =>
                interval.state === "active" &&
                date >= interval.from &&
                date <= interval.to,
            ),
        )
        .sort();
  }
  return {
    projects: [...projects.values()].sort((a, b) =>
      a.projectName.localeCompare(b.projectName, "zh-CN"),
    ),
    memberDays,
  };
}
