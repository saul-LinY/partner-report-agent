import { z } from "zod";
import {
  memberProjects,
  type MemberProject,
  type PersonalData,
  type PersonalOwnedProject,
  type PersonalWeekItems,
  type PersonalWeekProject,
} from "@partner-report/contracts/member-overview";
import {
  progressDayDistance,
  progressToday,
} from "@partner-report/contracts/project-progress";
import {
  loadAiActivity,
  loadProjectProfiles,
  loadProjectProgress,
  sqlClient as sql,
  weeklyReviewSchedule,
  LeadershipDataError,
} from "@partner-report/db";

/** Projects that were active in this many past days stay on the page even with nothing this week. */
const ACTIVITY_DAYS = 90;

const SHOWN = { outcome: 3, decision: 2, blocker: 2 } as const;

type WeekKind = keyof typeof SHOWN;

/** The part of a stored `session_facts` row this page reads. */
export type WeekFact = {
  sessionId: string;
  project: string;
  contributions: Array<{
    kind: string;
    text: string;
    plain?: string | undefined;
    date: string;
  }>;
};

export type PersonalWeekInput = {
  now: Date;
  timezone: string;
  member: { id: string; name: string };
  period: { periodKey: string; startsAt: Date; cutoffAt: Date };
  /** Oldest first: the order contributions were recorded in. */
  facts: WeekFact[];
  /** All of the member's turns in the activity window, "YYYY-MM-DDTHH:mm" team time. */
  events: Array<{ t: string; p: string }>;
  /** The activity window's first and last team day. */
  window: { from: string; to: string };
  /** The member's last activity date per project name, over the activity window. */
  lastActiveDate: Record<string, string>;
  /** Names of the projects the member currently allows to be collected. */
  allowed: ReadonlySet<string>;
  oneLines: ReadonlyMap<string, string>;
  /** The member's project cards by the leadership page's rule (`memberProjects`), computed live. */
  memberProjects: MemberProject[];
  lastUpload: { at: Date; status: string } | null;
};

