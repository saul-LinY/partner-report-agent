import type {
  Activity,
  ProjectProfileItem,
} from "@partner-report/contracts/member-overview";
import {
  dropInvalidClaims,
  projectProfileNoteSchema,
} from "@partner-report/contracts/project-profile";
import {
  progressDayDistance,
  progressToday,
  type ProjectProgressResponse,
} from "@partner-report/contracts/project-progress";
import { sqlClient as sql } from "./client.js";
import { latestSessionsCte, projectNameJoin } from "./latest-sessions.js";
import {
  assembleProjectProgress,
  type ProjectBlockerMark,
} from "./project-progress.js";
import { syncSessionPreprocess } from "./session-preprocess.js";

/** Why a leadership read could not be answered; callers map `code` to their own error type. */
export class LeadershipDataError extends Error {
  constructor(
    public readonly code: "TEAM_NOT_FOUND" | "INVALID_DATE_RANGE",
    message: string,
  ) {
    super(message);
  }
}

export type TeamScope = { tenantId: string; teamId: string };

/**
 * Approved progress for a team: one consistent snapshot over `from`..`to` (default: this month).
 * `asOf` pins "today" to a past team-local date (a published weekly snapshot's cutoff day).
 */
export async function loadProjectProgress(
  scope: TeamScope,
  query: {
    from?: string | undefined;
    to?: string | undefined;
    asOf?: string | undefined;
  } = {},
): Promise<ProjectProgressResponse> {
  const [team] = await sql<
    { timezone: string }[]
  >`select timezone from teams where id = ${scope.teamId} and tenant_id = ${scope.tenantId}`;
  if (!team) throw new LeadershipDataError("TEAM_NOT_FOUND", "团队不存在。");
  const today = query.asOf ?? progressToday(team.timezone);
  const to = query.to ?? today;
  const from = query.from ?? `${to.slice(0, 7)}-01`;
  if (from > to || progressDayDistance(from, to) > 92 || to > today)
    throw new LeadershipDataError(
      "INVALID_DATE_RANGE",
      "请查看今天及之前不超过 93 天的日期范围。",
    );
  // Read approved daily progress and project timing from one consistent snapshot.
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const members = await tx<
      { id: string; name: string; status: string }[]
    >`select id, display_name as name, status from partners where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId} order by display_name`;
    const cards = await tx<any[]>`
        select wi.id, wi.partner_id, wi.project_id, p.name as project_name, wi.review_id,
          p.description as project_description, rp.period_key, wi.review_status, wi.payload, wi.updated_at,
          coalesce((
            select array_agg(distinct sf.session_id)
            from work_item_facts wif
            join session_facts sf on sf.id = wif.fact_id
            where wif.work_item_id = wi.id
          ), array[]::text[]) as session_ids
        from work_items wi join projects p on p.id = wi.project_id and p.tenant_id = wi.tenant_id and p.team_id = wi.team_id
        join report_periods rp on rp.id = wi.period_id and rp.tenant_id = wi.tenant_id and rp.team_id = wi.team_id
        where wi.tenant_id = ${scope.tenantId} and wi.team_id = ${scope.teamId}
          and wi.review_status = 'approved'
        order by rp.starts_at desc, wi.updated_at desc
      `;
    const participations = await tx<any[]>`
        select pp.partner_id, pp.project_id, p.name as project_name, p.description as project_description, pp.version, pp.events, pp.updated_at
        from project_participations pp join projects p on p.id = pp.project_id and p.tenant_id = pp.tenant_id and p.team_id = pp.team_id
        where pp.tenant_id = ${scope.tenantId} and pp.team_id = ${scope.teamId}
      `;
    // App sources map to projects through `scope:<instance>:<key>` external ids. Imported plugin-era
    // decisions are not the member's current choice, so only App-visible entries count.
    const stopped = await tx<{ partner_id: string; project_id: string }[]>`
        select e.partner_id, p.id as project_id
        from projects p
        join project_scope_entries e on e.tenant_id = p.tenant_id and e.team_id = p.team_id
          and not e.legacy_import
          and p.external_ids @> jsonb_build_array('scope:' || e.plugin_instance_id || ':' || e.scope_key)
        where p.tenant_id = ${scope.tenantId} and p.team_id = ${scope.teamId}
        group by e.partner_id, p.id
        having bool_or(e.status = 'denied') and not bool_or(e.status = 'allowed')
      `;
    const stoppedKeys = new Set(
      stopped.map((row) => `${row.partner_id}:${row.project_id}`),
    );
    const blockerMarks = await tx<ProjectBlockerMark[]>`
        select partner_id, project_id, blocker_date as date, blocker_title as title,
          resolved, resolved_on as "resolvedOn"
        from project_blocker_marks
        where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
      `;
    const assembled = assembleProjectProgress({
      cards,
      participations,
      today,
      from,
      to,
      blockerMarks,
    });
    for (const project of assembled.projects)
      if (stoppedKeys.has(`${project.partnerId}:${project.projectId}`))
        project.collectionStopped = true;
    return {
      today,
      timezone: team.timezone,
      from,
      to,
      generatedAt: new Date().toISOString(),
      members: members.map((m) => ({
        ...m,
        contributionDays: assembled.memberDays.get(m.id)?.size ?? 0,
      })),
      projects: assembled.projects,
    };
  });
}

