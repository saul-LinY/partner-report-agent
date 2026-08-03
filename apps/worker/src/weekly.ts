import { randomUUID } from "node:crypto";
import { sqlClient as sql, weeklyPeriodAt } from "@partner-report/db";

type DuePeriod = {
  id: string;
  tenant_id: string;
  team_id: string;
  period_key: string;
  starts_at: Date;
  ends_at: Date;
  cutoff_at: Date;
  timezone: string;
  template_id: string | null;
  collection_grace_minutes: number;
};

export type WeeklyScheduleResult = {
  closedPeriods: number;
  aggregationJobs: number;
};

export async function ensureCurrentWeeklyPeriods(
  now = new Date(),
  onlyTeamId?: string,
) {
  const teams = await sql<
    Array<{
      tenant_id: string;
      team_id: string;
      timezone: string;
      template_id: string | null;
    }>
  >`
    select t.tenant_id, t.id as team_id, t.timezone,
      (
        select rp.template_id from report_periods rp
        where rp.tenant_id = t.tenant_id and rp.team_id = t.id
        order by rp.starts_at desc limit 1
      ) as template_id
    from teams t
    where t.report_type = 'weekly'
  `;
  let created = 0;

  for (const team of teams) {
    if (onlyTeamId && team.team_id !== onlyTeamId) continue;
    const openRows = await sql<{ id: string }[]>`
      select id from report_periods
      where tenant_id = ${team.tenant_id} and team_id = ${team.team_id}
        and status = 'open' and starts_at <= ${now.toISOString()}
        and ends_at >= ${now.toISOString()}
      limit 1
    `;
    if (openRows[0]) continue;

    const period = weeklyPeriodAt(now, team.timezone);
    const inserted = await sql<{ id: string }[]>`
      insert into report_periods (
        id, tenant_id, team_id, period_key, starts_at, ends_at,
        cutoff_at, timezone, status, template_id
      ) values (
        ${randomUUID()}, ${team.tenant_id}, ${team.team_id}, ${period.periodKey},
        ${period.startsAt.toISOString()}, ${period.endsAt.toISOString()},
        ${period.endsAt.toISOString()}, ${team.timezone}, 'open', ${team.template_id}
      ) on conflict (tenant_id, team_id, period_key) do nothing
      returning id
    `;
    created += inserted.length;
  }

  return created;
}

/** Close due weekly periods and enqueue exactly one aggregation per Partner. */
export async function scheduleDueWeeklyReports(
  now = new Date(),
  onlyPeriodId?: string,
): Promise<WeeklyScheduleResult> {
  const candidates = await sql<DuePeriod[]>`
    select rp.*, t.collection_grace_minutes
    from report_periods rp
    join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
    where rp.status = 'open' and t.report_type = 'weekly'
      and rp.cutoff_at <= ${now.toISOString()}
      and (
        rp.cutoff_at + make_interval(mins => t.collection_grace_minutes) <= ${now.toISOString()}
        or not exists (
          select 1 from plugin_instances pi
          where pi.tenant_id = rp.tenant_id and pi.team_id = rp.team_id and pi.status = 'active'
            and pi.last_collection_period_key is distinct from rp.period_key
        )
      )
    order by rp.cutoff_at
  `;
  const duePeriods = onlyPeriodId
    ? candidates.filter((period) => period.id === onlyPeriodId)
    : candidates;

  let closedPeriods = 0;
  let aggregationJobs = 0;

  for (const candidate of duePeriods) {
    const result = await sql.begin(async (tx) => {
      const lockedRows = await tx<DuePeriod[]>`
        select rp.*, t.collection_grace_minutes from report_periods rp
        join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
        where rp.id = ${candidate.id} and rp.status = 'open' and rp.cutoff_at <= ${now.toISOString()}
        for update
      `;
      const period = lockedRows[0];
      if (!period) return { closed: false, jobs: 0 };

      const partners = await tx<{ partner_id: string }[]>`
        select distinct partner_id
        from session_facts
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and period_id = ${period.id} and current = true and excluded = false
        order by partner_id
      `;
      let jobs = 0;
      const projects = await tx<any[]>`
        select id, name, aliases, allowed_paths, external_ids
        from projects where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and status = 'active' order by name
      `;

      for (const { partner_id: partnerId } of partners) {
        const facts = await tx<any[]>`
          select id, payload
          from session_facts
          where tenant_id = ${period.tenant_id} and partner_id = ${partnerId}
            and period_id = ${period.id} and current = true and excluded = false
          order by created_at, id
        `;
        const reviewRows = await tx<{ id: string }[]>`
          insert into reviews (id, tenant_id, team_id, partner_id, period_id)
          values (${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${partnerId}, ${period.id})
          on conflict (tenant_id, partner_id, period_id)
          do update set updated_at = reviews.updated_at
          returning id
        `;
        const inserted = await tx<{ id: string }[]>`
          insert into agent_jobs (
            id, tenant_id, team_id, partner_id, plugin_instance_id,
            type, idempotency_key, input_payload
          ) values (
            ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${partnerId}, null,
            'AGGREGATE_WORK_ITEMS', ${`weekly-aggregate:${partnerId}:${period.id}`},
            ${JSON.stringify({
              schemaVersion: "1.0",
              aggregationMode: "weekly_report",
              period: {
                id: period.id,
                key: period.period_key,
                startsAt: period.starts_at,
                endsAt: period.ends_at,
                cutoffAt: period.cutoff_at,
              },
              reviewId: reviewRows[0]!.id,
              facts,
              projects,
              constraints: {
                lowConfidenceStaysIndependent: true,
                completedNeedsEvidence: true,
              },
            })}::jsonb
          ) on conflict (tenant_id, idempotency_key) do nothing
          returning id
        `;
        jobs += inserted.length;
      }

      await tx`
        update report_periods set status = 'closed', updated_at = now()
        where id = ${period.id}
      `;

      const nextReference = new Date(
        Math.max(now.getTime(), new Date(period.ends_at).getTime() + 1),
      );
      const next = weeklyPeriodAt(nextReference, period.timezone);
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, timezone, status, template_id
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${next.periodKey},
          ${next.startsAt.toISOString()}, ${next.endsAt.toISOString()},
          ${next.endsAt.toISOString()}, ${period.timezone}, 'open', ${period.template_id}
        ) on conflict (tenant_id, team_id, period_key) do nothing
      `;

      return { closed: true, jobs };
    });
    if (result.closed) closedPeriods += 1;
    aggregationJobs += result.jobs;
  }

  if (!onlyPeriodId) await ensureCurrentWeeklyPeriods(now);

  return { closedPeriods, aggregationJobs };
}
