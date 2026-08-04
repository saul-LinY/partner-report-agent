import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  ensureCurrentWeeklyPeriods,
  scheduleDueWeeklyReports,
} from "./weekly.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("weekly report scheduling", () => {
  const fixture = {
    tenant: randomUUID(),
    team: randomUUID(),
    partner: randomUUID(),
    period: randomUUID(),
    fact: randomUUID(),
  };

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenant}, 'Weekly Fixture')`;
      await tx`
        insert into teams (id, tenant_id, name, timezone, report_type)
        values (${fixture.team}, ${fixture.tenant}, 'Weekly Team', 'Asia/Shanghai', 'weekly')
      `;
      await tx`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${fixture.partner}, ${fixture.tenant}, ${fixture.team}, 'weekly@example.com', 'Weekly Partner')
      `;
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone
        ) values (
          ${fixture.period}, ${fixture.tenant}, ${fixture.team}, '2026-W31',
          '2026-07-31T06:00:00.000Z', '2026-08-07T06:00:00.000Z',
          '2026-08-07T06:00:00.000Z', '2026-08-10T02:00:00.000Z',
          'Asia/Shanghai'
        )
      `;
      await tx`
        insert into session_facts (
          id, tenant_id, team_id, partner_id, period_id, session_id,
          external_fact_id, source_revision, source_hash, payload
        ) values (
          ${fixture.fact}, ${fixture.tenant}, ${fixture.team}, ${fixture.partner}, ${fixture.period},
          'fixture-session', 'fixture-fact', 1, 'fixture-source',
          '{"summary":"本周完成项目里程碑","status":"completed"}'::jsonb
        )
      `;
    });
  });

  afterAll(async () => {
    await sql.begin(async (tx) => {
      await tx`delete from agent_jobs where tenant_id = ${fixture.tenant}`;
      await tx`delete from reviews where tenant_id = ${fixture.tenant}`;
      await tx`delete from fact_snapshots where tenant_id = ${fixture.tenant}`;
      await tx`delete from session_facts where id = ${fixture.fact}`;
      await tx`delete from report_periods where team_id = ${fixture.team}`;
      await tx`delete from partners where id = ${fixture.partner}`;
      await tx`delete from teams where id = ${fixture.team}`;
      await tx`delete from tenants where id = ${fixture.tenant}`;
    });
  });

  it("enqueues one aggregation at cutoff exactly once", async () => {
    const before = await scheduleDueWeeklyReports(
      new Date("2026-08-07T05:59:00.000Z"),
      fixture.period,
    );
    expect(before).toEqual({
      closedPeriods: 0,
      aggregationJobs: 0,
      teamReportJobs: 0,
    });

    const first = await scheduleDueWeeklyReports(
      new Date("2026-08-07T06:00:00.000Z"),
      fixture.period,
    );
    expect(first).toEqual({
      closedPeriods: 1,
      aggregationJobs: 1,
      teamReportJobs: 0,
    });

    const repeated = await scheduleDueWeeklyReports(
      new Date("2026-08-07T06:01:00.000Z"),
      fixture.period,
    );
    expect(repeated).toEqual({
      closedPeriods: 0,
      aggregationJobs: 0,
      teamReportJobs: 0,
    });

    const [periods, reviews, jobs] = await Promise.all([
      sql<any[]>`
        select period_key, status from report_periods
        where team_id = ${fixture.team} order by starts_at
      `,
      sql<any[]>`select state from reviews where period_id = ${fixture.period}`,
      sql<any[]>`
        select type, status, idempotency_key, input_payload
        from agent_jobs where tenant_id = ${fixture.tenant}
      `,
    ]);
    expect(periods).toEqual([
      { period_key: "2026-W31", status: "facts_frozen" },
      { period_key: "2026-W32", status: "open" },
    ]);
    expect(reviews).toEqual([{ state: "PENDING" }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "AGGREGATE_WORK_ITEMS",
      status: "PENDING",
      idempotency_key: `weekly-aggregate:${fixture.partner}:${fixture.period}`,
      input_payload: {
        aggregationMode: "weekly_report",
        reviewId: expect.any(String),
        projectBuckets: [
          {
            projectKey: "unassigned",
            projectName: "未识别项目",
            factIds: [fixture.fact],
          },
        ],
      },
    });
  });

  it("repairs a missing current week after an upgrade", async () => {
    await sql`
      delete from report_periods
      where team_id = ${fixture.team} and period_key = '2026-W32'
    `;
    const created = await ensureCurrentWeeklyPeriods(
      new Date("2026-08-10T03:00:00.000Z"),
      fixture.team,
    );
    expect(created).toBe(1);

    const periods = await sql<any[]>`
      select period_key, status from report_periods
      where team_id = ${fixture.team} and status = 'open'
    `;
    expect(periods).toEqual([{ period_key: "2026-W32", status: "open" }]);
  });
});
