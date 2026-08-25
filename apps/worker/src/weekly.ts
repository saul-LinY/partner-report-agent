import { randomUUID } from "node:crypto";
import { buildTeamReportWorkCards } from "@partner-report/contracts";
import { stableJsonHash } from "@partner-report/contracts/hash";
import {
  DEFAULT_WEEKLY_PERIOD_RULE,
  sqlClient as sql,
  weeklyPeriodAt,
  weeklyPeriodKeyCandidates,
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
  timezone: string;
  template_id: string | null;
};

export type WeeklyScheduleResult = {
  closedPeriods: number;
  aggregationJobs: number;
  teamReportJobs: number;
};

type AggregationFact = {
  id: string;
  payload: Record<string, any>;
  source_occurred_at?: Date | string | null;
};

export function buildProjectBuckets(
  facts: AggregationFact[],
  projects: Array<{
    id: string;
    name: string;
    description?: string | null;
    description_source_fingerprint?: string | null;
    description_candidate_id?: string | null;
    description_candidate?: string | null;
    description_candidate_source_fingerprint?: string | null;
  }>,
) {
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const buckets = new Map<
    string,
    {
      projectKey: string;
      projectId: string | null;
      projectName: string;
      projectDescription: string;
      projectDescriptionCandidateId: string | null;
      projectDescriptionSourceFingerprint: string | null;
      factIds: string[];
      facts: AggregationFact[];
    }
  >();

  for (const fact of facts) {
    const projectId =
      fact.payload.projectId ?? fact.payload.project?.id ?? null;
    const fingerprint =
      fact.payload.projectRootFingerprint ??
      fact.payload.project?.rootFingerprint ??
      null;
    const projectKey = projectId
      ? `project:${projectId}`
      : fingerprint
        ? `root:${fingerprint}`
        : "unassigned";
    const projectName =
      (projectId ? projectNames.get(projectId) : null) ??
      fact.payload.project?.name ??
      fact.payload.projectHint ??
      "未识别项目";
    const projectRecord = projectId
      ? projects.find((project) => project.id === projectId)
      : null;
    const bucket = buckets.get(projectKey) ?? {
      projectKey,
      projectId,
      projectName,
      projectDescription:
        projectRecord?.description_candidate ??
        projectRecord?.description ??
        "",
      projectDescriptionCandidateId:
        projectRecord?.description_candidate_id ?? null,
      projectDescriptionSourceFingerprint:
        projectRecord?.description_candidate_source_fingerprint ??
        projectRecord?.description_source_fingerprint ??
        null,
      factIds: [] as string[],
      facts: [] as AggregationFact[],
    };
    bucket.factIds.push(fact.id);
    bucket.facts.push(fact);
    buckets.set(projectKey, bucket);
  }

  return [...buckets.values()].sort((left, right) =>
    left.projectName.localeCompare(right.projectName, "zh-CN"),
  );
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
      and (${onlyTeamId ?? null}::uuid is null or t.id = ${onlyTeamId ?? null})
  `;
  let created = 0;
  for (const team of teams) {
    const period = weeklyPeriodAt(
      now,
      team.timezone,
      team.period_rule ?? DEFAULT_WEEKLY_PERIOD_RULE,
    );
    const existingOpen = await sql<{ id: string }[]>`
      select id from report_periods
      where tenant_id = ${team.tenant_id} and team_id = ${team.team_id}
        and status = 'open' and cutoff_at > ${now.toISOString()}
      order by starts_at desc limit 1
    `;
    if (existingOpen[0]) continue;

    for (const periodKey of weeklyPeriodKeyCandidates(period)) {
      const inserted = await sql<{ id: string }[]>`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone, status, template_id
        ) values (
          ${randomUUID()}, ${team.tenant_id}, ${team.team_id}, ${periodKey},
          ${period.startsAt.toISOString()}, ${period.endsAt.toISOString()},
          ${period.cutoffAt.toISOString()}, ${period.submissionDeadlineAt.toISOString()},
          ${team.timezone}, 'open', ${team.template_id}
        ) on conflict (tenant_id, team_id, period_key) do nothing returning id
      `;
      created += inserted.length;
      if (inserted[0]) break;

      const concurrentOpen = await sql<{ id: string }[]>`
        select id from report_periods
        where tenant_id = ${team.tenant_id} and team_id = ${team.team_id}
          and status = 'open' and cutoff_at > ${now.toISOString()}
        order by starts_at desc limit 1
      `;
      if (concurrentOpen[0]) break;
    }
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
  const scopedPeriods = onlyPeriodId
    ? await sql<{ team_id: string }[]>`
        select team_id from report_periods where id = ${onlyPeriodId}
      `
    : [];
  if (onlyPeriodId && !scopedPeriods[0]) {
    return { closedPeriods: 0, aggregationJobs: 0, teamReportJobs: 0 };
  }
  const onlyTeamId = scopedPeriods[0]?.team_id;
  await ensureCurrentWeeklyPeriods(now, onlyTeamId);
  await beginDueClosures(now, onlyPeriodId);
  const candidates = await sql<DuePeriod[]>`
    select rp.*
    from report_periods rp
    join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
    where rp.status = 'closing' and t.report_type = 'weekly'
      and (${onlyPeriodId ?? null}::uuid is null or rp.id = ${onlyPeriodId ?? null})
      and rp.cutoff_at <= ${now.toISOString()}
    order by rp.cutoff_at
  `;
  let closedPeriods = 0;
  let aggregationJobs = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      const locked = await tx<DuePeriod[]>`
        select rp.*
        from report_periods rp
        join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
        where rp.id = ${candidate.id} and rp.status = 'closing'
        for update
      `;
      const period = locked[0];
      if (!period) return { closed: false, jobs: 0 };
      const partners = await tx<{ partner_id: string }[]>`
        select id as partner_id from partners
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and status = 'active'
        order by id
      `;
      let jobs = 0;
      for (const { partner_id: partnerId } of partners) {
        const partnerProjects = await tx<any[]>`
          select p.*,
            candidate.id as description_candidate_id,
            candidate.description as description_candidate,
            candidate.source_fingerprint as description_candidate_source_fingerprint
          from projects p
          left join lateral (
            select id, description, source_fingerprint
            from project_description_candidates
            where tenant_id = ${period.tenant_id} and partner_id = ${partnerId}
              and project_id = p.id and status = 'pending'
            order by created_at desc limit 1
          ) candidate on true
          where p.tenant_id = ${period.tenant_id} and p.team_id = ${period.team_id}
            and p.status = 'active'
          order by p.name
        `;
        const facts = await tx<any[]>`
          select id, payload, source_occurred_at from session_facts
          where tenant_id = ${period.tenant_id} and partner_id = ${partnerId}
            and period_id = ${period.id} and current = true and excluded = false
          order by source_occurred_at nulls last, created_at, id
        `;
        const projectBuckets = buildProjectBuckets(facts, partnerProjects);
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
            ${period.id}, ${JSON.stringify(factIds)}::jsonb, ${stableJsonHash(factIds)},
            ${JSON.stringify(coverageRows[0]?.payload ?? {})}::jsonb
          ) on conflict (tenant_id, partner_id, period_id) do update set
            fact_ids = excluded.fact_ids, checksum = excluded.checksum,
            coverage = excluded.coverage, frozen_at = now()
          returning id
        `;
        const reviewRows = await tx<{ id: string; version: number }[]>`
          insert into reviews (id, tenant_id, team_id, partner_id, period_id)
          values (${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${partnerId}, ${period.id})
          on conflict (tenant_id, partner_id, period_id)
          do update set updated_at = reviews.updated_at returning id, version
        `;
        if (facts.length === 0) {
          const review = reviewRows[0]!;
          const snapshotPayload = {
            reviewId: review.id,
            reviewVersion: review.version,
            periodId: period.id,
            workItems: [],
            excludedWorkItemIds: [],
            coverage: coverageRows[0]?.payload ?? {},
            noReportableActivity: true,
          };
          const checksum = stableJsonHash(snapshotPayload);
          const workItemSnapshotId = randomUUID();
          await tx`
            update reviews set state = 'ITEMS_APPROVED',
              approved_count = 0, excluded_count = 0, pending_count = 0,
              updated_at = now()
            where id = ${review.id} and tenant_id = ${period.tenant_id}
          `;
          await tx`
            insert into work_item_snapshots (
              id, tenant_id, team_id, partner_id, period_id, review_id,
              review_version, checksum, payload, approved_by_actor_type,
              approved_by_actor_id, approved_at
            ) values (
              ${workItemSnapshotId}, ${period.tenant_id}, ${period.team_id},
              ${partnerId}, ${period.id}, ${review.id}, ${review.version},
              ${checksum}, ${JSON.stringify(snapshotPayload)}::jsonb,
              'system', 'weekly-cutoff', now()
            )
          `;
          continue;
        }
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
              projectBuckets,
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
  await ensureCurrentWeeklyPeriods(new Date(now.getTime() + 1), onlyTeamId);
  const teamReportJobs = await scheduleDueTeamReports(onlyPeriodId);
  return { closedPeriods, aggregationJobs, teamReportJobs };
}

