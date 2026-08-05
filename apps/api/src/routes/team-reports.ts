import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, requireWebActor, stableJsonHash } from "../common.js";

const paramsSchema = z.object({ id: z.string().uuid() });

type IndividualReportSourceRow = {
  partner_id: string;
  partner_name: string;
  report_id: string | null;
  payload: unknown | null;
};

async function enqueueTeamReportForPeriod(
  tx: any,
  input: {
    tenantId: string;
    teamId: string;
    periodId: string;
    requireAllLocked?: boolean;
    lockedBehavior?: "error" | "ignore";
  },
) {
  const periodRows = await tx<any[]>`
    select * from report_periods
    where id = ${input.periodId} and tenant_id = ${input.tenantId}
      and team_id = ${input.teamId}
    limit 1
  `;
  const period = periodRows[0];
  if (!period) throw new ApiError(404, "PERIOD_NOT_FOUND", "所选周期不存在。");

  const reportRows = (await tx`
    select p.id as partner_id, p.display_name as partner_name,
      ir.id as report_id, ir.payload
    from partners p
    left join individual_reports ir on ir.tenant_id = p.tenant_id
      and ir.partner_id = p.id and ir.period_id = ${input.periodId}
      and ir.status = 'LOCKED'
    where p.tenant_id = ${input.tenantId} and p.team_id = ${input.teamId}
      and p.status = 'active'
    order by p.display_name
  `) as IndividualReportSourceRow[];
  const submitted = reportRows.filter((row) => row.report_id && row.payload);
  const missingPartnerIds = reportRows
    .filter((row) => !row.report_id || !row.payload)
    .map((row) => row.partner_id);
  if (submitted.length === 0)
    throw new ApiError(
      409,
      "NO_LOCKED_INDIVIDUAL_REPORTS",
      "该周期还没有最终确认的个人 Report。",
    );
  if (input.requireAllLocked && missingPartnerIds.length > 0) return null;

  const previousRows = await tx<any[]>`
    select trv.id as version_id, previous_period.period_key, trv.payload
    from report_periods previous_period
    join team_reports tr on tr.period_id = previous_period.id
      and tr.tenant_id = previous_period.tenant_id
      and tr.team_id = previous_period.team_id
    join team_report_versions trv on trv.report_id = tr.id and trv.version = tr.current_version
    where previous_period.id = (
      select prior.id from report_periods prior
      where prior.tenant_id = ${input.tenantId}
        and prior.team_id = ${input.teamId}
        and prior.starts_at < ${period.starts_at}
      order by prior.starts_at desc limit 1
    ) and tr.status = 'LOCKED'
    limit 1
  `;
  const source = {
    individualReports: submitted.map((row) => ({
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      reportId: row.report_id,
      payload: row.payload,
    })),
    missingPartnerIds,
    previousTeamReport: previousRows[0] ?? null,
  };
  const sourceChecksum = stableJsonHash(source);
  const teamReportRows = await tx<{ id: string; status: string }[]>`
    insert into team_reports (
      id, tenant_id, team_id, period_id, status, missing_partner_ids
    ) values (
      ${randomUUID()}, ${input.tenantId}, ${input.teamId}, ${input.periodId},
      'AGGREGATING', ${JSON.stringify(missingPartnerIds)}::jsonb
    ) on conflict (tenant_id, team_id, period_id) do update set
      status = team_reports.status,
      missing_partner_ids = team_reports.missing_partner_ids,
      updated_at = team_reports.updated_at
    returning id, status
  `;
  if (teamReportRows[0]?.status === "LOCKED") {
    if (input.lockedBehavior === "ignore") return null;
    throw new ApiError(
      409,
      "TEAM_REPORT_LOCKED",
      "该周期 Team Report 已最终确认，不能重新生成。",
    );
  }

  const inserted = await tx<{ id: string }[]>`
    insert into agent_jobs (
      id, tenant_id, team_id, partner_id, type, idempotency_key, input_payload
    ) values (
      ${randomUUID()}, ${input.tenantId}, ${input.teamId}, null,
      'GENERATE_TEAM_REPORT', ${`team-report:${input.periodId}:${sourceChecksum}`},
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
  return {
    reportId: teamReportRows[0]!.id,
    jobId: inserted[0]?.id ?? null,
    queued: Boolean(inserted[0]),
    individualReportCount: submitted.length,
    missingPartnerIds,
  };
}

export { enqueueTeamReportForPeriod };

export async function teamReportRoutes(app: FastifyInstance) {
  app.get("/v1/admin/report-archive", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const [individualReportRows, teamReportRows] = await Promise.all([
      sql<any[]>`
          select rp.id as period_id, rp.period_key, rp.starts_at, rp.ends_at,
            p.id as partner_id, p.display_name as partner_name,
            p.email as partner_email, ir.id as report_id, ir.locked_at,
            ir.title as report_title, ir.summary as report_summary,
            wis.payload as work_item_snapshot
          from individual_reports ir
          join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
          join report_periods rp on rp.id = ir.period_id
            and rp.tenant_id = ir.tenant_id
          join work_item_snapshots wis on wis.id = ir.snapshot_id
            and wis.tenant_id = ir.tenant_id
          where ir.tenant_id = ${actor.tenantId}
            and ir.team_id = ${actor.teamId} and ir.status = 'LOCKED'
            and ir.payload is not null
          order by rp.starts_at desc, p.display_name
        `,
      sql<any[]>`
          select rp.id as period_id, rp.period_key, rp.starts_at, rp.ends_at,
            tr.id as report_id, tr.current_version as report_version,
            tr.locked_at, current.title as report_title,
            current.summary as report_summary
          from team_reports tr
          join report_periods rp on rp.id = tr.period_id
            and rp.tenant_id = tr.tenant_id
          join team_report_versions current on current.report_id = tr.id
            and current.version = tr.current_version
          where tr.tenant_id = ${actor.tenantId}
            and tr.team_id = ${actor.teamId} and tr.status = 'LOCKED'
          order by rp.starts_at desc
        `,
    ]);

    const periods = new Map<string, any>();
    const ensurePeriod = (row: any) => {
      const existing = periods.get(row.period_id);
      if (existing) return existing;
      const period = {
        id: row.period_id,
        periodKey: row.period_key,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        people: [],
        teamReport: null,
      };
      periods.set(row.period_id, period);
      return period;
    };

    for (const row of individualReportRows) {
      const period = ensurePeriod(row);
      period.people.push({
        id: row.partner_id,
        name: row.partner_name,
        email: row.partner_email,
        individualReport: {
          id: row.report_id,
          title: row.report_title,
          summary: row.report_summary,
          lockedAt: row.locked_at,
        },
        workItems: Array.isArray(row.work_item_snapshot?.workItems)
          ? row.work_item_snapshot.workItems.map((item: any) => ({
              id: item.id,
              title: item.title,
              status: item.status,
              reviewStatus: item.review_status,
              overview: item.payload?.overview ?? item.payload?.summary ?? "",
              includedInReport: true,
              createdAt: item.updated_at ?? item.created_at ?? row.locked_at,
            }))
          : [],
      });
    }
    for (const row of teamReportRows) {
      ensurePeriod(row).teamReport = {
        id: row.report_id,
        version: row.report_version,
        title: row.report_title,
        summary: row.report_summary,
        lockedAt: row.locked_at,
      };
    }

    return {
      periods: [...periods.values()].sort(
        (left, right) =>
          new Date(right.startsAt).getTime() -
          new Date(left.startsAt).getTime(),
      ),
    };
  });

  app.get("/v1/admin/individual-reports", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return sql<any[]>`
      select ir.id, ir.status, ir.locked_at,
        p.id as partner_id, p.display_name as partner_name, p.email as partner_email,
        rp.id as period_id, rp.period_key, rp.starts_at, rp.ends_at,
        ir.title, ir.summary
      from individual_reports ir
      join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
      join report_periods rp on rp.id = ir.period_id and rp.tenant_id = ir.tenant_id
      where ir.tenant_id = ${actor.tenantId} and ir.team_id = ${actor.teamId}
        and ir.status = 'LOCKED' and ir.payload is not null
      order by rp.starts_at desc, p.display_name
    `;
  });

  app.get("/v1/admin/work-item-archives", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return sql<any[]>`
      select ir.id, ir.id as report_id, ir.locked_at,
        p.id as partner_id, p.display_name as partner_name,
        p.email as partner_email, rp.id as period_id, rp.period_key,
        rp.starts_at, rp.ends_at,
        jsonb_array_length(coalesce(wis.payload->'workItems', '[]'::jsonb))::int as work_item_count,
        jsonb_array_length(coalesce(wis.payload->'workItems', '[]'::jsonb))::int as included_work_item_count
      from individual_reports ir
      join work_item_snapshots wis on wis.id = ir.snapshot_id
        and wis.tenant_id = ir.tenant_id
      join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
      join report_periods rp on rp.id = ir.period_id and rp.tenant_id = ir.tenant_id
      where ir.tenant_id = ${actor.tenantId} and ir.team_id = ${actor.teamId}
        and ir.status = 'LOCKED'
      order by rp.starts_at desc, p.display_name
    `;
  });

  app.get("/v1/admin/individual-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const reports = await sql<any[]>`
      select ir.id, ir.status, ir.locked_at, ir.snapshot_id,
        ir.title, ir.summary, ir.markdown, ir.payload, ir.source_checksum,
        ir.generator_version, ir.updated_at,
        p.display_name as partner_name, p.email as partner_email,
        rp.period_key, rp.starts_at, rp.ends_at
      from individual_reports ir
      join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
      join report_periods rp on rp.id = ir.period_id and rp.tenant_id = ir.tenant_id
      where ir.id = ${id} and ir.tenant_id = ${actor.tenantId}
        and ir.team_id = ${actor.teamId} and ir.status = 'LOCKED'
      limit 1
    `;
    if (!reports[0])
      throw new ApiError(404, "NOT_FOUND", "个人 Report 归档不存在。");
    const snapshotRows = await sql<any[]>`
      select id, review_id, review_version, checksum, payload, approved_at
      from work_item_snapshots
      where tenant_id = ${actor.tenantId} and id = ${reports[0].snapshot_id}
      limit 1
    `;
    const workItems = Array.isArray(snapshotRows[0]?.payload?.workItems)
      ? snapshotRows[0].payload.workItems.map((item: any) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          reviewStatus: item.review_status,
          factIds: item.fact_ids,
          payload: item.payload,
          includedInReport: true,
          createdAt:
            item.updated_at ?? item.created_at ?? snapshotRows[0].approved_at,
        }))
      : [];
    return {
      report: reports[0],
      current: {
        id: reports[0].id,
        title: reports[0].title,
        summary: reports[0].summary,
        markdown: reports[0].markdown,
        payload: reports[0].payload,
        source_checksum: reports[0].source_checksum,
        generator_version: reports[0].generator_version,
        created_at: reports[0].updated_at,
      },
      workItemSnapshot: snapshotRows[0] ?? null,
      workItems,
    };
  });

  app.get("/v1/admin/team-reports", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return sql<any[]>`
      select tr.*, rp.period_key, rp.starts_at, rp.ends_at,
        current.title, current.summary
      from team_reports tr
      join report_periods rp on rp.id = tr.period_id and rp.tenant_id = tr.tenant_id
      left join team_report_versions current on current.report_id = tr.id
        and current.version = tr.current_version
      where tr.tenant_id = ${actor.tenantId} and tr.team_id = ${actor.teamId}
      order by rp.starts_at desc
    `;
  });

  app.post("/v1/admin/team-reports/generate", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = z
      .object({ periodId: z.string().uuid() })
      .strict()
      .parse(request.body);
    const existing = await sql<
      { id: string; status: string; current_version: number }[]
    >`
      select id, status, current_version from team_reports
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and period_id = ${input.periodId}
      limit 1
    `;
    if (existing[0])
      throw new ApiError(
        409,
        "TEAM_REPORT_EXISTS",
        "该周期已经有 Team Report。",
        {
          reportId: existing[0].id,
          status: existing[0].status,
          currentVersion: existing[0].current_version,
        },
      );
    const result = await sql.begin((tx) =>
      enqueueTeamReportForPeriod(tx, {
        tenantId: actor.tenantId,
        teamId: actor.teamId,
        periodId: input.periodId,
        requireAllLocked: true,
      }),
    );
    if (!result)
      throw new ApiError(
        409,
        "TEAM_REPORT_WAITING_FOR_REVIEWS",
        "仍有人员尚未完成个人 Report 审核，暂不能生成 Team Report。",
      );
    await audit(
      request,
      actor,
      "team_report.generation_requested",
      "team_report",
      result.reportId,
      {
        periodId: input.periodId,
        jobId: result.jobId,
        individualReportCount: result.individualReportCount,
        missingPartnerIds: result.missingPartnerIds,
      },
    );
    return result;
  });

  app.get("/v1/admin/team-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const reports = await sql<any[]>`
      select tr.*, rp.period_key, rp.starts_at, rp.ends_at
      from team_reports tr
      join report_periods rp on rp.id = tr.period_id and rp.tenant_id = tr.tenant_id
      where tr.id = ${id} and tr.tenant_id = ${actor.tenantId}
        and tr.team_id = ${actor.teamId} limit 1
    `;
    if (!reports[0])
      throw new ApiError(404, "NOT_FOUND", "Team Report 不存在。");
    const versions = await sql<any[]>`
      select id, version, title, summary, markdown, payload, source_checksum,
        generator_version, created_by, created_at
      from team_report_versions
      where tenant_id = ${actor.tenantId} and report_id = ${id}
      order by version desc
    `;
    return {
      report: reports[0],
      current:
        versions.find(
          (version) => version.version === reports[0].current_version,
        ) ?? null,
      versions,
    };
  });

  app.post("/v1/admin/team-reports/:id/regenerate", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const input = z
      .object({ instructions: z.string().max(1000).optional() })
      .parse(request.body ?? {});
    const reports = await sql<any[]>`
      select * from team_reports where id = ${id} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId} limit 1
    `;
    const report = reports[0];
    if (!report || report.status === "LOCKED")
      throw new ApiError(
        409,
        "TEAM_REPORT_NOT_EDITABLE",
        "Team Report 已锁定或不存在。",
      );
    const sourceRows = await sql<any[]>`
      select input_payload from agent_jobs
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and type in ('GENERATE_TEAM_REPORT', 'REGENERATE_TEAM_REPORT')
        and input_payload->>'reportId' = ${id}
      order by created_at desc limit 1
    `;
    if (!sourceRows[0])
      throw new ApiError(
        409,
        "TEAM_REPORT_SOURCE_MISSING",
        "Team Report 生成快照不存在。",
      );
    const payload = {
      ...sourceRows[0].input_payload,
      regenerationInstructions: input.instructions ?? "",
    };
    const jobId = randomUUID();
    await sql`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, type, idempotency_key, input_payload
      ) values (
        ${jobId}, ${actor.tenantId}, ${actor.teamId}, null,
        'REGENERATE_TEAM_REPORT', ${`team-report-regenerate:${id}:${randomUUID()}`},
        ${JSON.stringify(payload)}::jsonb
      )
    `;
    await sql`
      update team_reports set status = 'AGGREGATING', updated_at = now()
      where id = ${id}
    `;
    await audit(
      request,
      actor,
      "team_report.regeneration_requested",
      "team_report",
      id,
      { jobId },
    );
    return { jobId };
  });

  app.patch("/v1/admin/team-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const input = z
      .object({
        baseVersion: z.number().int().positive(),
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(1600),
        markdown: z.string().min(1).max(80000),
      })
      .parse(request.body);
    const edited = await sql.begin(async (tx) => {
      const reports = await tx<any[]>`
        select tr.*, current.payload, current.source_checksum
        from team_reports tr
        join team_report_versions current on current.report_id = tr.id
          and current.version = tr.current_version
        where tr.id = ${id} and tr.tenant_id = ${actor.tenantId}
          and tr.team_id = ${actor.teamId} for update
      `;
      const report = reports[0];
      if (!report || report.status === "LOCKED")
        throw new ApiError(
          409,
          "TEAM_REPORT_NOT_EDITABLE",
          "Team Report 已锁定或不存在。",
        );
      if (report.current_version !== input.baseVersion)
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Team Report 已产生新版本，请刷新后重试。",
        );
      const version = report.current_version + 1;
      const payload = {
        ...report.payload,
        title: input.title,
        summary: input.summary,
        markdown: input.markdown,
      };
      await tx`
        insert into team_report_versions (
          id, tenant_id, report_id, version, title, summary, markdown, payload,
          source_checksum, generator_version, created_by
        ) values (
          ${randomUUID()}, ${actor.tenantId}, ${id}, ${version}, ${input.title},
          ${input.summary}, ${input.markdown}, ${JSON.stringify(payload)}::jsonb,
          ${report.source_checksum}, 'admin-edit/1.0', ${actor.userId}
        )
      `;
      await tx`
        update team_reports set status = 'TEAM_DRAFT', current_version = ${version}, updated_at = now()
        where id = ${id}
      `;
      return { version, payload };
    });
    await audit(request, actor, "team_report.edited", "team_report", id, {
      version: edited.version,
      checksum: stableJsonHash(edited.payload),
    });
    return { version: edited.version };
  });

  app.post("/v1/admin/team-reports/:id/submit", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const input = z
      .object({ baseVersion: z.number().int().positive() })
      .parse(request.body);
    const locked = await sql.begin(async (tx) => {
      const rows = await tx<any[]>`
        update team_reports set status = 'LOCKED', locked_at = now(),
          locked_by = ${actor.userId}, updated_at = now()
        where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and status = 'TEAM_DRAFT' and current_version = ${input.baseVersion}
        returning period_id, current_version
      `;
      if (!rows[0])
        throw new ApiError(
          409,
          "TEAM_REPORT_SUBMIT_CONFLICT",
          "Team Report 状态或版本已变化。",
        );
      await tx`
        update report_periods set status = 'completed', updated_at = now()
        where id = ${rows[0].period_id} and tenant_id = ${actor.tenantId}
      `;
      return rows[0];
    });
    await audit(request, actor, "team_report.locked", "team_report", id, {
      version: locked.current_version,
    });
    return { ok: true, version: locked.current_version };
  });
}