type SessionRow = {
  day: string;
  partner_id: string;
  partner_name: string;
  project_name: string;
  question_times: Array<string | null>;
};

const DAY_MS = 86_400_000;
const addDays = (date: string, offset: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);

/**
 * Turn timestamps are stored as "10月30日 15:03" (team local time, no year).
 * The year comes from the session's last activity: a turn can never be later
 * than that, so a date that lands after it belongs to the previous year.
 */
export function parseTurnTime(text: string | null, sessionDay: string) {
  const match = /^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/.exec(
    (text ?? "").trim(),
  );
  if (!match) return null;
  const [, month, day, hour, minute] = match;
  const pad = (value: string) => value.padStart(2, "0");
  let year = Number(sessionDay.slice(0, 4));
  let date = `${year}-${pad(month!)}-${pad(day!)}`;
  if (date > addDays(sessionDay, 1))
    date = `${--year}-${pad(month!)}-${pad(day!)}`;
  return { date, time: `${pad(hour!)}:${minute}` };
}

/**
 * AI conversation activity for leadership views. Only sessions kept by
 * preprocessing count. Every conversation turn is placed at its own minute.
 * `asOf` ends the window at a past instant (a published weekly snapshot's cutoff) instead of now: turns after
 * that minute are left out. Sessions are filtered per turn, not by modification time: only the newest copy of a
 * session is kept, so a session continued past the cutoff must still contribute its earlier turns.
 */
