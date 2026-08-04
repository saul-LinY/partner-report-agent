import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, requireWebActor, stableJsonHash } from "../common.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function teamReportRoutes(app: FastifyInstance) {
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