/** "YYYY-MM-DDTHH:mm" on the team's wall clock, the same form as activity events. */
export function teamMinute(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function items(
  entries: Array<{ text: string; date: string }>,
  shown: number,
): PersonalWeekItems {
  // Stable: contributions of one day stay in recorded order, so the last ones are the newest.
  const ordered = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  return {
    items: ordered
      .slice(-shown)
      .reverse()
      .map((entry) => entry.text),
    total: ordered.length,
  };
}

/** Everything the App's 本周进展 page shows, from rows already read. Pure. */
export function assemblePersonalWeek(input: PersonalWeekInput): PersonalData {
  const { now, timezone, period } = input;
  const startMinute = teamMinute(period.startsAt, timezone);
  const closed = period.cutoffAt.getTime() <= now.getTime();
  const endMinute = teamMinute(closed ? period.cutoffAt : now, timezone);
  const week = input.events.filter(
    (event) =>
      event.t >= startMinute &&
      (closed ? event.t < endMinute : event.t <= endMinute),
  );

  const byProject = new Map<
    string,
    {
      sessions: Set<string>;
      entries: Record<WeekKind, Array<{ text: string; date: string }>>;
    }
  >();
  for (const fact of input.facts) {
    const project = byProject.get(fact.project) ?? {
      sessions: new Set<string>(),
      entries: { outcome: [], decision: [], blocker: [] },
    };
    byProject.set(fact.project, project);
    project.sessions.add(fact.sessionId);
    for (const contribution of fact.contributions)
      if (contribution.kind in SHOWN)
        project.entries[contribution.kind as WeekKind].push({
          // Facts extracted before `plain` existed fall back to the original sentence.
          text: contribution.plain?.trim() || contribution.text,
          date: contribution.date,
        });
  }

  const names = new Set(byProject.keys());
  for (const name of Object.keys(input.lastActiveDate))
    if (input.allowed.has(name)) names.add(name);

  const projects: PersonalWeekProject[] = [...names].map((name) => {
    const facts = byProject.get(name);
    const mine = week.filter((event) => event.p === name);
    return {
      name,
      oneLine: input.oneLines.get(name) ?? null,
      sessions: facts?.sessions.size ?? 0,
      turns: mine.length,
      lastAt: mine.reduce<string | null>(
        (last, event) => (last === null || event.t > last ? event.t : last),
        null,
      ),
      lastActiveDate: input.lastActiveDate[name] ?? null,
      outcomes: items(facts?.entries.outcome ?? [], SHOWN.outcome),
      decisions: items(facts?.entries.decision ?? [], SHOWN.decision),
      problems: items(facts?.entries.blocker ?? [], SHOWN.blocker),
    };
  });
  const active = (project: PersonalWeekProject) =>
    project.sessions > 0 || project.turns > 0;
  projects.sort(
    (a, b) =>
      Number(active(b)) - Number(active(a)) ||
      (active(a)
        ? b.turns - a.turns
        : (b.lastActiveDate ?? "").localeCompare(a.lastActiveDate ?? "")) ||
      a.name.localeCompare(b.name),
  );

  const startDate = progressToday(timezone, period.startsAt);
  const lastDate = [
    progressToday(timezone, now),
    progressToday(timezone, period.cutoffAt),
  ]
    .sort()
    .at(0)!;
  const { autoApproveAt, publishAt } = weeklyReviewSchedule(
    period.cutoffAt,
    timezone,
  );
  const history = input.events.filter((event) => input.allowed.has(event.p));
  // The leadership page's 负责的项目: projects moving (ok or blocked), in its order; never one the member stopped sharing.
  const owned: PersonalOwnedProject[] = input.memberProjects
    .filter(
      (item) =>
        (item.state === "ok" || item.state === "blocked") &&
        input.allowed.has(item.project.projectName),
    )
    .map(({ project, profile }) => ({
      name: project.projectName,
      oneLine: profile?.note.oneLine.text.trim() || null,
      focus:
        project.currentFocus?.text.trim() ||
        profile?.note.status.text.trim() ||
        null,
      intro: profile?.note.intro.text.trim() || null,
      contributionDays: project.contributionDays,
      features: profile?.note.features.map((item) => item.text) ?? [],
      openIssues: profile?.note.openIssues.map((item) => item.text) ?? [],
    }));

  return {
    generatedAt: now.toISOString(),
    timezone,
    member: input.member,
    period: {
      periodKey: period.periodKey,
      startsAt: period.startsAt.toISOString(),
      cutoffAt: period.cutoffAt.toISOString(),
      autoApproveAt: autoApproveAt.toISOString(),
      publishAt: publishAt.toISOString(),
    },
    lastUpload: input.lastUpload && {
      at: input.lastUpload.at.toISOString(),
      status: input.lastUpload.status,
    },
    totals: {
      sessions: new Set(input.facts.map((fact) => fact.sessionId)).size,
      turns: week.length,
      activeDays: new Set(week.map((event) => event.t.slice(0, 10))).size,
      elapsedDays: Math.max(0, progressDayDistance(startDate, lastDate) + 1),
    },
    events: week,
    projects,
    history: { ...input.window, events: history },
    owned,
  };
}

const contributionSchema = z.object({
  kind: z.string(),
  text: z.string(),
  plain: z.string().optional(),
  date: z.string(),
});
const factPayloadSchema = z.object({
  project: z.object({ name: z.string() }),
  contributions: z.array(z.unknown()),
});

type FactRow = { session_id: string; payload: unknown };

/** The facts of one member and period that still count, oldest first; unreadable ones are skipped. */
function weekFacts(rows: FactRow[]): WeekFact[] {
  const facts: WeekFact[] = [];
  for (const row of rows) {
    const payload = factPayloadSchema.safeParse(row.payload);
    if (!payload.success) continue;
    facts.push({
      sessionId: row.session_id,
      project: payload.data.project.name,
      contributions: payload.data.contributions.flatMap((item) => {
        const parsed = contributionSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    });
  }
  return facts;
}

/**
 * The member's own current week, read from the system: the team's open weekly period, the kept
 * sessions' extracted contributions, and the turn activity inside the period window.
 */
export async function loadPersonalWeek(
  actor: { tenantId: string; teamId: string; partnerId: string },
  now = new Date(),
): Promise<PersonalData> {
  const scope = { tenantId: actor.tenantId, teamId: actor.teamId };
  const [team] = await sql<{ timezone: string }[]>`
    select timezone from teams where id = ${actor.teamId} and tenant_id = ${actor.tenantId}`;
  if (!team) throw new LeadershipDataError("TEAM_NOT_FOUND", "团队不存在。");
  const [member] = await sql<{ id: string; name: string }[]>`
    select id, display_name as name from partners
    where id = ${actor.partnerId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
  if (!member) throw new LeadershipDataError("TEAM_NOT_FOUND", "成员不存在。");

  // The period still collecting; once none is, the newest one.
  type PeriodRow = {
    id: string;
    period_key: string;
    starts_at: Date;
    cutoff_at: Date;
  };
  const [open] = await sql<PeriodRow[]>`
    select id, period_key, starts_at, cutoff_at from report_periods
    where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      and cutoff_at > ${now.toISOString()}
    order by cutoff_at limit 1`;
  const [period] = open
    ? [open]
    : await sql<PeriodRow[]>`
        select id, period_key, starts_at, cutoff_at from report_periods
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        order by cutoff_at desc limit 1`;
  if (!period)
    throw new LeadershipDataError("TEAM_NOT_FOUND", "团队还没有统计周期。");

  const [rows, activity, profiles, progress, allowed, uploads] =
    await Promise.all([
      sql<FactRow[]>`
      select session_id, payload from session_facts
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and partner_id = ${actor.partnerId} and period_id = ${period.id}
        and current = true and excluded = false
      order by source_occurred_at, created_at, id`,
      loadAiActivity(scope, ACTIVITY_DAYS),
      loadProjectProfiles(scope),
      loadProjectProgress(scope),
      sql<{ name: string }[]>`
      select display_name as name from project_scope_entries
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and partner_id = ${actor.partnerId} and status = 'allowed'
        and not legacy_import`,
      sql<{ at: Date; status: string }[]>`
      select coalesce(u.completed_at, u.created_at) as at, u.status
      from collector_uploads u join collector_devices d on d.id = u.device_id
      where d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
        and d.partner_id = ${actor.partnerId} and d.status <> 'test'
        and u.status = 'completed'
      order by coalesce(u.completed_at, u.created_at) desc limit 1`,
    ]);
  const mine = activity.members.find((item) => item.id === actor.partnerId);
  const oneLines = new Map<string, string>();
  for (const profile of profiles)
    if (profile.partnerId === actor.partnerId && profile.note.oneLine.text)
      oneLines.set(profile.projectName, profile.note.oneLine.text);
  // Blockers count from the newest period whose work cards exist, as the leadership page counts its latest card.
  const [closed] = await sql<{ period_key: string }[]>`
    select period_key from report_periods
    where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      and cutoff_at <= ${now.toISOString()}
    order by cutoff_at desc limit 1`;
  const [upload] = uploads;
  return assemblePersonalWeek({
    now,
    timezone: team.timezone,
    member,
    period: {
      periodKey: period.period_key,
      startsAt: new Date(period.starts_at),
      cutoffAt: new Date(period.cutoff_at),
    },
    facts: weekFacts(rows),
    events: mine?.events ?? [],
    window: { from: activity.from, to: activity.to },
    lastActiveDate: Object.fromEntries(
      Object.entries(mine?.byProject ?? {}).map(([name, project]) => [
        name,
        project.lastActiveDate,
      ]),
    ),
    allowed: new Set(allowed.map((row) => row.name)),
    oneLines,
    memberProjects: memberProjects(
      actor.partnerId,
      progress,
      activity,
      profiles,
      closed?.period_key,
    ),
    lastUpload: upload
      ? { at: new Date(upload.at), status: upload.status }
      : null,
  });
}
