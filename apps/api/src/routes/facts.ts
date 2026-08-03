import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  assertFactSemantics,
  containsSensitiveValue,
  factBatchSchema,
} from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  requirePluginActor,
  stableJsonHash,
} from "../common.js";

export async function factRoutes(app: FastifyInstance) {
  app.post("/v1/session-facts/batch", async (request) => {
    const actor = await requirePluginActor(request);
    const input = factBatchSchema.parse(request.body);
    for (const session of input.sessions)
      for (const fact of session.facts) assertFactSemantics(fact);
    if (containsSensitiveValue(input)) {
      throw new ApiError(
        422,
        "SENSITIVE_PAYLOAD_BLOCKED",
        "Fact Payload 触发敏感信息拦截，请在本地完成脱敏后重试。",
      );
    }
    if (input.pluginInstanceId !== actor.pluginInstanceId) {
      throw new ApiError(
        403,
        "PLUGIN_INSTANCE_MISMATCH",
        "批次不属于当前 Plugin Instance。",
      );
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      throw new ApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "写请求必须提供 Idempotency-Key。",
      );
    }
    const payloadHash = stableJsonHash(input);
    const existingRows = await sql<any[]>`
      select payload_hash, response from sync_batches
      where tenant_id = ${actor.tenantId} and plugin_instance_id = ${actor.pluginInstanceId}
        and idempotency_key = ${idempotencyKey}
      limit 1
    `;
    const existing = existingRows[0];
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "相同 Idempotency-Key 对应了不同 Payload。",
        );
      }
      return existing.response;
    }

    const periodRows = await sql<any[]>`
      select * from report_periods
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and status = 'open'
        and starts_at <= now() and ends_at >= now()
      order by starts_at desc limit 1
    `;
    const period = periodRows[0];
    if (!period)
      throw new ApiError(
        409,
        "REPORT_PERIOD_MISSING",
        "当前 Team 没有开放的 Report Period。",
      );

    const results: Array<{
      sessionId: string;
      status: string;
      revision: number;
      code?: string;
    }> = [];
    let accepted = 0;
    let rejected = 0;

    for (const session of input.sessions) {
      try {
        await sql.begin(async (tx) => {
          await tx`
            insert into session_records (
              id, tenant_id, team_id, partner_id, period_id, session_id,
              latest_source_revision, source_hash, status, observed_at
            ) values (
              ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
              ${session.sessionId}, ${session.sourceRevision}, ${session.sourceHash}, ${session.status},
              ${session.observedAt}
            ) on conflict (tenant_id, partner_id, session_id) do update set
              period_id = excluded.period_id,
              latest_source_revision = excluded.latest_source_revision,
              source_hash = excluded.source_hash,
              status = excluded.status,
              observed_at = excluded.observed_at,
              updated_at = now()
            where session_records.latest_source_revision <= excluded.latest_source_revision
          `;
          for (const fact of session.facts) {
            await tx`
              update session_facts set current = false, updated_at = now()
              where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
                and session_id = ${session.sessionId} and external_fact_id = ${fact.factId}
                and source_revision < ${session.sourceRevision}
            `;
            await tx`
              insert into session_facts (
                id, tenant_id, team_id, partner_id, period_id, session_id, external_fact_id,
                source_revision, source_hash, payload, current
              ) values (
                ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
                ${session.sessionId}, ${fact.factId}, ${session.sourceRevision}, ${session.sourceHash},
                ${JSON.stringify({
                  ...fact,
                  projectId: session.project.id,
                  projectMatchMethod: session.project.matchMethod,
                  projectRootFingerprint: session.project.rootFingerprint,
                })}::jsonb, true
              ) on conflict (tenant_id, partner_id, session_id, source_revision, external_fact_id)
                do update set payload = excluded.payload, source_hash = excluded.source_hash, current = true, updated_at = now()
            `;
          }
        });
        accepted += 1;
        results.push({
          sessionId: session.sessionId,
          status: "accepted",
          revision: session.sourceRevision,
        });
      } catch {
        rejected += 1;
        results.push({
          sessionId: session.sessionId,
          status: "rejected",
          revision: session.sourceRevision,
          code: "PERSIST_FAILED",
        });
      }
    }

    const coverageRows = await sql<any[]>`
      select
        count(*)::int as discovered,
        count(*) filter (where status not in ('failed_read', 'excluded'))::int as readable,
        count(*) filter (where status = 'extracted')::int as extracted,
        count(*) filter (where status = 'failed_read')::int as failed_read,
        count(*) filter (where status = 'failed_extract')::int as failed_extract,
        count(*) filter (where status = 'excluded')::int as excluded
      from session_records
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and period_id = ${period.id}
    `;
    const coverageRow = coverageRows[0];
    const coverage = {
      discovered: coverageRow.discovered,
      readable: coverageRow.readable,
      extracted: coverageRow.extracted,
      failedRead: coverageRow.failed_read,
      failedExtract: coverageRow.failed_extract,
      excluded: coverageRow.excluded,
      pendingSync: 0,
      activeAtCutoff: 0,
      hookMissed: 0,
      warnings: [],
      lastSyncAt: new Date().toISOString(),
    };
    await sql`
      insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
      values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
        ${JSON.stringify(coverage)}::jsonb
      )
    `;

    const response = {
      batchId: input.batchId,
      accepted,
      rejected,
      results,
      coverage,
    };
    await sql`
      insert into sync_batches (
        id, tenant_id, team_id, partner_id, plugin_instance_id, external_batch_id,
        idempotency_key, payload_hash, accepted, rejected, response
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${actor.pluginInstanceId},
        ${input.batchId}, ${idempotencyKey}, ${payloadHash}, ${accepted}, ${rejected}, ${JSON.stringify(response)}::jsonb
      )
    `;

    await sql`
      update plugin_instances set last_sync_at = now(), last_heartbeat_at = now(), updated_at = now()
      where id = ${actor.pluginInstanceId}
    `;
    await audit(
      request,
      actor,
      "session.facts.ingested",
      "sync_batch",
      input.batchId,
      {
        accepted,
        rejected,
        weeklyAggregationDeferredUntil: period.cutoff_at,
      },
    );
    return response;
  });

  app.get("/v1/coverage/:periodId", async (request) => {
    const actor = await requirePluginActor(request);
    const periodId = (request.params as { periodId: string }).periodId;
    const rows = await sql<any[]>`
      select payload, created_at from coverage_snapshots
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and period_id = ${periodId}
      order by created_at desc limit 1
    `;
    return rows[0] ?? { payload: null };
  });
}
