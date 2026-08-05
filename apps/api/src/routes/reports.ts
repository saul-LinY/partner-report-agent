import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  type DomainActor,
  requireWebActor,
  stableJsonHash,
} from "../common.js";
import { enqueueTeamReportForPeriod } from "./team-reports.js";

const regenerationSchema = z
  .object({
    instruction: z.string().trim().min(2).max(1200),
    contentRevision: z.number().int().positive(),
  })
  .strict();

async function loadReport(
  actor: Pick<DomainActor, "tenantId" | "partnerId">,
  reportId: string,
) {
  if (!actor.partnerId)
    throw new ApiError(
      403,
      "PARTNER_REQUIRED",
      "当前账号没有 Partner Profile。",
    );
  const rows = await sql<any[]>`
    select * from individual_reports
    where id = ${reportId} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
    limit 1
  `;
  const report = rows[0];
  if (!report) throw new ApiError(404, "REPORT_NOT_FOUND", "Report 不存在。");
  return report;
}

async function loadReportForUpdate(
  tx: any,
  actor: Pick<DomainActor, "tenantId" | "partnerId">,
  reportId: string,
) {
  if (!actor.partnerId)
    throw new ApiError(
      403,
      "PARTNER_REQUIRED",
      "当前账号没有 Partner Profile。",
    );
  const rows = await tx<any[]>`
    select * from individual_reports
    where id = ${reportId} and tenant_id = ${actor.tenantId}
      and partner_id = ${actor.partnerId}
    for update
  `;
  const report = rows[0];
  if (!report) throw new ApiError(404, "REPORT_NOT_FOUND", "Report 不存在。");
  return report;
}

export type RegenerateIndividualReportCommand = {
  reportId: string;
  instruction: string;
  contentRevision: number;
};

const regenerateIndividualReportCommandSchema = z
  .object({
    reportId: z.string().uuid(),
    instruction: z.string().trim().min(2).max(1200),
    contentRevision: z.number().int().positive(),
  })
  .strict();

export async function regenerateIndividualReport(
  actor: DomainActor,
  command: RegenerateIndividualReportCommand,
) {
  const { reportId, instruction, contentRevision } =
    regenerateIndividualReportCommandSchema.parse(command);
  return sql.begin(async (tx) => {
    const report = await loadReportForUpdate(tx, actor, reportId);
    if (report.content_revision !== contentRevision)
      throw new ApiError(
        409,
        "REPORT_CONTENT_CHANGED",
        "Report 内容已更新，请刷新后重新操作。",
      );
    if (["SUBMITTED", "LOCKED"].includes(report.status))
      throw new ApiError(409, "REPORT_LOCKED", "Report 已提交，不能重新生成。");
    const snapshotRows = await tx<any[]>`
      select * from work_item_snapshots
      where id = ${report.snapshot_id} and tenant_id = ${actor.tenantId}
    `;
    const templateRows = await tx<any[]>`
      select rt.* from report_periods rp
      join report_templates rt on rt.id = rp.template_id and rt.tenant_id = rp.tenant_id
      where rp.id = ${report.period_id} and rp.tenant_id = ${actor.tenantId}
        and rp.team_id = ${actor.teamId}
      union all
      select fallback.* from report_templates fallback
      where fallback.tenant_id = ${actor.tenantId} and fallback.team_id = ${actor.teamId}
        and fallback.is_default = true
        and not exists (
          select 1 from report_periods selected
          where selected.id = ${report.period_id} and selected.template_id is not null
        )
      order by version desc limit 1
    `;
    const snapshot = snapshotRows[0];
    if (!snapshot)
      throw new ApiError(
        409,
        "REPORT_DEPENDENCY_MISSING",
        "缺少 Work Item Snapshot。",
      );
    if (!report.payload || !report.markdown)
      throw new ApiError(
        409,
        "REPORT_CONTENT_MISSING",
        "当前 Report 尚未生成内容。",
      );
    const currentReport = {
      id: report.id,
      title: report.title,
      summary: report.summary,
      markdown: report.markdown,
      payload: report.payload,
    };
    const key = stableJsonHash({
      snapshot: snapshot.checksum,
      instruction,
      current: contentRevision,
    });
    const pendingJobs = await tx<any[]>`
      select id from agent_jobs
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and type = 'REGENERATE_INDIVIDUAL_REPORT'
        and input_payload->>'reportId' = ${reportId}
        and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
      limit 1
    `;
    if (pendingJobs[0])
      throw new ApiError(
        409,
        "REPORT_REGENERATION_PENDING",
        "这个 Report 正在重新生成。",
      );
    const jobId = randomUUID();
    const jobRows = await tx<any[]>`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, plugin_instance_id, type,
        idempotency_key, input_payload
      ) values (
        ${jobId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, null,
        'REGENERATE_INDIVIDUAL_REPORT',
        ${`report-regenerate:${reportId}:${key}:${jobId}`},
        ${JSON.stringify({
          schemaVersion: "1.0",
          reportId,
          snapshotId: snapshot.id,
          sourceChecksum: snapshot.checksum,
          generatorVersion: "partner-report-platform/0.2.0",
          workItems: snapshot.payload.workItems,
          coverage: snapshot.payload.coverage,
          template: templateRows[0] ?? null,
          currentReport,
          reviewInstruction: instruction,
          preferences: { reviewInstruction: instruction },
          constraints: {
            claimsRequireWorkItemIds: true,
            factsMustRemainUnchanged: true,
          },
        })}::jsonb
      )
      returning *
    `;
    await tx`
      update individual_reports set status = 'REPORT_DRAFT', updated_at = now()
      where id = ${reportId} and tenant_id = ${actor.tenantId}
        and partner_id = ${actor.partnerId}
    `;
    await tx`
      insert into outbox_events (
        id, tenant_id, event_type, aggregate_type, aggregate_id, payload
      ) values (
        ${randomUUID()}, ${actor.tenantId},
        'individual_report.regeneration.requested', 'individual_report',
        ${reportId},
        ${JSON.stringify({
          jobId,
          contentRevision,
        })}::jsonb
      )
    `;
    return jobRows[0];
  });
}

