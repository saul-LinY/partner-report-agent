import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  ensureCurrentWeeklyPeriods,
  scheduleDueWeeklyReports,
} from "./weekly.js";
import { processNextGenerationJob } from "./generation.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("weekly report scheduling", () => {
  const fixture = {
    tenant: randomUUID(),
    team: randomUUID(),
    partner: randomUUID(),
    emptyPartner: randomUUID(),
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
        values
          (${fixture.partner}, ${fixture.tenant}, ${fixture.team}, 'weekly@example.com', 'Weekly Partner'),
          (${fixture.emptyPartner}, ${fixture.tenant}, ${fixture.team}, 'empty@example.com', 'Empty Weekly Partner')
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
      await tx`delete from feishu_deliveries where tenant_id = ${fixture.tenant}`;
      await tx`delete from team_report_versions where tenant_id = ${fixture.tenant}`;
      await tx`delete from team_reports where tenant_id = ${fixture.tenant}`;
      await tx`delete from agent_jobs where tenant_id = ${fixture.tenant}`;
      await tx`delete from individual_reports where tenant_id = ${fixture.tenant}`;
      await tx`delete from work_item_snapshots where tenant_id = ${fixture.tenant}`;
      await tx`
        delete from work_item_facts
        where work_item_id in (
          select id from work_items where tenant_id = ${fixture.tenant}
        )
      `;
      await tx`delete from work_items where tenant_id = ${fixture.tenant}`;
      await tx`delete from reviews where tenant_id = ${fixture.tenant}`;
      await tx`delete from fact_snapshots where tenant_id = ${fixture.tenant}`;
      await tx`delete from session_facts where id = ${fixture.fact}`;
      await tx`delete from report_periods where team_id = ${fixture.team}`;
      await tx`delete from partners where id = ${fixture.partner}`;
      await tx`delete from partners where id = ${fixture.emptyPartner}`;
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

    const [periods, reviews, jobs, emptyReports, emptySnapshots] =
      await Promise.all([
        sql<any[]>`
        select period_key, status from report_periods
        where team_id = ${fixture.team} order by starts_at
      `,
        sql<any[]>`
        select partner_id, state from reviews
        where period_id = ${fixture.period} order by partner_id
      `,
        sql<any[]>`
        select type, status, idempotency_key, input_payload
        from agent_jobs where tenant_id = ${fixture.tenant}
      `,
        sql<any[]>`
        select status, title, summary, payload, generator_version
        from individual_reports
        where tenant_id = ${fixture.tenant}
          and partner_id = ${fixture.emptyPartner}
          and period_id = ${fixture.period}
      `,
        sql<any[]>`
        select payload, approved_by_actor_type, approved_by_actor_id
        from work_item_snapshots
        where tenant_id = ${fixture.tenant}
          and partner_id = ${fixture.emptyPartner}
          and period_id = ${fixture.period}
      `,
      ]);
    expect(periods).toEqual([
      { period_key: "2026-W31", status: "facts_frozen" },
      { period_key: "2026-W32", status: "open" },
    ]);
    expect(reviews).toEqual(
      [
        { partner_id: fixture.partner, state: "PENDING" },
        { partner_id: fixture.emptyPartner, state: "ITEMS_APPROVED" },
      ].sort((left, right) => left.partner_id.localeCompare(right.partner_id)),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "AGGREGATE_WORK_ITEMS",
      status: "PENDING",
      idempotency_key: `weekly-aggregate:${fixture.partner}:${fixture.period}`,
      input_payload: {
        aggregationMode: "weekly_report",
        autoAdvanceAtCutoff: true,
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
    expect(emptyReports).toHaveLength(1);
    expect(emptyReports[0]).toMatchObject({
      status: "LOCKED",
      title: "本周期个人周报：无可汇报记录",
      summary: expect.stringContaining("不代表本周期没有开展工作"),
      generator_version: "partner-report-platform/0.3.0 (no-activity)",
      payload: {
        qualityWarnings: ["NO_REPORTABLE_ACTIVITY_COLLECTED"],
      },
    });
    expect(emptySnapshots).toEqual([
      expect.objectContaining({
        approved_by_actor_type: "system",
        approved_by_actor_id: "weekly-cutoff",
        payload: expect.objectContaining({
          workItems: [],
          noReportableActivity: true,
        }),
      }),
    ]);
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

  it("creates the next period when a schedule change reuses the same week key", async () => {
    const rows = await sql<Array<{ id: string }>>`
      update report_periods set
        ends_at = '2026-08-09T10:35:00.000Z',
        cutoff_at = '2026-08-09T10:35:00.000Z',
        submission_deadline_at = '2026-08-09T10:35:00.000Z'
      where team_id = ${fixture.team} and period_key = '2026-W32'
      returning id
    `;
    await sql`
      update teams set period_rule = ${JSON.stringify({
        frequency: "weekly",
        weekStartsOn: 1,
        factCutoffWeekday: 7,
        factCutoffTime: "18:35",
      })}::jsonb
      where id = ${fixture.team}
    `;

    const result = await scheduleDueWeeklyReports(
      new Date("2026-08-09T10:35:00.000Z"),
      rows[0]!.id,
    );
    expect(result.closedPeriods).toBe(1);

    const periods = await sql<any[]>`
      select period_key, starts_at, cutoff_at, status
      from report_periods
      where team_id = ${fixture.team} and status = 'open'
      order by starts_at desc
    `;
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      period_key: "2026-W32-20260809T103500Z",
      status: "open",
    });
    expect(new Date(periods[0].starts_at).toISOString()).toBe(
      "2026-08-09T10:35:00.000Z",
    );
    expect(new Date(periods[0].cutoff_at).toISOString()).toBe(
      "2026-08-16T10:35:00.000Z",
    );
  });
});

