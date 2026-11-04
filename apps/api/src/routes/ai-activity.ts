import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  latestSessionsCte,
  projectNameJoin,
  sqlClient as sql,
  syncSessionPreprocess,
} from "@partner-report/db";
import { ApiError, requireWebActor } from "../common.js";

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
  if (date > addDays(sessionDay, 1)) date = `${--year}-${pad(month!)}-${pad(day!)}`;
  return { date, time: `${pad(hour!)}:${minute}` };
}

/**
 * AI conversation activity for leadership views. Only sessions kept by
 * preprocessing count. Every conversation turn is placed at its own minute.
 */
export async function aiActivityRoutes(app: FastifyInstance) {
  app.get("/v1/admin/ai-activity", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({ days: z.coerce.number().int().min(7).max(90).default(28) })
      .strict()
      .parse(request.query);
    const scope = { tenantId: actor.tenantId, teamId: actor.teamId };
    const [team] = await sql<{ timezone: string; today: string }[]>`
      select timezone, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today
      from teams where id = ${scope.teamId} and tenant_id = ${scope.tenantId}`;
    if (!team) throw new ApiError(404, "TEAM_NOT_FOUND", "团队不存在。");
    await syncSessionPreprocess(scope);
    const to = team.today;
    const from = addDays(to, 1 - query.days);
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
    const dates = Array.from({ length: query.days }, (_, i) => addDays(from, i));
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
      member.sessions += 1;
      for (const text of row.question_times) {
        const at = parseTurnTime(text, row.day);
        if (!at || at.date < from || at.date > to) continue;
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
      days: query.days,
      totals: { dropped: dropped?.n ?? 0 },
      daily: dates.map((date) => ({ date, byProject: daily[date]! })),
      members: list,
    };
  });
}