/** Generate a Team Report once every cutoff participant has confirmed Work Cards. */
export async function scheduleDueTeamReports(onlyPeriodId?: string) {
  const periods = await sql<any[]>`
    select rp.* from report_periods rp
    where rp.status in ('facts_frozen', 'closed')
      and (${onlyPeriodId ?? null}::uuid is null or rp.id = ${onlyPeriodId ?? null})
    order by rp.cutoff_at
  `;
  let queued = 0;
  for (const period of periods) {
    const result = await sql.begin(async (tx) => {
      const sourceRows = await tx<any[]>`
        select r.partner_id, p.display_name as partner_name,
          r.state as review_state, wis.id as snapshot_id,
          wis.payload as work_item_snapshot
        from reviews r
        join partners p on p.id = r.partner_id and p.tenant_id = r.tenant_id
        left join lateral (
          select snapshot.id, snapshot.payload
          from work_item_snapshots snapshot
          where snapshot.tenant_id = r.tenant_id and snapshot.review_id = r.id
          order by snapshot.created_at desc limit 1
        ) wis on true
        where r.tenant_id = ${period.tenant_id} and r.team_id = ${period.team_id}
          and r.period_id = ${period.id}
        order by p.display_name
      `;
      const confirmed = sourceRows.filter(
        (row) =>
          ["ITEMS_APPROVED", "ITEMS_DISMISSED"].includes(row.review_state) &&
          row.snapshot_id &&
          row.work_item_snapshot,
      );
      const missingPartnerIds = sourceRows
        .filter(
          (row) =>
            !["ITEMS_APPROVED", "ITEMS_DISMISSED"].includes(row.review_state) ||
            !row.snapshot_id ||
            !row.work_item_snapshot,
        )
        .map((row) => row.partner_id);
      const approvedProjects = await tx<
        Array<{ id: string; name: string; description: string }>
      >`
          select id, name, description from projects
          where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
            and status = 'active' and description is not null
        `;
      if (sourceRows.length === 0 || missingPartnerIds.length > 0) return 0;
      const previousRows = await tx<any[]>`
        select trv.id as version_id, previous_period.period_key, trv.payload
        from report_periods previous_period
        join team_reports tr on tr.period_id = previous_period.id
          and tr.tenant_id = previous_period.tenant_id
          and tr.team_id = previous_period.team_id
        join team_report_versions trv on trv.report_id = tr.id and trv.version = tr.current_version
        where previous_period.id = (
          select prior.id from report_periods prior
          where prior.tenant_id = ${period.tenant_id}
            and prior.team_id = ${period.team_id}
            and prior.starts_at < ${period.starts_at}
          order by prior.starts_at desc limit 1
        ) and tr.status = 'LOCKED'
        limit 1
      `;
      const source = {
        workCards: buildTeamReportWorkCards(
          confirmed.map((row) => ({
            partnerId: row.partner_id,
            partnerName: row.partner_name,
            snapshotId: row.snapshot_id,
            workItemSnapshot: row.work_item_snapshot,
          })),
          approvedProjects,
        ),
        missingPartnerIds,
        previousTeamReport: previousRows[0] ?? null,
      };
      const sourceChecksum = stableJsonHash(source);
      const teamReportRows = await tx<{ id: string; status: string }[]>`
        insert into team_reports (
          id, tenant_id, team_id, period_id, status, missing_partner_ids
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${period.id},
          'AGGREGATING', ${JSON.stringify(missingPartnerIds)}::jsonb
        ) on conflict (tenant_id, team_id, period_id) do update set
          status = team_reports.status,
          missing_partner_ids = team_reports.missing_partner_ids,
          updated_at = team_reports.updated_at
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
      if (inserted[0]) {
        await tx`
          update team_reports set status = 'AGGREGATING',
            missing_partner_ids = ${JSON.stringify(missingPartnerIds)}::jsonb,
            updated_at = now()
          where id = ${teamReportRows[0]!.id}
        `;
      }
      return inserted.length;
    });
    queued += result;
  }
  return queued;
}