export type SubmitIndividualReportCommand = {
  reportId: string;
  contentRevision: number;
};

const submitIndividualReportCommandSchema = z
  .object({
    reportId: z.string().uuid(),
    contentRevision: z.number().int().positive(),
  })
  .strict();

export async function submitIndividualReport(
  actor: DomainActor,
  command: SubmitIndividualReportCommand,
) {
  const { reportId, contentRevision } =
    submitIndividualReportCommandSchema.parse(command);
  return sql.begin(async (tx) => {
    const locked = await tx<
      { id: string; status: string; content_revision: number }[]
    >`
      update individual_reports set
        status = 'LOCKED', submitted_at = now(), locked_at = now(),
        updated_at = now()
      where id = ${reportId} and tenant_id = ${actor.tenantId}
        and partner_id = ${actor.partnerId}
        and status = 'REPORT_REVIEW' and content_revision = ${contentRevision}
      returning id, status, content_revision
    `;
    if (locked[0]) {
      await tx`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${randomUUID()}, ${actor.tenantId}, 'individual_report.submitted',
          'individual_report', ${reportId},
          ${JSON.stringify({ contentRevision })}::jsonb
        )
      `;
      await enqueueTeamReportForPeriod(tx, {
        tenantId: actor.tenantId,
        teamId: actor.teamId,
        periodId: (
          await tx<{ period_id: string }[]>`
          select period_id from individual_reports
          where id = ${reportId} and tenant_id = ${actor.tenantId}
        `
        )[0]!.period_id,
        requireAllLocked: true,
        lockedBehavior: "ignore",
      });
      return {
        id: reportId,
        status: "LOCKED" as const,
        contentRevision,
        idempotent: false,
      };
    }

    const report = await loadReportForUpdate(tx, actor, reportId);
    if (report.content_revision !== contentRevision)
      throw new ApiError(
        409,
        "REPORT_CONTENT_CHANGED",
        "Report 内容已更新，请刷新后提交。",
      );
    if (report.status === "LOCKED")
      return {
        id: reportId,
        status: "LOCKED" as const,
        contentRevision,
        idempotent: true,
      };
    throw new ApiError(
      409,
      "REPORT_NOT_SUBMITTABLE",
      "Report 尚未进入可提交审核状态。",
    );
  });
}

