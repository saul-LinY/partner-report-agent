import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertFactSemantics,
  containsSensitiveValue,
  factBatchSchema,
  projectDiscoveryBatchSchema,
} from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  requirePluginActor,
  requireWebActor,
  stableJsonHash,
} from "../common.js";
import { resolveProjectIdentity } from "../project-discovery.js";

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

    const requestedPeriodKey =
      input.periodKey ?? input.periodCandidates[0] ?? null;
    const requestedPeriods = requestedPeriodKey
      ? await sql<any[]>`
          select * from report_periods
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and period_key = ${requestedPeriodKey}
          limit 1
        `
      : [];
    const currentPeriods = await sql<any[]>`
      select * from report_periods
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status in ('open', 'closing')
      order by case when status = 'open' then 0 else 1 end, starts_at desc
      limit 1
    `;
    const requestedPeriod = requestedPeriods[0];
    const requestedAccepting =
      requestedPeriod && ["open", "closing"].includes(requestedPeriod.status);
    const period = requestedAccepting ? requestedPeriod : currentPeriods[0];
    const lateFromPeriodKey =
      requestedPeriodKey && period?.period_key !== requestedPeriodKey
        ? requestedPeriodKey
        : null;
    if (!period)
      throw new ApiError(
        409,
        "REPORT_PERIOD_MISSING",
        "当前 Team 没有开放的 Report Period。",
      );
    let collectionRun: { id: string } | undefined;
    if (input.collectionRunId) {
      const runRows = await sql<{ id: string }[]>`
        select id from collection_runs
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and partner_id = ${actor.partnerId}
          and plugin_instance_id = ${actor.pluginInstanceId}
          and external_run_id = ${input.collectionRunId}
        limit 1
      `;
      collectionRun = runRows[0];
      if (!collectionRun)
        throw new ApiError(
          409,
          "COLLECTION_RUN_NOT_FOUND",
          "Fact 批次不属于已登记的采集 Run。",
        );
    }

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
          const resolvedProject = await resolveProjectIdentity(
            tx,
            actor,
            session.project,
          );
          await tx`
            insert into session_records (
              id, tenant_id, team_id, partner_id, period_id, collection_run_id,
              session_id, latest_source_revision, source_hash, status, observed_at,
              source_occurred_at, late_from_period_key
            ) values (
              ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id}, ${collectionRun?.id ?? null},
              ${session.sessionId}, ${session.sourceRevision}, ${session.sourceHash}, ${session.status},
              ${session.observedAt}, ${session.sourceOccurredAt ?? session.observedAt}, ${lateFromPeriodKey}
            ) on conflict (tenant_id, partner_id, session_id) do update set
              period_id = excluded.period_id,
              collection_run_id = excluded.collection_run_id,
              latest_source_revision = excluded.latest_source_revision,
              source_hash = excluded.source_hash,
              status = excluded.status,
              observed_at = excluded.observed_at,
              source_occurred_at = excluded.source_occurred_at,
              late_from_period_key = excluded.late_from_period_key,
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
                id, tenant_id, team_id, partner_id, period_id, collection_run_id,
                session_id, external_fact_id, source_revision, source_hash,
                source_occurred_at, late_from_period_key, payload, current
              ) values (
                ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id}, ${collectionRun?.id ?? null},
                ${session.sessionId}, ${fact.factId}, ${session.sourceRevision}, ${session.sourceHash},
                ${session.sourceOccurredAt ?? session.observedAt}, ${lateFromPeriodKey},
                ${JSON.stringify({
                  ...fact,
                  projectId: resolvedProject?.id ?? null,
                  projectMatchMethod:
                    resolvedProject?.matchMethod ?? "unassigned",
                  projectRootFingerprint:
                    resolvedProject?.rootFingerprint ??
                    session.project.rootFingerprint,
                })}::jsonb, true
              ) on conflict (tenant_id, partner_id, session_id, source_revision, external_fact_id)
                do update set payload = excluded.payload, source_hash = excluded.source_hash,
                  period_id = excluded.period_id, collection_run_id = excluded.collection_run_id,
                  source_occurred_at = excluded.source_occurred_at,
                  late_from_period_key = excluded.late_from_period_key,
                  current = true, updated_at = now()
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
        collection_run_id, idempotency_key, payload_hash, accepted, rejected, response
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${actor.pluginInstanceId},
        ${input.batchId}, ${collectionRun?.id ?? null}, ${idempotencyKey}, ${payloadHash}, ${accepted}, ${rejected}, ${JSON.stringify(response)}::jsonb
      )
    `;

    if (collectionRun) {
      await sql`
        update collection_runs set
          synced_session_count = synced_session_count + ${accepted},
          synced_fact_count = synced_fact_count + ${input.sessions.reduce(
            (sum: number, session: { facts: unknown[] }) =>
              sum + session.facts.length,
            0,
          )},
          updated_at = now()
        where id = ${collectionRun.id}
      `;
    }

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
        lateFromPeriodKey,
        weeklyAggregationDeferredUntil: period.cutoff_at,
      },
    );
    return response;
  });

  app.post(
    "/v1/plugin-instances/me/project-discoveries",
    async (request) => {
      const actor = await requirePluginActor(request);
      const input = projectDiscoveryBatchSchema.parse(request.body);
      const mappings = await sql.begin(async (tx) => {
        const resolved = [] as Array<{
          sessionId: string;
          projectId: string;
          projectName: string;
        }>;
        for (const discovery of input.discoveries) {
          const project = await resolveProjectIdentity(tx, actor, {
            id: null,
            matchMethod: "path_discovered",
            rootFingerprint: discovery.rootFingerprint,
            rootName: discovery.rootName,
          });
          if (!project) continue;
          const projectPayload = JSON.stringify({
            projectId: project.id,
            projectMatchMethod: "path_discovered",
            projectRootFingerprint: project.rootFingerprint,
          });
          await tx`
            update session_facts set
              payload = payload || ${projectPayload}::jsonb,
              updated_at = now()
            where tenant_id = ${actor.tenantId}
              and team_id = ${actor.teamId}
              and partner_id = ${actor.partnerId}
              and session_id = ${discovery.sessionId}
              and current = true and excluded = false
              and period_id in (
                select id from report_periods
                where tenant_id = ${actor.tenantId}
                  and team_id = ${actor.teamId}
                  and status in ('open', 'closing')
              )
          `;
          resolved.push({
            sessionId: discovery.sessionId,
            projectId: project.id,
            projectName: project.name,
          });
        }
        return resolved;
      });
      await audit(
        request,
        actor,
        "plugin.projects.discovered",
        "plugin_instance",
        actor.pluginInstanceId,
        { discovered: input.discoveries.length, mapped: mappings.length },
      );
      return { submitted: input.discoveries.length, mappings };
    },
  );

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

  app.get("/v1/admin/session-facts", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({
        partnerId: z.string().uuid().optional(),
        periodId: z.string().uuid().optional(),
        projectId: z
          .union([z.string().uuid(), z.literal("unassigned")])
          .optional(),
        sessionId: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const rows = await sql<any[]>`
      select sf.id, sf.partner_id, p.display_name as partner_name,
        sf.period_id, rp.period_key, sf.session_id, sf.external_fact_id,
        sf.source_revision, sf.source_hash, sf.source_occurred_at,
        sf.late_from_period_key, sf.payload, sf.created_at, sf.updated_at,
        count(*) over()::int as total
      from session_facts sf
      join partners p on p.id = sf.partner_id and p.tenant_id = sf.tenant_id
      left join report_periods rp on rp.id = sf.period_id
      where sf.tenant_id = ${actor.tenantId} and sf.team_id = ${actor.teamId}
        and sf.current = true and sf.excluded = false
        and (${query.partnerId ?? null}::uuid is null or sf.partner_id = ${query.partnerId ?? null})
        and (${query.periodId ?? null}::uuid is null or sf.period_id = ${query.periodId ?? null})
        and (
          ${query.projectId ?? null}::text is null
          or (${query.projectId ?? null} = 'unassigned' and sf.payload->>'projectId' is null)
          or sf.payload->>'projectId' = ${query.projectId ?? null}
        )
        and (${query.sessionId ?? null}::text is null or sf.session_id = ${query.sessionId ?? null})
      order by sf.source_occurred_at desc nulls last, sf.created_at desc
      limit ${query.pageSize} offset ${offset}
    `;
    return {
      items: rows.map(({ total: _total, ...row }) => ({
        ...row,
        payload: {
          ...row.payload,
          evidence: Array.isArray(row.payload?.evidence)
            ? row.payload.evidence.map(
                ({ excerpt: _excerpt, ...safe }: Record<string, unknown>) =>
                  safe,
              )
            : [],
        },
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: rows[0]?.total ?? 0,
    };
  });
}
