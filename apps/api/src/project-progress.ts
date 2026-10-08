import { readProjectStatus } from "@partner-report/contracts/project-status";
import {
  calculateProgress,
  progressDateSchema,
  type ProgressEvent,
  type ProjectKeyEvent,
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
  session_ids?: string[];
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
  const projectSessionKeys = new Map<string, Set<string>>();
  const projectPeriods = new Map<string, Set<string>>();
  const latestSourceTimes = new Map<string, number>();
  const keyEventTypes = new Set<ProjectKeyEvent["type"]>([
    "goal_change",
    "milestone",
    "decision",
    "blocker",
    "stage_change",
  ]);
  const get = (row: {
    partner_id: string;
    project_id: string;
    project_name: string;
    project_description?: string | null;
    payload?: Record<string, any>;
    updated_at: Date | string;
  }) => {
    const key = `${row.partner_id}:${row.project_id}`;
    let project = projects.get(key);
    if (!project) {
      project = {
        partnerId: row.partner_id,
        projectId: row.project_id,
        projectName: row.project_name,
        projectDescription:
          (typeof row.payload?.projectDescription === "string"
            ? row.payload.projectDescription.trim()
            : "") ||
          row.project_description?.trim() ||
          null,
        version: 0,
        events: [],
        metrics: calculateProgress([], input.today),
        days: [],
        contributionDays: 0,
        firstContributionDate: null,
        lastContributionDate: null,
        undatedCount: 0,
        conflictingDays: [],
        reviewId: null,
        lastUpdatedAt: null,
        currentFocus: null,
        keyEvents: [],
        aiEvidence: {
          sessionCount: 0,
          periodCount: 0,
          workCardCount: 0,
          lastAnalyzedAt: null,
        },
        latestProgress: null,
      };
      projects.set(key, project);
      allDays.set(key, new Set());
      projectSessionKeys.set(key, new Set());
      projectPeriods.set(key, new Set());
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
    const projectKey = `${project.partnerId}:${project.projectId}`;
    const sessionKeys = projectSessionKeys.get(projectKey)!;
    for (const sessionId of card.session_ids ?? []) {
      if (typeof sessionId === "string" && sessionId)
        sessionKeys.add(sessionId);
    }
    if (card.period_key) projectPeriods.get(projectKey)!.add(card.period_key);
    project.aiEvidence.workCardCount += 1;
    if (
      !project.currentFocus &&
      typeof card.payload.currentFocus === "string"
    ) {
      const text = card.payload.currentFocus.trim();
      if (text)
        project.currentFocus = {
          text,
          periodKey: card.period_key ?? null,
          reviewId: card.review_id ?? null,
        };
    }
    const keyEvents = Array.isArray(card.payload.keyEvents)
      ? card.payload.keyEvents
      : [];
    for (const event of keyEvents) {
      if (
        typeof event?.date !== "string" ||
        !progressDateSchema.safeParse(event.date).success ||
        event.date > input.today ||
        typeof event?.type !== "string" ||
        !keyEventTypes.has(event.type as ProjectKeyEvent["type"]) ||
        typeof event?.title !== "string" ||
        typeof event?.detail !== "string"
      )
        continue;
      const title = event.title.trim();
      const detail = event.detail.trim();
      if (!title || !detail) continue;
      if (
        project.keyEvents.some(
          (existing) =>
            existing.date === event.date &&
            existing.title === title &&
            existing.detail === detail,
        )
      )
        continue;
      project.keyEvents.push({
        date: event.date,
        type: event.type as ProjectKeyEvent["type"],
        title,
        detail,
        periodKey: card.period_key ?? null,
        reviewId: card.review_id ?? null,
      });
    }
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
    const sortedDays = [...days].sort();
    project.firstContributionDate = sortedDays[0] ?? null;
    project.lastContributionDate = sortedDays.at(-1) ?? null;
    project.aiEvidence.sessionCount = projectSessionKeys.get(key)!.size;
    project.aiEvidence.periodCount = projectPeriods.get(key)!.size;
    project.aiEvidence.lastAnalyzedAt = project.lastUpdatedAt;
    project.keyEvents.sort((a, b) => b.date.localeCompare(a.date));
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
