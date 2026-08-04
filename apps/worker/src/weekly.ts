import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_WEEKLY_PERIOD_RULE,
  sqlClient as sql,
  weeklyPeriodAt,
  type WeeklyPeriodRule,
} from "@partner-report/db";

type DuePeriod = {
  id: string;
  tenant_id: string;
  team_id: string;
  period_key: string;
  starts_at: Date;
  ends_at: Date;
  cutoff_at: Date;
  submission_deadline_at: Date;
  timezone: string;
  template_id: string | null;
  collection_grace_minutes: number;
  period_rule: WeeklyPeriodRule;
};

export type WeeklyScheduleResult = {
  closedPeriods: number;
  aggregationJobs: number;
  teamReportJobs: number;
};

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function ensureCurrentWeeklyPeriods(
  now = new Date(),
  onlyTeamId?: string,
) {
  const teams = await sql<
    Array<{
      tenant_id: string;
      team_id: string;
      timezone: string;
      period_rule: WeeklyPeriodRule;
      template_id: string | null;
    }>
  >`
    select t.tenant_id, t.id as team_id, t.timezone, t.period_rule,
      (
        select rp.template_id from report_periods rp
        where rp.tenant_id = t.tenant_id and rp.team_id = t.id
        order by rp.starts_at desc limit 1
      ) as template_id
    from teams t where t.report_type = 'weekly'
  `;
  let created = 0;
  for (const team of teams) {
    if (onlyTeamId && team.team_id !== onlyTeamId) continue;
    const period = weeklyPeriodAt(
      now,
      team.timezone,
      team.period_rule ?? DEFAULT_WEEKLY_PERIOD_RULE,
    );
    const inserted = await sql<{ id: string }[]>`
      insert into report_periods (
        id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
        submission_deadline_at, timezone, status, template_id
      ) values (
        ${randomUUID()}, ${team.tenant_id}, ${team.team_id}, ${period.periodKey},
        ${period.startsAt.toISOString()}, ${period.endsAt.toISOString()},
        ${period.cutoffAt.toISOString()}, ${period.submissionDeadlineAt.toISOString()},
        ${team.timezone}, 'open', ${team.template_id}
      ) on conflict (tenant_id, team_id, period_key) do nothing returning id
    `;
    created += inserted.length;
  }
  return created;
}

async function beginDueClosures(now: Date, onlyPeriodId?: string) {
  return sql`
    update report_periods set status = 'closing', updated_at = now()
    where status = 'open' and cutoff_at <= ${now.toISOString()}
      and (${onlyPeriodId ?? null}::uuid is null or id = ${onlyPeriodId ?? null})
  `;
}

/** Freeze due Facts and enqueue one immutable aggregation job per Partner. */
export async function scheduleDueWeeklyReports(
  now = new Date(),
  onlyPeriodId?: string,
): Promise<WeeklyScheduleResult> {
  await ensureCurrentWeeklyPeriods(now);
  await beginDueClosures(now, onlyPeriodId);
  const candidates = await sql<DuePeriod[]>`
    select rp.*, t.collection_grace_minutes, t.period_rule
    from report_periods rp
    join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
    where rp.status = 'closing' and t.report_type = 'weekly'
      and (${onlyPeriodId ?? null}::uuid is null or rp.id = ${onlyPeriodId ?? null})
      and (
        rp.cutoff_at + make_interval(mins => t.collection_grace_minutes) <= ${now.toISOString()}
        or (
          not exists (
            select 1 from collection_runs active_run
            where active_run.period_id = rp.id
              and active_run.status in ('STARTED', 'RUNNING', 'CONTINUATION_PENDING')
          )
          and not exists (
            select 1 from plugin_instances pi
            where pi.tenant_id = rp.tenant_id and pi.team_id = rp.team_id
              and pi.status = 'active'
              and not exists (
                select 1 from collection_runs completed_run
                where completed_run.plugin_instance_id = pi.id
                  and completed_run.period_id = rp.id
                  and completed_run.status = 'COMPLETED'
                  and completed_run.window_ends_at >= rp.cutoff_at - interval '24 hours'
              )
          )
        )
      )
    order by rp.cutoff_at
  `;
  let closedPeriods = 0;
  let aggregationJobs = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      const locked = await tx<DuePeriod[]>`
        select rp.*, t.collection_grace_minutes, t.period_rule
        from report_periods rp
        join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
        where rp.id = ${candidate.id} and rp.status = 'closing'
        for update
      `;
      const period = locked[0];
      if (!period) return { closed: false, jobs: 0 };
      const partners = await tx<{ partner_id: string }[]>`
        select distinct partner_id from session_facts
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and period_id = ${period.id} and current = true and excluded = false
        order by partner_id
      `;
      const projects = await tx<any[]>`
        select id, name, aliases, allowed_paths, external_ids from projects
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and status = 'active' order by name
      `;
      let jobs = 0;
      for (const { partner_id: partnerId } of partners) {
        const facts = await tx<any[]>`
          select id, payload from session_facts
          where tenant_id = ${period.tenant_id} and partner_id = ${partnerId}
            and period_id = ${period.id} and current = true and excluded = false
          order by source_occurred_at nulls last, created_at, id
        `;
        const coverageRows = await tx<any[]>`
          select payload from coverage_snapshots
          where tenant_id = ${period.tenant_id} and partner_id = ${partnerId}
            and period_id = ${period.id}
          order by created_at desc limit 1
        `;
        const factIds = facts.map((fact) => fact.id);
        const snapshotRows = await tx<{ id: string }[]>`
          insert into fact_snapshots (
            id, tenant_id, team_id, partner_id, period_id, fact_ids, checksum, coverage
          ) values (
            ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${partnerId},
            ${period.id}, ${JSON.stringify(factIds)}::jsonb, ${checksum(factIds)},
            ${JSON.stringify(coverageRows[0]?.payload ?? {})}::jsonb
          ) on conflict (tenant_id, partner_id, period_id) do update set
            fact_ids = excluded.fact_ids, checksum = excluded.checksum,
            coverage = excluded.coverage, frozen_at = now()
          returning id
        `;
        const reviewRows = await tx<{ id: string }[]>`
          insert into reviews (id, tenant_id, team_id, partner_id, period_id)
          values (${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${partnerId}, ${period.id})
          on conflict (tenant_id, partner_id, period_id)
          do update set updated_at = reviews.updated_at returning id
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
              factSnapshotId: snapshotRows[0]!.id,
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
            })}::jsonb
          ) on conflict (tenant_id, idempotency_key) do nothing returning id
        `;
        jobs += inserted.length;
      }
      await tx`
        update coverage_snapshots set immutable = true
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and period_id = ${period.id}
      `;
      await tx`
        update report_periods set status = 'facts_frozen', facts_frozen_at = now(), updated_at = now()
        where id = ${period.id}
      `;
      return { closed: true, jobs };
    });
    if (result.closed) closedPeriods += 1;
    aggregationJobs += result.jobs;
  }
  await ensureCurrentWeeklyPeriods(new Date(now.getTime() + 1));
  const teamReportJobs = await scheduleDueTeamReports(now, onlyPeriodId);
  return { closedPeriods, aggregationJobs, teamReportJobs };
}

