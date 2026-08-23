import type { FastifyInstance } from "fastify";
import { z } from "zod";
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

    if (["RESCAN_SESSIONS", "REANALYZE_SESSIONS"].includes(job.type)) {
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