suite("weekly reporting with no collected activity", () => {
  const fixture = {
    tenant: randomUUID(),
    team: randomUUID(),
    partner: randomUUID(),
    period: randomUUID(),
  };

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenant}, 'Empty Weekly Fixture')`;
      await tx`
        insert into teams (id, tenant_id, name, timezone, report_type)
        values (${fixture.team}, ${fixture.tenant}, 'Empty Weekly Team', 'Asia/Shanghai', 'weekly')
      `;
      await tx`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${fixture.partner}, ${fixture.tenant}, ${fixture.team}, 'empty-only@example.com', 'No Activity Partner')
      `;
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone
        ) values (
          ${fixture.period}, ${fixture.tenant}, ${fixture.team}, 'empty-W31',
          '2026-07-31T06:00:00.000Z', '2026-08-07T06:00:00.000Z',
          '2026-08-07T06:00:00.000Z', '2026-08-10T02:00:00.000Z',
          'Asia/Shanghai'
        )
      `;
    });
  });

  afterAll(async () => {
    await sql.begin(async (tx) => {
      await tx`delete from feishu_deliveries where tenant_id = ${fixture.tenant}`;
      await tx`delete from team_report_versions where tenant_id = ${fixture.tenant}`;
      await tx`delete from team_reports where tenant_id = ${fixture.tenant}`;
      await tx`delete from agent_jobs where tenant_id = ${fixture.tenant}`;
      await tx`delete from individual_reports where tenant_id = ${fixture.tenant}`;
      await tx`delete from work_item_snapshots where tenant_id = ${fixture.tenant}`;
      await tx`
        delete from work_item_facts
        where work_item_id in (
          select id from work_items where tenant_id = ${fixture.tenant}
        )
      `;
      await tx`delete from work_items where tenant_id = ${fixture.tenant}`;
      await tx`delete from reviews where tenant_id = ${fixture.tenant}`;
      await tx`delete from fact_snapshots where tenant_id = ${fixture.tenant}`;
      await tx`delete from report_periods where team_id = ${fixture.team}`;
      await tx`delete from partners where id = ${fixture.partner}`;
      await tx`delete from teams where id = ${fixture.team}`;
      await tx`delete from tenants where id = ${fixture.tenant}`;
    });
  });

  it("locks an honest empty report and completes the Team Report without Feishu", async () => {
    expect(
      await scheduleDueWeeklyReports(
        new Date("2026-08-07T06:00:00.000Z"),
        fixture.period,
      ),
    ).toEqual({
      closedPeriods: 1,
      aggregationJobs: 0,
      teamReportJobs: 1,
    });

    const jobs = await sql<any[]>`
      select type, input_payload from agent_jobs
      where tenant_id = ${fixture.tenant}
    `;
    expect(jobs).toMatchObject([
      {
        type: "GENERATE_TEAM_REPORT",
        input_payload: {
          individualReports: [
            {
              partnerId: fixture.partner,
              noReportableActivity: true,
              projectNames: [],
            },
          ],
          missingPartnerIds: [],
        },
      },
    ]);
    expect(await processNextGenerationJob(fixture.tenant)).toMatchObject({
      processed: true,
      type: "GENERATE_TEAM_REPORT",
    });

    const [reports, periods, outbox] = await Promise.all([
      sql<any[]>`
        select tr.status, tr.missing_partner_ids, trv.payload
        from team_reports tr
        join team_report_versions trv on trv.report_id = tr.id
        where tr.tenant_id = ${fixture.tenant}
      `,
      sql<any[]>`
        select status from report_periods where id = ${fixture.period}
      `,
      sql<any[]>`
        select id from outbox_events where tenant_id = ${fixture.tenant}
      `,
    ]);
    expect(reports).toMatchObject([
      {
        status: "LOCKED",
        missing_partner_ids: [],
        payload: {
          summary:
            expect.stringContaining("不代表团队成员在本周期没有开展工作"),
          qualityWarnings: ["NO_REPORTABLE_ACTIVITY_COLLECTED"],
        },
      },
    ]);
    expect(periods).toEqual([{ status: "completed" }]);
    expect(outbox).toEqual([]);
  });
});
