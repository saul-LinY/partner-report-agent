import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, requireWebActor, stableJsonHash } from "../common.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function teamReportRoutes(app: FastifyInstance) {
  app.get("/v1/admin/report-archive", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const [individualReportRows, workItemRows, teamReportRows] =
      await Promise.all([
        sql<any[]>`
          select rp.id as period_id, rp.period_key, rp.starts_at, rp.ends_at,
            p.id as partner_id, p.display_name as partner_name,
            p.email as partner_email, ir.id as report_id,
            ir.current_version as report_version, ir.locked_at,
            current.title as report_title, current.summary as report_summary
          from individual_reports ir
          join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
          join report_periods rp on rp.id = ir.period_id
            and rp.tenant_id = ir.tenant_id
          join individual_report_versions current on current.report_id = ir.id
            and current.version = ir.current_version
          where ir.tenant_id = ${actor.tenantId}
            and ir.team_id = ${actor.teamId} and ir.status = 'LOCKED'
          order by rp.starts_at desc, p.display_name
        `,
        sql<any[]>`
          select ir.id as report_id, final.id as version_id,
            final.work_item_id, final.version, final.title, final.status,
            final.review_status, final.payload, final.created_at,
            (current_link.work_item_version_id is not null) as included_in_report
          from individual_reports ir
          join work_item_snapshots wis on wis.id = ir.snapshot_id
            and wis.tenant_id = ir.tenant_id
          join individual_report_versions current_report
            on current_report.report_id = ir.id
            and current_report.version = ir.current_version
          join lateral (
            select distinct on (history.work_item_id) history.*
            from work_item_versions history
            where history.tenant_id = ir.tenant_id
              and history.review_id = wis.review_id
            order by history.work_item_id, history.version desc
          ) final on true
          left join individual_report_version_work_items current_link
            on current_link.report_version_id = current_report.id
            and current_link.work_item_version_id = final.id
          where ir.tenant_id = ${actor.tenantId}
            and ir.team_id = ${actor.teamId} and ir.status = 'LOCKED'
          order by lower(final.title)
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
          version: row.report_version,
          title: row.report_title,
          summary: row.report_summary,
          lockedAt: row.locked_at,
        },
        workItems: [],
      });
    }

    const peopleByReportId = new Map<string, any>();
    for (const period of periods.values()) {
      for (const person of period.people) {
        peopleByReportId.set(person.individualReport.id, person);
      }
    }
    for (const row of workItemRows) {
      peopleByReportId.get(row.report_id)?.workItems.push({
        id: row.work_item_id,
        versionId: row.version_id,
        version: row.version,
        title: row.title,
        status: row.status,
        reviewStatus: row.review_status,
        overview: row.payload?.overview ?? row.payload?.summary ?? "",
        includedInReport: row.included_in_report,
        createdAt: row.created_at,
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
      select ir.id, ir.status, ir.current_version, ir.locked_at,
        p.id as partner_id, p.display_name as partner_name, p.email as partner_email,
        rp.id as period_id, rp.period_key, rp.starts_at, rp.ends_at,
        current.title, current.summary
      from individual_reports ir
      join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
      join report_periods rp on rp.id = ir.period_id and rp.tenant_id = ir.tenant_id
      join individual_report_versions current on current.report_id = ir.id
        and current.version = ir.current_version
      where ir.tenant_id = ${actor.tenantId} and ir.team_id = ${actor.teamId}
        and ir.status = 'LOCKED'
      order by rp.starts_at desc, p.display_name
    `;
  });

  app.get("/v1/admin/work-item-archives", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return sql<any[]>`
      select ir.id, ir.id as report_id, ir.current_version as report_version,
        ir.locked_at, p.id as partner_id, p.display_name as partner_name,
        p.email as partner_email, rp.id as period_id, rp.period_key,
        rp.starts_at, rp.ends_at, card_stats.work_item_count,
        card_stats.work_item_version_count,
        card_stats.included_work_item_count
      from individual_reports ir
      join work_item_snapshots wis on wis.id = ir.snapshot_id
        and wis.tenant_id = ir.tenant_id
      join partners p on p.id = ir.partner_id and p.tenant_id = ir.tenant_id
      join report_periods rp on rp.id = ir.period_id and rp.tenant_id = ir.tenant_id
      join lateral (
        select count(distinct history.work_item_id)::int as work_item_count,
          count(history.id)::int as work_item_version_count,
          count(distinct history.work_item_id) filter (
            where current_link.work_item_version_id is not null
          )::int as included_work_item_count
        from work_item_versions history
        left join (
          select link.work_item_version_id
          from individual_report_version_work_items link
          join individual_report_versions irv
            on irv.id = link.report_version_id
          where irv.report_id = ir.id and irv.version = ir.current_version
        ) current_link on current_link.work_item_version_id = history.id
        where history.tenant_id = ir.tenant_id
          and history.review_id = wis.review_id
      ) card_stats on true
      where ir.tenant_id = ${actor.tenantId} and ir.team_id = ${actor.teamId}
        and ir.status = 'LOCKED'
      order by rp.starts_at desc, p.display_name
    `;
  });

  app.get("/v1/admin/individual-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const reports = await sql<any[]>`
      select ir.id, ir.status, ir.current_version, ir.locked_at, ir.snapshot_id,
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
    const versions = await sql<any[]>`
      select id, version, title, summary, markdown, payload, source_checksum,
        generator_version, created_at
      from individual_report_versions
      where tenant_id = ${actor.tenantId} and report_id = ${id}
      order by version desc
    `;
    const snapshotRows = await sql<any[]>`
      select id, review_id, review_version, checksum, payload, approved_at
      from work_item_snapshots
      where tenant_id = ${actor.tenantId} and id = ${reports[0].snapshot_id}
      limit 1
    `;
    const workItemVersionRows = snapshotRows[0]
      ? await sql<any[]>`
          select wiv.*,
            coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'reportVersionId', irv.id,
                  'reportVersion', irv.version
                ) order by irv.version
              ) filter (where irv.id is not null),
              '[]'::jsonb
            ) as report_versions
          from work_item_versions wiv
          left join individual_report_version_work_items link
            on link.work_item_version_id = wiv.id
          left join individual_report_versions irv
            on irv.id = link.report_version_id and irv.report_id = ${id}
          where wiv.tenant_id = ${actor.tenantId}
            and wiv.review_id = ${snapshotRows[0].review_id}
          group by wiv.id
          order by lower(wiv.title), wiv.version desc
        `
      : [];
    const workItems = [
      ...workItemVersionRows
        .reduce((groups, version) => {
          const existing = groups.get(version.work_item_id) ?? {
            id: version.work_item_id,
            title: version.title,
            currentVersion: version.version,
            reviewStatus: version.review_status,
            includedInReport: false,
            versions: [],
          };
          existing.includedInReport ||= version.report_versions.length > 0;
          existing.versions.push(version);
          groups.set(version.work_item_id, existing);
          return groups;
        }, new Map<string, any>())
        .values(),
    ];
    return {
      report: reports[0],
      current:
        versions.find(
          (version) => version.version === reports[0].current_version,
        ) ?? null,
      versions,
      workItemSnapshot: snapshotRows[0] ?? null,
      workItems,
    };
  });

  app.get("/v1/admin/team-reports", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return sql<any[]>`
      select tr.*, rp.period_key, rp.starts_at, rp.ends_at,
        rp.submission_deadline_at, current.title, current.summary
      from team_reports tr
      join report_periods rp on rp.id = tr.period_id and rp.tenant_id = tr.tenant_id
      left join team_report_versions current on current.report_id = tr.id
        and current.version = tr.current_version
      where tr.tenant_id = ${actor.tenantId} and tr.team_id = ${actor.teamId}
      order by rp.starts_at desc
    `;
  });

  app.get("/v1/admin/team-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = paramsSchema.parse(request.params);
    const reports = await sql<any[]>`
      select tr.*, rp.period_key, rp.starts_at, rp.ends_at,
        rp.submission_deadline_at
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
