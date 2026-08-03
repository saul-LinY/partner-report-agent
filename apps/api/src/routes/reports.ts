import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, requireWebActor, stableJsonHash } from "../common.js";

const preferencesSchema = z.object({
  length: z.enum(["short", "standard", "detailed"]).default("standard"),
  language: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
  emphasis: z.string().max(500).optional(),
  technicalDetail: z.enum(["low", "medium", "high"]).default("medium"),
  sectionOrder: z.array(z.string()).optional()
});

async function loadReport(actor: { tenantId: string; partnerId: string | null }, reportId: string) {
  if (!actor.partnerId) throw new ApiError(403, "PARTNER_REQUIRED", "当前账号没有 Partner Profile。");
  const rows = await sql<any[]>`
    select * from individual_reports
    where id = ${reportId} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
    limit 1
  `;
  const report = rows[0];
  if (!report) throw new ApiError(404, "REPORT_NOT_FOUND", "Report 不存在。");
  return report;
}

export async function reportRoutes(app: FastifyInstance) {
  app.get("/v1/individual-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const report = await loadReport(actor, id);
    const versions = await sql<any[]>`
      select * from individual_report_versions
      where report_id = ${id} and tenant_id = ${actor.tenantId}
      order by version desc
    `;
    return { report, current: versions.find((version) => version.version === report.current_version) ?? null, versions };
  });

  app.post("/v1/individual-reports/:id/regenerate", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const preferences = preferencesSchema.parse(request.body);
    const report = await loadReport(actor, id);
    if (["SUBMITTED", "LOCKED"].includes(report.status)) throw new ApiError(409, "REPORT_LOCKED", "Report 已提交，不能重新生成。");
    const [snapshotRows, templateRows] = await Promise.all([
      sql<any[]>`select * from work_item_snapshots where id = ${report.snapshot_id} and tenant_id = ${actor.tenantId}`,
      sql<any[]>`
        select rt.* from report_periods rp
        join report_templates rt on rt.id = rp.template_id and rt.tenant_id = rp.tenant_id
        where rp.id = ${report.period_id} and rp.tenant_id = ${actor.tenantId} and rp.team_id = ${actor.teamId}
        union all
        select fallback.* from report_templates fallback
        where fallback.tenant_id = ${actor.tenantId} and fallback.team_id = ${actor.teamId}
          and fallback.is_default = true
          and not exists (
            select 1 from report_periods selected where selected.id = ${report.period_id} and selected.template_id is not null
          )
        order by version desc limit 1
      `
    ]);
    const snapshot = snapshotRows[0];
    if (!snapshot) throw new ApiError(409, "REPORT_DEPENDENCY_MISSING", "缺少 Work Item Snapshot。");
    const key = stableJsonHash({ snapshot: snapshot.checksum, preferences, next: report.current_version + 1 });
    const jobRows = await sql<any[]>`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, plugin_instance_id, type, idempotency_key, input_payload
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, null,
        'REGENERATE_INDIVIDUAL_REPORT', ${`report-regenerate:${id}:${key}`},
        ${JSON.stringify({
          schemaVersion: "1.0",
          reportId: id,
          snapshotId: snapshot.id,
          sourceChecksum: snapshot.checksum,
          generatorVersion: "partner-report-platform/0.2.0",
          workItems: snapshot.payload.workItems,
          coverage: snapshot.payload.coverage,
          template: templateRows[0] ?? null,
          preferences,
          constraints: { claimsRequireWorkItemIds: true, factsMustRemainUnchanged: true }
        })}::jsonb
      ) on conflict (tenant_id, idempotency_key) do update set updated_at = agent_jobs.updated_at
      returning *
    `;
    await sql`update individual_reports set status = 'REPORT_DRAFT', updated_at = now() where id = ${id}`;
    await audit(request, actor, "individual_report.regeneration_requested", "individual_report", id, { preferences });
    return jobRows[0];
  });

  app.post("/v1/individual-reports/:id/return-to-items", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const report = await loadReport(actor, id);
    if (["SUBMITTED", "LOCKED"].includes(report.status)) throw new ApiError(409, "REPORT_LOCKED", "Report 已提交，不能返回事项层。");
    const snapshots = await sql<any[]>`select review_id from work_item_snapshots where id = ${report.snapshot_id}`;
    const reviewId = snapshots[0]?.review_id;
    if (!reviewId) throw new ApiError(409, "SNAPSHOT_INVALID", "Snapshot 缺少 Review 引用。");
    await sql.begin(async (tx) => {
      await tx`update individual_reports set status = 'RETURNED_TO_ITEMS', updated_at = now() where id = ${id}`;
      await tx`update reviews set state = 'IN_PROGRESS', version = version + 1, updated_at = now() where id = ${reviewId}`;
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (
          ${randomUUID()}, ${actor.tenantId}, 'individual_report.returned_to_items', 'review', ${reviewId},
          ${JSON.stringify({ reportId: id })}::jsonb
        )
      `;
    });
    await audit(request, actor, "individual_report.returned_to_items", "individual_report", id, { reviewId });
    return { reviewId };
  });

  app.post("/v1/individual-reports/:id/submit", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { baseVersion } = z.object({ baseVersion: z.number().int().positive() }).parse(request.body);
    const report = await loadReport(actor, id);
    if (report.current_version !== baseVersion) throw new ApiError(409, "VERSION_CONFLICT", "Report 已更新，请刷新后提交。");
    if (report.status !== "REPORT_REVIEW") throw new ApiError(409, "REPORT_NOT_SUBMITTABLE", "Report 尚未进入可提交审核状态。");
    await sql.begin(async (tx) => {
      await tx`
        update individual_reports set status = 'LOCKED', submitted_at = now(), locked_at = now(), updated_at = now()
        where id = ${id} and tenant_id = ${actor.tenantId} and current_version = ${baseVersion}
      `;
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (
          ${randomUUID()}, ${actor.tenantId}, 'individual_report.submitted', 'individual_report', ${id},
          ${JSON.stringify({ version: baseVersion })}::jsonb
        )
      `;
    });
    await audit(request, actor, "individual_report.submitted", "individual_report", id, { version: baseVersion });
    return { id, status: "LOCKED", version: baseVersion };
  });

  app.get("/v1/individual-reports/:id/download.md", async (request, reply) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const report = await loadReport(actor, id);
    if (report.current_version < 1) throw new ApiError(404, "REPORT_VERSION_MISSING", "Report 尚未生成内容。");
    const versions = await sql<any[]>`
      select title, markdown, version from individual_report_versions
      where report_id = ${id} and tenant_id = ${actor.tenantId} and version = ${report.current_version}
    `;
    const version = versions[0];
    if (!version) throw new ApiError(404, "REPORT_VERSION_MISSING", "Report 版本不存在。");
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="partner-report-v${version.version}.md"`);
    return version.markdown;
  });
}
