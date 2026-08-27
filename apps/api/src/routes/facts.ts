import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  containsSensitiveValue,
  sessionContributionIngestSchema,
  sessionContributionStateQuerySchema,
} from "@partner-report/contracts";
import {
  DEFAULT_WEEKLY_PERIOD_RULE,
  sqlClient as sql,
  weeklyPeriodAt,
  weeklyPeriodKeyCandidates,
  type WeeklyPeriodRule,
} from "@partner-report/db";
import {
  ApiError,
  audit,
  requirePluginActor,
  requireWebActor,
  stableJsonHash,
} from "../common.js";
import { resolveProjectIdentity } from "../project-discovery.js";

async function ensureIngestionPeriod(actor: {
  tenantId: string;
  teamId: string;
}) {
  const now = new Date();
  const openPeriods = await sql<any[]>`
    select * from report_periods
    where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      and status = 'open' and cutoff_at > ${now.toISOString()}
    order by starts_at desc limit 1
  `;
  if (openPeriods[0]) return openPeriods[0];

  const teams = await sql<any[]>`
    select t.timezone, t.period_rule,
      (
        select rp.template_id from report_periods rp
        where rp.tenant_id = t.tenant_id and rp.team_id = t.id
        order by rp.starts_at desc limit 1
      ) as template_id
    from teams t
    where t.id = ${actor.teamId} and t.tenant_id = ${actor.tenantId}
      and t.report_type = 'weekly'
    limit 1
  `;
  const team = teams[0];
  if (!team)
    throw new ApiError(
      409,
      "REPORT_PERIOD_MISSING",
      "当前 Team 没有可用的 Report Period。",
    );
  const period = weeklyPeriodAt(
    now,
    team.timezone,
    (team.period_rule ?? DEFAULT_WEEKLY_PERIOD_RULE) as WeeklyPeriodRule,
  );
  for (const periodKey of weeklyPeriodKeyCandidates(period)) {
    const inserted = await sql<{ id: string }[]>`
      insert into report_periods (
        id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
        submission_deadline_at, timezone, status, template_id
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${periodKey},
        ${period.startsAt.toISOString()}, ${period.endsAt.toISOString()},
        ${period.cutoffAt.toISOString()}, ${period.submissionDeadlineAt.toISOString()},
        ${team.timezone}, 'open', ${team.template_id}
      ) on conflict (tenant_id, team_id, period_key) do nothing returning id
    `;
    if (inserted[0]) break;
    const concurrentOpen = await sql<{ id: string }[]>`
      select id from report_periods
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'open' and cutoff_at > ${now.toISOString()}
      order by starts_at desc limit 1
    `;
    if (concurrentOpen[0]) break;
  }
  const created = await sql<any[]>`
    select * from report_periods
    where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      and status = 'open' and cutoff_at > ${now.toISOString()}
    order by starts_at desc limit 1
  `;
  if (!created[0])
    throw new ApiError(
      409,
      "REPORT_PERIOD_MISSING",
      "当前 Team 没有开放的 Report Period。",
    );
  return created[0];
}

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
    const input = sessionContributionIngestSchema.parse(request.body);
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

    const period = await ensureIngestionPeriod(actor);
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
            source_occurred_at
          ) values (
            ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
            ${input.sessionKey}, ${revision}, ${input.contentHash}, 'extracted',
            ${input.observedAt}, ${input.activity.endedAt}
          ) on conflict (tenant_id, partner_id, session_id) do update set
            period_id = excluded.period_id,
            latest_source_revision = excluded.latest_source_revision,
            source_hash = excluded.source_hash,
            status = excluded.status,
            observed_at = excluded.observed_at,
            source_occurred_at = excluded.source_occurred_at,
            updated_at = now()
        `;
        const nextContributionId = randomUUID();
        const payload = {
          ...input,
          periodKey: period.period_key,
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
          update session_facts set current = false, updated_at = now()
          where tenant_id = ${actor.tenantId}
            and partner_id = ${actor.partnerId}
            and session_id = ${input.sessionKey}
            and current = true
            and source_hash <> ${input.contentHash}
        `;
        const contributionRows = await tx<{ id: string }[]>`
          insert into session_facts (
            id, tenant_id, team_id, partner_id, period_id,
            session_id, external_fact_id, source_revision, source_hash,
            source_occurred_at, payload, current
          ) values (
            ${nextContributionId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${period.id},
            ${input.sessionKey}, ${`${input.sessionKey}:${input.contentHash}:contribution`}, ${revision}, ${input.contentHash},
            ${input.activity.endedAt}, ${JSON.stringify(payload)}::jsonb, true
          )
          on conflict (tenant_id, partner_id, session_id, external_fact_id)
          do update set
            team_id = excluded.team_id,
            period_id = excluded.period_id,
            source_revision = excluded.source_revision,
            source_hash = excluded.source_hash,
            source_occurred_at = excluded.source_occurred_at,
            payload = excluded.payload,
            current = true,
            excluded = false,
            updated_at = now()
          returning id
        `;
        contributionId = contributionRows[0]!.id;
      }

      const result = {
        status: unchanged ? "unchanged" : "accepted",
        sessionKey: input.sessionKey,
        contentHash: input.contentHash,
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
        aggregationBatch: period.period_key,
        aggregationAt: period.cutoff_at,
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
        sessionDate: z.string().date().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(10),
      })
      .parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const [rows, projectRows, unassignedRows] = await Promise.all([
      sql<any[]>`
        select sf.id, sf.partner_id, p.display_name as partner_name,
          sf.period_id, rp.period_key, sf.session_id, sf.external_fact_id,
          sf.source_hash, sf.source_occurred_at,
          sf.payload, sf.created_at, sf.updated_at,
          count(*) over()::int as total
        from session_facts sf
        join partners p on p.id = sf.partner_id and p.tenant_id = sf.tenant_id
        left join report_periods rp on rp.id = sf.period_id
        where sf.tenant_id = ${actor.tenantId} and sf.team_id = ${actor.teamId}
          and sf.current = true
          and sf.excluded = false
          and (${query.partnerId ?? null}::uuid is null or sf.partner_id = ${query.partnerId ?? null})
          and (${query.periodId ?? null}::uuid is null or sf.period_id = ${query.periodId ?? null})
          and (
            ${query.projectId ?? null}::text is null
            or (${query.projectId ?? null} = 'unassigned' and sf.payload->>'projectId' is null)
            or sf.payload->>'projectId' = ${query.projectId ?? null}
          )
          and (
            ${query.sessionDate ?? null}::date is null
            or (sf.source_occurred_at at time zone 'Asia/Shanghai')::date = ${query.sessionDate ?? null}::date
          )
        order by sf.source_occurred_at desc nulls last, sf.created_at desc
        limit ${query.pageSize} offset ${offset}
      `,
      sql<Array<{ id: string; name: string }>>`
        select id, name
        from (
          select distinct on (sf.payload->>'projectId')
            sf.payload->>'projectId' as id,
            coalesce(
              nullif(sf.payload->'project'->>'name', ''),
              project.name,
              '未知项目'
            ) as name
          from session_facts sf
          left join projects project
            on project.id::text = sf.payload->>'projectId'
            and project.tenant_id = sf.tenant_id
            and project.team_id = sf.team_id
          where sf.tenant_id = ${actor.tenantId} and sf.team_id = ${actor.teamId}
            and sf.current = true
            and sf.excluded = false
            and sf.payload->>'projectId' is not null
          order by sf.payload->>'projectId', sf.updated_at desc
        ) uploaded_projects
        order by name
      `,
      sql<Array<{ has_unassigned: boolean }>>`
        select exists (
          select 1 from session_facts sf
          where sf.tenant_id = ${actor.tenantId} and sf.team_id = ${actor.teamId}
            and sf.current = true
            and sf.excluded = false
            and sf.payload->>'projectId' is null
        ) as has_unassigned
      `,
    ]);
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
      projects: projectRows,
      hasUnassigned: unassignedRows[0]?.has_unassigned ?? false,
    };
  });
}