export async function loadAiActivity(
  scope: TeamScope,
  days: number,
  asOf?: Date,
): Promise<Activity> {
  const [team] = await sql<
    { timezone: string; today: string; until: string | null }[]
  >`
      select timezone, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today,
        to_char(${asOf?.toISOString() ?? null}::timestamptz at time zone timezone, 'YYYY-MM-DD"T"HH24:MI') as until
      from teams where id = ${scope.teamId} and tenant_id = ${scope.tenantId}`;
  if (!team) throw new LeadershipDataError("TEAM_NOT_FOUND", "团队不存在。");
  await syncSessionPreprocess(scope);
  const to = team.until ? team.until.slice(0, 10) : team.today;
  const from = addDays(to, 1 - days);
  const rows = await sql<SessionRow[]>`
      with ${latestSessionsCte(scope)}
      select to_char(l.modified_at at time zone ${team.timezone}, 'YYYY-MM-DD') as day,
        l.partner_id, pa.display_name as partner_name,
        coalesce(e.display_name, '未命名项目') as project_name, l.question_times
      from latest l
      join partners pa on pa.id = l.partner_id
      join session_preprocess sp on sp.tenant_id = l.tenant_id
        and sp.partner_id = l.partner_id and sp.scope_key = coalesce(l.scope_key, '')
        and sp.agent = l.agent and sp.session_id = l.session_id and sp.verdict = 'keep'
      ${projectNameJoin}
      where l.modified_at >= (${from}::date::timestamp at time zone ${team.timezone})
    `;
  const [dropped] = await sql<{ n: number }[]>`
      select count(*)::int as n from session_preprocess
      where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId} and verdict = 'drop'`;

  type Member = {
    id: string;
    name: string;
    turns: number;
    sessions: number;
    byDay: Record<string, number>;
    byProject: Record<
      string,
      { turns: number; lastActiveDate: string; byDay: Record<string, number> }
    >;
    events: Array<{ t: string; p: string }>;
  };
  const members = new Map<string, Member>();
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const daily = Object.fromEntries(
    dates.map((date) => [date, {} as Record<string, number>]),
  );
  for (const row of rows) {
    const member = members.get(row.partner_id) ?? {
      id: row.partner_id,
      name: row.partner_name,
      turns: 0,
      sessions: 0,
      byDay: {},
      byProject: {},
      events: [],
    };
    members.set(row.partner_id, member);
    let counted = false;
    for (const text of row.question_times) {
      const at = parseTurnTime(text, row.day);
      if (!at || at.date < from || at.date > to) continue;
      if (team.until && `${at.date}T${at.time}` > team.until) continue;
      if (!counted) {
        member.sessions += 1;
        counted = true;
      }
      member.turns += 1;
      member.byDay[at.date] = (member.byDay[at.date] ?? 0) + 1;
      const project = (member.byProject[row.project_name] ??= {
        turns: 0,
        lastActiveDate: "",
        byDay: {},
      });
      project.turns += 1;
      project.byDay[at.date] = (project.byDay[at.date] ?? 0) + 1;
      if (at.date > project.lastActiveDate) project.lastActiveDate = at.date;
      member.events.push({ t: `${at.date}T${at.time}`, p: row.project_name });
      const dayTotals = daily[at.date]!;
      dayTotals[row.project_name] = (dayTotals[row.project_name] ?? 0) + 1;
    }
  }
  const list = [...members.values()]
    .filter((member) => member.turns > 0)
    .map((member) => ({
      ...member,
      activeDays: Object.keys(member.byDay).length,
      events: member.events.sort((a, b) => a.t.localeCompare(b.t)),
    }))
    .sort((a, b) => b.turns - a.turns);

  return {
    timezone: team.timezone,
    from,
    to,
    days,
    totals: { dropped: dropped?.n ?? 0 },
    daily: dates.map((date) => ({ date, byProject: daily[date]! })),
    members: list,
  };
}

/** Plain-language project profiles, one per person and project. */
export async function loadProjectProfiles(
  scope: TeamScope,
): Promise<ProjectProfileItem[]> {
  const rows = await sql<
    {
      id: string;
      partner_id: string;
      project_name: string;
      note: unknown;
      updated_at: Date | string;
      last_error: string | null;
      sessions: number;
    }[]
  >`
      select pr.id, pr.partner_id, e.display_name as project_name, pr.note, pr.updated_at, pr.last_error,
        (select count(*)::int from project_profile_sessions ps
          where ps.profile_id = pr.id and ps.status = 'done') as sessions
      from project_profiles pr
      join project_scope_entries e on e.plugin_instance_id = pr.plugin_instance_id
        and e.scope_key = pr.scope_key
      where pr.tenant_id = ${scope.tenantId} and pr.team_id = ${scope.teamId}
      order by e.display_name, pr.partner_id`;
  return rows.map((row) => ({
    id: row.id,
    partnerId: row.partner_id,
    projectName: row.project_name,
    // Re-checked on every read so tightened wording rules apply to stored notes too.
    note: dropInvalidClaims(projectProfileNoteSchema.parse(row.note)).note,
    updatedAt: new Date(row.updated_at).toISOString(),
    sessions: row.sessions,
    failed: Boolean(row.last_error),
  }));
}
