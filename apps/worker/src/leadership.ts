import { randomUUID } from "node:crypto";
import {
  computeLeadershipSnapshotPayload,
  sqlClient as sql,
  weeklyReviewSchedule,
} from "@partner-report/db";

type DuePeriod = {
  id: string;
  tenant_id: string;
  team_id: string;
  period_key: string;
  status: string;
  /** The shared client returns timestamps as strings (drizzle replaces the driver's date parsers). */
  cutoff_at: string;
  timezone: string;
};

/**
 * Whether a closed period may be published: its facts are frozen, every member's review is final
 * and no card generation for it is still queued or running. A review reopened after approval with nothing
 * pending counts as final: its approved cards stand, and the member may keep it open without blocking
 * the week's snapshot. A review that never left PENDING because its latest card generation job FAILED
 * permanently is final too: nothing is left to wait for, and the failed job is already ignored below.
 */
async function periodIsFinal(period: DuePeriod) {
  if (!["facts_frozen", "completed", "closed"].includes(period.status))
    return false;
  const [open] = await sql<{ pending: boolean }[]>`
    select (
      exists (
        select 1 from reviews r
        where r.tenant_id = ${period.tenant_id} and r.period_id = ${period.id}
          and r.state not in ('ITEMS_APPROVED', 'ITEMS_DISMISSED')
          and not (r.state = 'IN_PROGRESS' and r.pending_count = 0)
          and not (
            r.state = 'PENDING'
            and (
              select j.status from agent_jobs j
              where j.tenant_id = r.tenant_id and j.type = 'AGGREGATE_WORK_ITEMS'
                and j.input_payload->>'reviewId' = r.id::text
              order by j.created_at desc, j.id desc limit 1
            ) = 'FAILED'
          )
      )
      or exists (
        select 1 from agent_jobs j
        where j.tenant_id = ${period.tenant_id} and j.team_id = ${period.team_id}
          and j.type in ('EXTRACT_COLLECTOR_SESSION', 'AGGREGATE_WORK_ITEMS')
          and j.status in ('PENDING', 'LEASED', 'RETRY_WAIT')
          and (
            j.input_payload->'period'->>'id' = ${period.id}
            or j.input_payload->>'reviewId' in (
              select r.id::text from reviews r
              where r.tenant_id = ${period.tenant_id} and r.period_id = ${period.id}
            )
          )
      )
    ) as pending
  `;
  return !open?.pending;
}

/**
 * Publish the leadership snapshot of every closed period without one (oldest first) once its Monday 13:00
 * has passed and the period is final. Until then (or while generation is unfinished) the previous snapshot
 * stays; a period that only becomes final after the next cutoff is still published later, and a published
 * period is never rewritten, so later member decisions do not alter it. The backlog only reaches back to the
 * team's first snapshot; a team without one only considers its newest closed period, so periods from before
 * snapshots existed are never published retroactively.
 */
export async function publishDueLeadershipSnapshots(
  now = new Date(),
  onlyTenantId?: string,
): Promise<{ published: number }> {
  const candidates = await sql<DuePeriod[]>`
    select rp.id, rp.tenant_id, rp.team_id, rp.period_key, rp.status, rp.cutoff_at, rp.timezone
    from report_periods rp
    where rp.cutoff_at <= ${now.toISOString()}
      and (${onlyTenantId ?? null}::uuid is null or rp.tenant_id = ${onlyTenantId ?? null})
      and not exists (
        select 1 from leadership_snapshots s
        where s.tenant_id = rp.tenant_id and s.team_id = rp.team_id and s.period_id = rp.id
      )
      and rp.cutoff_at >= coalesce(
        (
          select min(s.cutoff_at) from leadership_snapshots s
          where s.tenant_id = rp.tenant_id and s.team_id = rp.team_id
        ),
        (
          select max(p.cutoff_at) from report_periods p
          where p.tenant_id = rp.tenant_id and p.team_id = rp.team_id
            and p.cutoff_at <= ${now.toISOString()}
        )
      )
    order by rp.cutoff_at, rp.id
  `;
  let published = 0;
  for (const period of candidates) {
    try {
      const cutoffAt = new Date(period.cutoff_at);
      const publishAt = weeklyReviewSchedule(
        cutoffAt,
        period.timezone,
      ).publishAt;
      if (publishAt.getTime() > now.getTime()) continue;
      const [existing] = await sql`
        select 1 from leadership_snapshots
        where tenant_id = ${period.tenant_id} and team_id = ${period.team_id}
          and period_id = ${period.id}
      `;
      if (existing || !(await periodIsFinal(period))) continue;
      const payload = await computeLeadershipSnapshotPayload(
        { tenantId: period.tenant_id, teamId: period.team_id },
        { id: period.id, cutoffAt, timezone: period.timezone },
      );
      const inserted = await sql`
        insert into leadership_snapshots (
          id, tenant_id, team_id, period_id, period_key, cutoff_at, published_at, payload
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${period.team_id}, ${period.id},
          ${period.period_key}, ${cutoffAt.toISOString()}, ${now.toISOString()},
          ${JSON.stringify(payload)}::jsonb
        )
        on conflict (tenant_id, team_id, period_id) do nothing
        returning id
      `;
      published += inserted.length;
    } catch (error) {
      // One team's broken period must not stop other teams or the rest of the scheduler sweep.
      console.error("Leadership snapshot publish failed", {
        tenantId: period.tenant_id,
        teamId: period.team_id,
        periodId: period.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { published };
}
