import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  aggregationResultSchema,
  assertReportSemantics,
  individualReportResultSchema,
} from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  randomToken,
  requirePluginActor,
  sha256,
  stableJsonHash,
} from "../common.js";

const failSchema = z.object({
  errorCode: z.string().min(1).max(120),
  message: z.string().min(1).max(1000),
  retryable: z.boolean().default(true),
});

async function applyAggregation(job: any, output: unknown) {
  if (job.input_payload.aggregationMode !== "weekly_report") {
    throw new ApiError(
      422,
      "WEEKLY_AGGREGATION_REQUIRED",
      "项目聚合只能由周周期截止任务触发。",
    );
  }
  const result = aggregationResultSchema.parse(output);
  const expectedFactIds = new Set<string>(
    (job.input_payload.facts as Array<{ id: string }>).map((fact) => fact.id),
  );
  const used = new Set<string>();
  for (const group of result.groups) {
    for (const factId of group.factIds) {
      if (!expectedFactIds.has(factId))
        throw new ApiError(
          422,
          "UNKNOWN_FACT_REFERENCE",
          `聚合结果引用了未知 Fact: ${factId}`,
        );
      if (used.has(factId))
        throw new ApiError(
          422,
          "DUPLICATE_FACT_REFERENCE",
          `Fact 被重复聚合: ${factId}`,
        );
      used.add(factId);
    }
  }
  const unassigned = new Set<string>();
  for (const factId of result.unassignedFactIds) {
    if (!expectedFactIds.has(factId))
      throw new ApiError(
        422,
        "UNKNOWN_FACT_REFERENCE",
        `未分配集合引用了未知 Fact: ${factId}`,
      );
    if (used.has(factId) || unassigned.has(factId))
      throw new ApiError(
        422,
        "DUPLICATE_FACT_REFERENCE",
        `Fact 被重复引用: ${factId}`,
      );
    unassigned.add(factId);
  }
  for (const factId of expectedFactIds) {
    if (!used.has(factId) && !unassigned.has(factId))
      throw new ApiError(
        422,
        "FACT_COVERAGE_INCOMPLETE",
        `聚合结果遗漏 Fact: ${factId}`,
      );
  }
  const reviewId = job.input_payload.reviewId as string;
  const existing = await sql<any[]>`
    select review_status from work_items
    where tenant_id = ${job.tenant_id} and review_id = ${reviewId}
  `;
  if (existing.some((item) => item.review_status !== "pending")) {
    throw new ApiError(
      409,
      "REVIEW_ALREADY_STARTED",
      "审核已开始，新的聚合结果不能静默覆盖 Partner 决策。",
    );
  }

  await sql.begin(async (tx) => {
    await tx`delete from work_item_facts where work_item_id in (select id from work_items where review_id = ${reviewId})`;
    await tx`delete from work_items where review_id = ${reviewId}`;
    for (const group of result.groups) {
      const workItemId = randomUUID();
      const payload = {
        summary: group.summary,
        outcomes: group.outcomes,
        blockers: group.blockers,
        nextSteps: group.nextSteps,
        importance: group.importance,
        projectConfidence: group.projectConfidence,
        assignmentMethod: group.assignmentMethod,
        mergeConfidence: group.mergeConfidence,
        rationaleCodes: group.rationaleCodes,
        emphasis: false,
      };
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
          title, status, fact_ids, payload
        ) values (
          ${workItemId}, ${job.tenant_id}, ${job.team_id}, ${job.partner_id},
          ${(job.input_payload.period as { id: string }).id}, ${reviewId}, ${group.projectId ?? null},
          ${group.title}, ${group.status}, ${JSON.stringify(group.factIds)}::jsonb, ${JSON.stringify(payload)}::jsonb
        )
      `;
      for (const factId of group.factIds) {
        await tx`insert into work_item_facts (work_item_id, fact_id) values (${workItemId}, ${factId})`;
      }
    }
    await tx`
      update reviews set
        state = 'IN_PROGRESS', version = version + 1, approved_count = 0, excluded_count = 0,
        pending_count = ${result.groups.length}, updated_at = now()
      where id = ${reviewId} and tenant_id = ${job.tenant_id}
    `;
    await tx`
      insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values (
        ${randomUUID()}, ${job.tenant_id}, 'work_items.draft.created', 'review', ${reviewId},
        ${JSON.stringify({ count: result.groups.length, warnings: result.qualityWarnings })}::jsonb
      )
    `;
  });
}

async function applyReport(job: any, output: unknown) {
  const result = individualReportResultSchema.parse(output);
  assertReportSemantics(result);
  const reportId = job.input_payload.reportId as string;
  const allowedIds = new Set<string>(
    (job.input_payload.workItems as Array<{ id: string }>).map(
      (item) => item.id,
    ),
  );
  for (const section of result.sections) {
    for (const claim of section.claims) {
      for (const id of claim.workItemIds) {
        if (!allowedIds.has(id))
          throw new ApiError(
            422,
            "UNKNOWN_WORK_ITEM_REFERENCE",
            `Report 引用了未知 Work Item: ${id}`,
          );
      }
    }
  }
  const reportRows = await sql<
    any[]
  >`select * from individual_reports where id = ${reportId} and tenant_id = ${job.tenant_id}`;
  const report = reportRows[0];
  if (!report || ["SUBMITTED", "LOCKED"].includes(report.status)) {
    throw new ApiError(409, "REPORT_NOT_EDITABLE", "Report 已提交或不存在。");
  }
  const version = report.current_version + 1;
  await sql.begin(async (tx) => {
    await tx`
      insert into individual_report_versions (
        id, tenant_id, report_id, version, title, summary, markdown, payload,
        preferences, source_checksum, generator_version
      ) values (
        ${randomUUID()}, ${job.tenant_id}, ${reportId}, ${version}, ${result.title}, ${result.summary},
        ${result.markdown}, ${JSON.stringify(result)}::jsonb,
        ${JSON.stringify(job.input_payload.preferences ?? {})}::jsonb,
        ${job.input_payload.sourceChecksum}, ${job.input_payload.generatorVersion ?? "partner-report-sync/0.1.0"}
      )
    `;
    await tx`
      update individual_reports set status = 'REPORT_REVIEW', current_version = ${version}, updated_at = now()
      where id = ${reportId} and tenant_id = ${job.tenant_id}
    `;
    await tx`
      insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values (
        ${randomUUID()}, ${job.tenant_id}, 'individual_report.draft.created', 'individual_report', ${reportId},
        ${JSON.stringify({ version, warnings: result.qualityWarnings })}::jsonb
      )
    `;
  });
}

export async function jobRoutes(app: FastifyInstance) {
  app.get("/v1/agent-jobs/pending", async (request) => {
    const actor = await requirePluginActor(request);
    await sql`
      update agent_jobs set status = 'PENDING', lease_token_hash = null, lease_until = null, updated_at = now()
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and plugin_instance_id = ${actor.pluginInstanceId}
        and type in ('RESCAN_SESSIONS', 'REANALYZE_SESSIONS')
        and status = 'LEASED' and lease_until < now() and attempt_count < max_attempts
    `;
    return sql<any[]>`
      select id, type, status, attempt_count, max_attempts, created_at
      from agent_jobs
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and plugin_instance_id = ${actor.pluginInstanceId}
        and type in ('RESCAN_SESSIONS', 'REANALYZE_SESSIONS') and status = 'PENDING'
      order by created_at asc limit 20
    `;
  });

  app.post("/v1/agent-jobs/:id/ack", async (request) => {
    const actor = await requirePluginActor(request);
    const id = (request.params as { id: string }).id;
    const leaseToken = randomToken();
    const rows = await sql<any[]>`
      update agent_jobs set
        status = 'LEASED', lease_token_hash = ${sha256(leaseToken)}, lease_until = now() + interval '15 minutes',
        attempt_count = attempt_count + 1, updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and plugin_instance_id = ${actor.pluginInstanceId}
        and type in ('RESCAN_SESSIONS', 'REANALYZE_SESSIONS') and status = 'PENDING'
      returning id, type, input_payload, attempt_count, lease_until
    `;
    const job = rows[0];
    if (!job)
      throw new ApiError(409, "JOB_LEASE_CONFLICT", "任务已被领取或不可执行。");
    await audit(request, actor, "agent_job.leased", "agent_job", id, {
      type: job.type,
      attempt: job.attempt_count,
    });
    return { ...job, leaseToken };
  });

  app.post("/v1/agent-jobs/:id/complete", async (request) => {
    const actor = await requirePluginActor(request);
    const id = (request.params as { id: string }).id;
    const leaseToken = request.headers["x-job-lease"];
    if (typeof leaseToken !== "string")
      throw new ApiError(400, "LEASE_TOKEN_REQUIRED", "缺少任务租约 Token。");
    const rows = await sql<any[]>`
      select * from agent_jobs
      where id = ${id} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and status = 'LEASED' and lease_token_hash = ${sha256(leaseToken)} and lease_until > now()
      limit 1
    `;
    const job = rows[0];
    if (!job) {
      const completedRows = await sql<any[]>`
        select output_payload from agent_jobs
        where id = ${id} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
          and plugin_instance_id = ${actor.pluginInstanceId} and status = 'COMPLETED'
        limit 1
      `;
      const completed = completedRows[0];
      if (
        completed &&
        stableJsonHash(completed.output_payload) ===
          stableJsonHash(request.body)
      ) {
        return { ok: true, idempotent: true };
      }
      if (completed)
        throw new ApiError(
          409,
          "JOB_ALREADY_COMPLETED",
          "任务已使用不同结果完成。",
        );
      throw new ApiError(409, "JOB_LEASE_INVALID", "任务租约无效或已过期。");
    }

    if (job.type === "AGGREGATE_WORK_ITEMS")
      await applyAggregation(job, request.body);
    else if (
      ["GENERATE_INDIVIDUAL_REPORT", "REGENERATE_INDIVIDUAL_REPORT"].includes(
        job.type,
      )
    ) {
      await applyReport(job, request.body);
    } else if (["RESCAN_SESSIONS", "REANALYZE_SESSIONS"].includes(job.type)) {
      z.object({
        completed: z.literal(true),
        batchIds: z.array(z.string()).default([]),
      }).parse(request.body);
    } else {
      throw new ApiError(
        422,
        "JOB_TYPE_UNSUPPORTED",
        `不支持的任务类型: ${job.type}`,
      );
    }

    await sql`
      update agent_jobs set status = 'COMPLETED', output_payload = ${JSON.stringify(request.body)}::jsonb,
        completed_at = now(), lease_token_hash = null, lease_until = null, updated_at = now()
      where id = ${id} and lease_token_hash = ${sha256(leaseToken)}
    `;
    await audit(request, actor, "agent_job.completed", "agent_job", id, {
      type: job.type,
    });
    return { ok: true };
  });

  app.post("/v1/agent-jobs/:id/fail", async (request) => {
    const actor = await requirePluginActor(request);
    const id = (request.params as { id: string }).id;
    const leaseToken = request.headers["x-job-lease"];
    if (typeof leaseToken !== "string")
      throw new ApiError(400, "LEASE_TOKEN_REQUIRED", "缺少任务租约 Token。");
    const input = failSchema.parse(request.body);
    const rows = await sql<any[]>`
      update agent_jobs set
        status = case when ${input.retryable} and attempt_count < max_attempts then 'PENDING' else 'FAILED' end,
        error_code = ${input.errorCode}, error_message = ${input.message},
        lease_token_hash = null, lease_until = null, updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and status = 'LEASED' and lease_token_hash = ${sha256(leaseToken)}
      returning status, type
    `;
    if (!rows[0])
      throw new ApiError(409, "JOB_LEASE_INVALID", "任务租约无效或已过期。");
    await audit(request, actor, "agent_job.failed", "agent_job", id, {
      type: rows[0].type,
      status: rows[0].status,
      errorCode: input.errorCode,
    });
    return rows[0];
  });
}
