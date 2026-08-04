import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  containsSensitiveValue,
  sessionContributionSchema,
  sessionContributionStateQuerySchema,
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
  app.get("/v1/session-contributions/state", async (request) => {
    const actor = await requirePluginActor(request);
    const query = sessionContributionStateQuerySchema.parse(request.query);
    const rows = await sql<any[]>`
      select sr.session_id, sr.source_hash, sr.observed_at
      from session_records sr
      join report_periods rp on rp.id = sr.period_id
      where sr.tenant_id = ${actor.tenantId}
        and sr.team_id = ${actor.teamId}
        and sr.partner_id = ${actor.partnerId}
        and rp.period_key = ${query.periodKey}
      order by sr.observed_at desc
    `;
    return {
      periodKey: query.periodKey,
      sessions: rows.map((row) => ({
        sessionKey: row.session_id,
        contentHash: row.source_hash,
        observedAt: row.observed_at,
      })),
    };
  });

  app.post("/v1/session-contributions", async (request) => {
    const actor = await requirePluginActor(request);
    const input = sessionContributionSchema.parse(request.body);
    if (containsSensitiveValue(input)) {
      throw new ApiError(
        422,
        "SENSITIVE_PAYLOAD_BLOCKED",
        "Session Contribution 触发敏感信息拦截，请在本地完成脱敏后重试。",
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

    const requestedPeriods = await sql<any[]>`
      select * from report_periods
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and period_key = ${input.periodKey}
      limit 1
    `;
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
      period?.period_key !== input.periodKey ? input.periodKey : null;
    if (!period)
      throw new ApiError(
        409,
        "REPORT_PERIOD_MISSING",
        "当前 Team 没有开放的 Report Period。",
      );
    const response = await sql.begin(async (tx) => {
      const resolvedProject = await resolveProjectIdentity(
        tx,
        actor,
        input.project,
      );
      const existingRecords = await tx<any[]>`
        select latest_source_revision, source_hash, period_id
        from session_records
        where tenant_id = ${actor.tenantId}
          and partner_id = ${actor.partnerId}
          and session_id = ${input.sessionKey}
        for update
      `;
      const existingRecord = existingRecords[0];
      const unchanged =
        existingRecord?.source_hash === input.contentHash &&
        existingRecord?.period_id === period.id;
      const revision = unchanged
        ? existingRecord.latest_source_revision
        : (existingRecord?.latest_source_revision ?? 0) + 1;
      let contributionId: string | undefined;

      if (!unchanged) {
        await tx`
          insert into session_records (
            id, tenant_id, team_id, partner_id, period_id,
            session_id, latest_source_revision, source_hash, status, observed_at,
            source_occurred_at, late_from_period_key
          ) values (
            ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
            ${input.sessionKey}, ${revision}, ${input.contentHash}, 'extracted',
            ${input.observedAt}, ${input.activity.endedAt}, ${lateFromPeriodKey}
          ) on conflict (tenant_id, partner_id, session_id) do update set
            period_id = excluded.period_id,
            latest_source_revision = excluded.latest_source_revision,
            source_hash = excluded.source_hash,
            status = excluded.status,
            observed_at = excluded.observed_at,
            source_occurred_at = excluded.source_occurred_at,
            late_from_period_key = excluded.late_from_period_key,
            updated_at = now()
        `;
        await tx`
          update session_facts set current = false, updated_at = now()
          where tenant_id = ${actor.tenantId}
            and partner_id = ${actor.partnerId}
            and session_id = ${input.sessionKey}
            and current = true
        `;
        contributionId = randomUUID();
        const payload = {
          ...input,
          recordType: "session_contribution",
          project: {
            id: resolvedProject?.id ?? null,
            name: resolvedProject?.name ?? input.project.name,
            matchMethod: resolvedProject?.matchMethod ?? "unassigned",
            rootFingerprint:
              resolvedProject?.rootFingerprint ?? input.project.rootFingerprint,
          },
          projectId: resolvedProject?.id ?? null,
          projectMatchMethod: resolvedProject?.matchMethod ?? "unassigned",
          projectRootFingerprint:
            resolvedProject?.rootFingerprint ?? input.project.rootFingerprint,
        };
        await tx`
          insert into session_facts (
            id, tenant_id, team_id, partner_id, period_id,
            session_id, external_fact_id, source_revision, source_hash,
            source_occurred_at, late_from_period_key, payload, current
          ) values (
            ${contributionId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
            ${input.sessionKey}, ${`${input.sessionKey}:contribution`}, ${revision}, ${input.contentHash},
            ${input.activity.endedAt}, ${lateFromPeriodKey}, ${JSON.stringify(payload)}::jsonb, true
          )
        `;
      }

      const result = {
        status: unchanged ? "unchanged" : "accepted",
        sessionKey: input.sessionKey,
        contentHash: input.contentHash,
        revision,
        ...(contributionId ? { contributionId } : {}),
      };
      await tx`
        insert into sync_batches (
          id, tenant_id, team_id, partner_id, plugin_instance_id,
          external_batch_id, idempotency_key, payload_hash, accepted, rejected, response
        ) values (
          ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
          ${actor.pluginInstanceId}, ${input.sessionKey}, ${idempotencyKey},
          ${payloadHash}, 1, 0, ${JSON.stringify(result)}::jsonb
        )
      `;
      return result;
    });

    await sql`
      update plugin_instances set last_sync_at = now(), last_heartbeat_at = now(), updated_at = now()
      where id = ${actor.pluginInstanceId}
    `;
    await audit(
      request,
      actor,
      "session.contribution.ingested",
      "session_contribution",
      input.sessionKey,
      {
        status: response.status,
        revision: response.revision,
        lateFromPeriodKey,
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