/** Generate or refresh a Team Draft when everyone submits or the deadline passes. */
export async function scheduleDueTeamReports(
  now = new Date(),
  onlyPeriodId?: string,
) {
  const periods = await sql<any[]>`
    select rp.* from report_periods rp
    where rp.status in ('facts_frozen', 'closed')
      and (${onlyPeriodId ?? null}::uuid is null or rp.id = ${onlyPeriodId ?? null})
      and (
        rp.submission_deadline_at <= ${now.toISOString()}
        or not exists (
          select 1 from partners p
          where p.tenant_id = rp.tenant_id and p.team_id = rp.team_id and p.status = 'active'
            and not exists (
              select 1 from individual_reports ir
              where ir.tenant_id = rp.tenant_id and ir.partner_id = p.id
                and ir.period_id = rp.id and ir.status = 'LOCKED'
            )
        )
      )
    order by rp.submission_deadline_at
  `;
  let queued = 0;
  for (const period of periods) {
    const result = await sql.begin(async (tx) => {
      const reportRows = await tx<any[]>`
        select p.id as partner_id, p.display_name as partner_name,
          ir.id as report_id, irv.id as version_id, irv.version, irv.payload
        from partners p
        left join individual_reports ir on ir.tenant_id = p.tenant_id
          and ir.partner_id = p.id and ir.period_id = ${period.id} and ir.status = 'LOCKED'
        left join individual_report_versions irv on irv.report_id = ir.id
          and irv.version = ir.current_version
        where p.tenant_id = ${period.tenant_id} and p.team_id = ${period.team_id}
          and p.status = 'active'
        order by p.display_name
      `;
      const submitted = reportRows.filter((row) => row.version_id);
      const missingPartnerIds = reportRows
        .filter((row) => !row.version_id)
        .map((row) => row.partner_id);
      const previousRows = await tx<any[]>`
        select trv.id as version_id, trv.payload
        from team_reports tr
        join report_periods previous_period on previous_period.id = tr.period_id
        join team_report_versions trv on trv.report_id = tr.id and trv.version = tr.current_version
        where tr.tenant_id = ${period.tenant_id} and tr.team_id = ${period.team_id}
          and tr.status = 'LOCKED' and previous_period.starts_at < ${period.starts_at}
        order by previous_period.starts_at desc limit 1
      `;
      const projects = await tx<any[]>`
        select id, name, aliases, external_ids
        from projects
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and status = 'active'
        order by name
      `;
      const source = {
        individualReports: submitted.map((row) => ({
          partnerId: row.partner_id,
          partnerName: row.partner_name,
          versionId: row.version_id,
          version: row.version,
          payload: row.payload,
        })),
        missingPartnerIds,
        projects,
        previousTeamReport: previousRows[0] ?? null,
      };
      const sourceChecksum = checksum(source);
      const teamReportRows = await tx<{ id: string; status: string }[]>`
        insert into team_reports (
          id, tenant_id, team_id, period_id, status, missing_partner_ids
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${period.id},
          'AGGREGATING', ${JSON.stringify(missingPartnerIds)}::jsonb
        ) on conflict (tenant_id, team_id, period_id) do update set
          status = case when team_reports.status = 'LOCKED' then 'LOCKED' else 'AGGREGATING' end,
          missing_partner_ids = case when team_reports.status = 'LOCKED'
            then team_reports.missing_partner_ids else excluded.missing_partner_ids end,
          updated_at = now()
        returning id, status
      `;
      if (teamReportRows[0]?.status === "LOCKED") return 0;
      const inserted = await tx<{ id: string }[]>`
        insert into agent_jobs (
          id, tenant_id, team_id, partner_id, type, idempotency_key, input_payload
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, null,
          'GENERATE_TEAM_REPORT', ${`team-report:${period.id}:${sourceChecksum}`},
          ${JSON.stringify({
            schemaVersion: "1.0",
            reportId: teamReportRows[0]!.id,
            period: {
              id: period.id,
              key: period.period_key,
              startsAt: period.starts_at,
              endsAt: period.ends_at,
            },
            sourceChecksum,
            ...source,
          })}::jsonb
        ) on conflict (tenant_id, idempotency_key) do nothing returning id
      `;
      return inserted.length;
    });
    queued += result;
  }
  return queued;
}