export async function reportRoutes(app: FastifyInstance) {
  app.get("/v1/individual-reports/:id", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const report = await loadReport(actor, id);
    const current = report.payload
      ? {
          id: report.id,
          title: report.title,
          summary: report.summary,
          markdown: report.markdown,
          payload: report.payload,
          created_at: report.updated_at,
        }
      : null;
    return {
      report,
      current,
    };
  });

  app.post("/v1/individual-reports/:id/regenerate", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = regenerationSchema.parse(request.body);
    const job = await regenerateIndividualReport(actor, {
      reportId: id,
      instruction: input.instruction,
      contentRevision: input.contentRevision,
    });
    await audit(
      request,
      actor,
      "individual_report.regeneration_requested",
      "individual_report",
      id,
      {
        instructionLength: input.instruction.length,
      },
    );
    return job;
  });

  app.post("/v1/individual-reports/:id/return-to-items", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { reviewId } = await sql.begin(async (tx) => {
      const references = await tx<Array<{ review_id: string }>>`
        select wis.review_id
        from individual_reports ir
        join work_item_snapshots wis
          on wis.id = ir.snapshot_id and wis.tenant_id = ir.tenant_id
          and wis.team_id = ir.team_id and wis.partner_id = ir.partner_id
        where ir.id = ${id} and ir.tenant_id = ${actor.tenantId}
          and ir.team_id = ${actor.teamId} and ir.partner_id = ${actor.partnerId}
        limit 1
      `;
      const reviewId = references[0]?.review_id;
      if (!reviewId)
        throw new ApiError(
          409,
          "SNAPSHOT_INVALID",
          "Snapshot 缺少 Review 引用。",
        );

      const reviews = await tx<Array<{ id: string }>>`
        select id from reviews
        where id = ${reviewId} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and partner_id = ${actor.partnerId}
        for update
      `;
      if (!reviews[0])
        throw new ApiError(
          409,
          "SNAPSHOT_INVALID",
          "Snapshot 缺少有效的 Review 引用。",
        );

      const report = await loadReportForUpdate(tx, actor, id);
      if (["SUBMITTED", "LOCKED"].includes(report.status))
        throw new ApiError(
          409,
          "REPORT_LOCKED",
          "Report 已提交，不能返回事项层。",
        );
      const returned = await tx<Array<{ id: string }>>`
        update individual_reports set
          status = 'RETURNED_TO_ITEMS', updated_at = now()
        where id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and partner_id = ${actor.partnerId}
          and status not in ('SUBMITTED', 'LOCKED')
        returning id
      `;
      if (!returned[0])
        throw new ApiError(
          409,
          "REPORT_LOCKED",
          "Report 已提交，不能返回事项层。",
        );
      await tx`
        update reviews set
          state = 'IN_PROGRESS', version = version + 1, updated_at = now()
        where id = ${reviewId} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and partner_id = ${actor.partnerId}
      `;
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (
          ${randomUUID()}, ${actor.tenantId}, 'individual_report.returned_to_items', 'review', ${reviewId},
          ${JSON.stringify({ reportId: id })}::jsonb
        )
      `;
      return { reviewId };
    });
    await audit(
      request,
      actor,
      "individual_report.returned_to_items",
      "individual_report",
      id,
      { reviewId },
    );
    return { reviewId };
  });

  app.post("/v1/individual-reports/:id/submit", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { contentRevision } = z
      .object({ contentRevision: z.number().int().positive() })
      .parse(request.body);
    const result = await submitIndividualReport(actor, {
      reportId: id,
      contentRevision,
    });
    if (!result.idempotent)
      await audit(
        request,
        actor,
        "individual_report.submitted",
        "individual_report",
        id,
        { contentRevision },
      );
    const { idempotent, ...response } = result;
    return idempotent ? { ...response, idempotent: true } : response;
  });

  app.get("/v1/individual-reports/:id/download.md", async (request, reply) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const report = await loadReport(actor, id);
    if (!report.markdown)
      throw new ApiError(
        404,
        "REPORT_CONTENT_MISSING",
        "Report 尚未生成内容。",
      );
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="partner-report-${id}.md"`,
    );
    return report.markdown;
  });
}
