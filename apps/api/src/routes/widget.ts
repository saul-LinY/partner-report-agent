import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  sha256,
  type DomainActor,
  requirePluginActor,
} from "../common.js";
import { decideProjectScopes } from "../project-scope.js";
import { decideReviewWorkItem, regenerateReviewWorkItem } from "./reviews.js";

export const fixedReasonSchema = z.enum([
  "fact_inaccurate",
  "missing_content",
  "wrong_project",
  "simplify_expression",
]);

export const widgetActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project_scope"),
      pluginInstanceId: z.string().uuid(),
      scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
      baseVersion: z.number().int().positive(),
      decision: z.enum(["allow", "deny"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_scope_batch"),
      pluginInstanceId: z.string().uuid(),
      baseVersion: z.number().int().positive(),
      decisions: z
        .array(
          z.object({
            scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
            decision: z.enum(["allow", "deny"]),
          }),
        )
        .min(1)
        .max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("work_item_decision"),
      reviewId: z.string().uuid(),
      workItemId: z.string().uuid(),
      baseVersion: z.number().int().positive(),
      decision: z.enum(["approve", "exclude"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("work_item_regenerate"),
      reviewId: z.string().uuid(),
      workItemId: z.string().uuid(),
      baseVersion: z.number().int().positive(),
      reason: fixedReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("work_item_regenerate_custom"),
      reviewId: z.string().uuid(),
      workItemId: z.string().uuid(),
      baseVersion: z.number().int().positive(),
      instruction: z.string().trim().min(2).max(1200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connection_recovery_approve"),
      authorizationId: z.string().uuid(),
    })
    .strict(),
]);

export const widgetUnbindSchema = z
  .object({ bindingCode: z.string().trim().min(8).max(80) })
  .strict();

const reasonInstructions: Record<z.infer<typeof fixedReasonSchema>, string> = {
  fact_inaccurate: "事实有误，请重新核对关联贡献，只保留有事实依据的内容。",
  missing_content: "内容有遗漏，请补充关联贡献中的重要进展和结果。",
  wrong_project: "项目归属有误，请重新核对项目归类并生成。",
  simplify_expression: "表达过于复杂，请保持事实不变并改得更简洁清楚。",
};

function localDateKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addCalendarDays(dateKey: string, count: number) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function mondayOfWeek(dateKey: string) {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return addCalendarDays(dateKey, -((day + 6) % 7));
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function coverageValue(
  payload: Record<string, unknown> | undefined,
  key: string,
) {
  return numberValue(payload?.[key]);
}

export function buildWidgetDashboard(input: {
  now: Date;
  timezone: string;
  period?: {
    period_key: string;
    starts_at: Date | string;
    ends_at: Date | string;
  };
  collector?: Record<string, any>;
  snapshots: Array<{
    payload: Record<string, unknown>;
    created_at: Date | string;
  }>;
}) {
  const todayKey = localDateKey(input.now, input.timezone);
  const latestByDate = new Map<
    string,
    { payload: Record<string, unknown>; createdAt: Date }
  >();
  for (const snapshot of input.snapshots) {
    const createdAt = new Date(snapshot.created_at);
    const key = localDateKey(createdAt, input.timezone);
    const existing = latestByDate.get(key);
    if (!existing || createdAt > existing.createdAt)
      latestByDate.set(key, { payload: snapshot.payload ?? {}, createdAt });
  }

  const todayCoverage = latestByDate.get(todayKey)?.payload;
  const collector = input.collector;
  const completedAt = collector?.last_collection_completed_at
    ? new Date(collector.last_collection_completed_at)
    : undefined;
  const startedAt = collector?.last_collection_started_at
    ? new Date(collector.last_collection_started_at)
    : undefined;
  const latestErrorAt = collector?.latest_error_at
    ? new Date(collector.latest_error_at)
    : undefined;
  const completedToday = completedAt
    ? localDateKey(completedAt, input.timezone) === todayKey
    : false;
  const errorAfterCompletion = Boolean(
    latestErrorAt &&
    localDateKey(latestErrorAt, input.timezone) === todayKey &&
    (!completedAt || latestErrorAt > completedAt),
  );
  const running = Boolean(
    collector &&
    (collector.runner_state === "working" ||
      (startedAt && (!completedAt || startedAt > completedAt))),
  );
  const hasWarnings = Boolean(
    todayCoverage &&
    (coverageValue(todayCoverage, "failedRead") > 0 ||
      coverageValue(todayCoverage, "failedExtract") > 0 ||
      (Array.isArray(todayCoverage.warnings) &&
        todayCoverage.warnings.length > 0)),
  );
  const status = !collector
    ? "not_configured"
    : running
      ? "running"
      : errorAfterCompletion || collector.runner_state === "error"
        ? "failed"
        : completedToday
          ? hasWarnings
            ? "warning"
            : "success"
          : "pending";

  const useful = todayCoverage
    ? coverageValue(todayCoverage, "extracted")
    : completedToday
      ? numberValue(collector?.last_collection_session_count)
      : 0;
  const startKey = mondayOfWeek(todayKey);
  const labels = ["日", "一", "二", "三", "四", "五", "六"];
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addCalendarDays(startKey, index);
    const snapshotUseful = coverageValue(
      latestByDate.get(date)?.payload,
      "extracted",
    );
    const dayUseful =
      date === todayKey ? Math.max(snapshotUseful, useful) : snapshotUseful;
    return {
      date,
      label: labels[new Date(`${date}T12:00:00Z`).getUTCDay()],
      useful: dayUseful,
      status:
        date === todayKey ? status : dayUseful > 0 ? "success" : "pending",
    };
  });

  return {
    status,
    lastRunAt: completedAt?.toISOString() ?? null,
    nextRunAt: collector?.next_due_at
      ? new Date(collector.next_due_at).toISOString()
      : null,
    errorCode: errorAfterCompletion
      ? (collector?.latest_error_code ?? collector?.last_error_code ?? null)
      : collector?.runner_state === "error"
        ? (collector?.last_error_code ?? null)
        : null,
    errorMessage: errorAfterCompletion
      ? (collector?.latest_error_message ?? null)
      : null,
    today: {
      discovered: coverageValue(todayCoverage, "discovered"),
      useful,
      uploaded: coverageValue(todayCoverage, "uploaded"),
      unchanged: coverageValue(todayCoverage, "unchanged"),
      failed:
        coverageValue(todayCoverage, "failedRead") +
        coverageValue(todayCoverage, "failedExtract"),
    },
    week: {
      periodKey: input.period?.period_key ?? null,
      totalUseful: days.reduce((total, day) => total + day.useful, 0),
      days,
    },
  };
}

async function requireWidgetActor(request: FastifyRequest) {
  const actor = await requirePluginActor(request);
  if (actor.clientKind !== "widget")
    throw new ApiError(
      403,
      "WIDGET_CLIENT_REQUIRED",
      "这个接口只接受已绑定的桌面 Widget。",
    );
  return {
    ...actor,
    actorType: "desktop_widget" as const,
  } satisfies DomainActor;
}

export async function widgetRoutes(app: FastifyInstance) {
  app.get("/v1/widget/queue", async (request) => {
    const actor = await requireWidgetActor(request);
    const [scopeRows, workItemRows, periodRows, collectorRows, recoveryRows] =
      await Promise.all([
        sql<any[]>`
        select pse.id, pse.plugin_instance_id, pse.scope_key, pse.display_name,
          pse.status, pse.effective_from, pse.first_seen_at, pse.last_seen_at,
          pse.session_count, psp.version as policy_version, rp.period_key
        from project_scope_entries pse
        join project_scope_policies psp
          on psp.plugin_instance_id = pse.plugin_instance_id
          and psp.tenant_id = pse.tenant_id
        join plugin_instances pi on pi.id = pse.plugin_instance_id
          and pi.tenant_id = pse.tenant_id
        left join report_periods rp
          on rp.tenant_id = pse.tenant_id and rp.team_id = pse.team_id
          and rp.period_key = pse.first_seen_period_key
        where pse.tenant_id = ${actor.tenantId}
          and pse.team_id = ${actor.teamId}
          and pse.partner_id = ${actor.partnerId}
          and pi.status = 'active' and pi.client_kind = 'collector'
          and pse.plugin_instance_id = (
            select selected.id from plugin_instances selected
            where selected.tenant_id = ${actor.tenantId}
              and selected.team_id = ${actor.teamId}
              and selected.partner_id = ${actor.partnerId}
              and selected.status = 'active'
              and selected.client_kind = 'collector'
            order by selected.last_collection_completed_at desc nulls last,
              selected.updated_at desc
            limit 1
          )
        order by (pse.status = 'pending') desc, pse.first_seen_at asc,
          lower(pse.display_name)
        limit 500
      `,
        sql<any[]>`
        select wi.id, wi.review_id, wi.title, wi.status, wi.review_status,
          wi.payload, wi.created_at, wi.updated_at, r.version as review_version,
          r.state as review_state, rp.period_key, rp.starts_at, rp.ends_at,
          jsonb_array_length(coalesce(wi.fact_ids, '[]'::jsonb))::int as source_count,
          coalesce(p.name, wi.title) as project_name,
          exists (
            select 1 from agent_jobs aj
            where aj.tenant_id = wi.tenant_id
              and aj.partner_id = wi.partner_id
              and aj.type = 'AGGREGATE_WORK_ITEMS'
              and aj.input_payload->>'targetWorkItemId' = wi.id::text
              and aj.status in ('PENDING', 'LEASED', 'RETRY_WAIT')
          ) as busy
        from work_items wi
        join reviews r on r.id = wi.review_id and r.tenant_id = wi.tenant_id
        join report_periods rp on rp.id = wi.period_id and rp.tenant_id = wi.tenant_id
        left join projects p on p.id = wi.project_id and p.tenant_id = wi.tenant_id
        where wi.tenant_id = ${actor.tenantId}
          and wi.team_id = ${actor.teamId}
          and wi.partner_id = ${actor.partnerId}
          and rp.id = (
            select latest_r.period_id from reviews latest_r
            join report_periods latest_rp on latest_rp.id = latest_r.period_id
            where latest_r.tenant_id = ${actor.tenantId}
              and latest_r.team_id = ${actor.teamId}
              and latest_r.partner_id = ${actor.partnerId}
            order by latest_rp.starts_at desc, latest_r.created_at desc
            limit 1
          )
        order by lower(coalesce(p.name, wi.title)), wi.created_at
        limit 50
      `,
        sql<any[]>`
        select rp.id, rp.period_key, rp.starts_at, rp.ends_at, t.timezone
        from report_periods rp
        join teams t on t.id = rp.team_id and t.tenant_id = rp.tenant_id
        where rp.tenant_id = ${actor.tenantId} and rp.team_id = ${actor.teamId}
          and rp.starts_at <= now() and rp.ends_at >= now()
        order by rp.starts_at desc limit 1
      `,
        sql<any[]>`
        select pi.id, pi.runner_state, pi.next_due_at, pi.last_error_code,
          pi.last_collection_started_at, pi.last_collection_completed_at,
          pi.last_collection_session_count, pi.last_collection_fact_count,
          (
            select ple.event_code from plugin_log_events ple
            where ple.tenant_id = pi.tenant_id and ple.plugin_instance_id = pi.id
              and ple.level = 'error'
            order by ple.occurred_at desc limit 1
          ) as latest_error_code,
          (
            select ple.message from plugin_log_events ple
            where ple.tenant_id = pi.tenant_id and ple.plugin_instance_id = pi.id
              and ple.level = 'error'
            order by ple.occurred_at desc limit 1
          ) as latest_error_message,
          (
            select ple.occurred_at from plugin_log_events ple
            where ple.tenant_id = pi.tenant_id and ple.plugin_instance_id = pi.id
              and ple.level = 'error'
            order by ple.occurred_at desc limit 1
          ) as latest_error_at
        from plugin_instances pi
        where pi.tenant_id = ${actor.tenantId} and pi.team_id = ${actor.teamId}
          and pi.partner_id = ${actor.partnerId}
          and pi.status = 'active' and pi.client_kind = 'collector'
        order by pi.last_collection_completed_at desc nulls last, pi.updated_at desc
        limit 1
      `,
        sql<any[]>`
        select pda.id, pda.device_name, pda.plugin_version, pda.created_at,
          pda.expires_at, pda.plugin_instance_id
        from plugin_device_authorizations pda
        where pda.tenant_id = ${actor.tenantId}
          and pda.team_id = ${actor.teamId}
          and pda.partner_id = ${actor.partnerId}
          and pda.plugin_instance_id is not null
          and pda.status = 'pending' and pda.expires_at > now()
        order by pda.created_at desc
      `,
      ]);

    const period = periodRows[0];
    const snapshots = period
      ? await sql<any[]>`
          select payload, created_at from coverage_snapshots
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and partner_id = ${actor.partnerId} and period_id = ${period.id}
          order by created_at asc
        `
      : [];

    const workItemIds = workItemRows.map((row) => row.id);
    const versionRows =
      workItemIds.length > 0
        ? await sql<any[]>`
            select work_item_id, version, title, status, payload, instruction,
              source, created_at
            from work_item_versions
            where tenant_id = ${actor.tenantId}
              and work_item_id in ${sql(workItemIds)}
            order by work_item_id, version desc
          `
        : [];
    const versionsByWorkItem = new Map<string, any[]>();
    for (const version of versionRows) {
      const versions = versionsByWorkItem.get(version.work_item_id) ?? [];
      versions.push({
        version: version.version,
        title: version.title,
        status: version.status,
        payload: version.payload,
        instruction: version.instruction,
        source: version.source,
        createdAt: new Date(version.created_at).toISOString(),
      });
      versionsByWorkItem.set(version.work_item_id, versions);
    }

    const items = [
      ...scopeRows
        .filter((row) => row.status === "pending")
        .map((row) => ({
          id: `scope:${row.id}`,
          kind: "project_scope" as const,
          title: row.display_name,
          subtitle: "项目采集权限",
          detail: `${row.session_count} 个相关会话等待确认`,
          periodKey: row.period_key ?? null,
          busy: false,
          action: {
            pluginInstanceId: row.plugin_instance_id,
            scopeKey: row.scope_key,
            baseVersion: row.policy_version,
          },
        })),
      ...workItemRows
        .filter((row) => row.review_status === "pending")
        .map((row) => {
          const detail = row.payload?.overview ?? row.payload?.summary;
          return {
            id: `work-item:${row.id}`,
            kind: "work_item" as const,
            title: row.project_name,
            subtitle: row.title,
            detail: typeof detail === "string" ? detail : "项目卡片等待审核。",
            projectDescription:
              typeof row.payload?.projectDescription === "string"
                ? row.payload.projectDescription
                : null,
            overview:
              typeof row.payload?.overview === "string"
                ? row.payload.overview
                : null,
            dailyProgress: Array.isArray(row.payload?.dailyProgress)
              ? row.payload.dailyProgress
              : [],
            sourceCount: row.source_count,
            periodKey: row.period_key,
            busy: row.busy === true,
            action: {
              reviewId: row.review_id,
              workItemId: row.id,
              baseVersion: row.review_version,
            },
          };
        }),
    ];

    const permissions = {
      pluginInstanceId:
        scopeRows[0]?.plugin_instance_id ?? collectorRows[0]?.id ?? null,
      version: scopeRows[0]?.policy_version ?? 1,
      items: scopeRows.map((row) => ({
        scopeKey: row.scope_key,
        displayName: row.display_name,
        status: row.status,
        sessionCount: row.session_count,
        firstSeenAt: new Date(row.first_seen_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        effectiveFrom: row.effective_from
          ? new Date(row.effective_from).toISOString()
          : null,
        periodKey: row.period_key ?? null,
      })),
    };

    const workCards = workItemRows.map((row) => ({
      id: row.id,
      reviewId: row.review_id,
      projectName: row.project_name,
      title: row.title,
      status: row.status,
      reviewStatus: row.review_status,
      reviewState: row.review_state,
      reviewVersion: row.review_version,
      payload: row.payload,
      sourceCount: row.source_count,
      periodKey: row.period_key,
      periodStartsAt: new Date(row.starts_at).toISOString(),
      periodEndsAt: new Date(row.ends_at).toISOString(),
      busy: row.busy === true,
      versions: versionsByWorkItem.get(row.id) ?? [],
    }));

    return {
      generatedAt: new Date().toISOString(),
      totalCount: items.length,
      items,
      permissions,
      workCards,
      connectionRecoveries: recoveryRows.map((row) => ({
        id: row.id,
        deviceName: row.device_name,
        pluginVersion: row.plugin_version,
        pluginInstanceId: row.plugin_instance_id,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      })),
      dashboard: buildWidgetDashboard({
        now: new Date(),
        timezone: period?.timezone ?? "Asia/Shanghai",
        period,
        collector: collectorRows[0],
        snapshots,
      }),
    };
  });

  app.post("/v1/widget/actions", async (request) => {
    const actor = await requireWidgetActor(request);
    const input = widgetActionSchema.parse(request.body);
    let result: unknown;
    let targetType: string;
    let targetId: string;

    if (input.kind === "project_scope") {
      result = await decideProjectScopes(actor, input.pluginInstanceId, {
        baseVersion: input.baseVersion,
        decisions: [{ scopeKey: input.scopeKey, decision: input.decision }],
      });
      targetType = "plugin_instance";
      targetId = input.pluginInstanceId;
    } else if (input.kind === "project_scope_batch") {
      result = await decideProjectScopes(actor, input.pluginInstanceId, {
        baseVersion: input.baseVersion,
        decisions: input.decisions,
      });
      targetType = "plugin_instance";
      targetId = input.pluginInstanceId;
    } else if (input.kind === "work_item_decision") {
      result = await decideReviewWorkItem(actor, {
        reviewId: input.reviewId,
        workItemId: input.workItemId,
        baseVersion: input.baseVersion,
        decision: input.decision,
      });
      targetType = "work_item";
      targetId = input.workItemId;
    } else if (input.kind === "work_item_regenerate") {
      result = await regenerateReviewWorkItem(actor, {
        reviewId: input.reviewId,
        workItemId: input.workItemId,
        baseVersion: input.baseVersion,
        instruction: reasonInstructions[input.reason],
      });
      targetType = "work_item";
      targetId = input.workItemId;
    } else if (input.kind === "work_item_regenerate_custom") {
      result = await regenerateReviewWorkItem(actor, {
        reviewId: input.reviewId,
        workItemId: input.workItemId,
        baseVersion: input.baseVersion,
        instruction: input.instruction,
      });
      targetType = "work_item";
      targetId = input.workItemId;
    } else if (input.kind === "connection_recovery_approve") {
      const approved = await sql<{ id: string }[]>`
        update plugin_device_authorizations set status = 'approved',
          approved_at = now()
        where id = ${input.authorizationId}
          and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and partner_id = ${actor.partnerId}
          and plugin_instance_id is not null
          and status = 'pending' and expires_at > now()
        returning id
      `;
      if (!approved[0])
        throw new ApiError(
          404,
          "RECOVERY_REQUEST_NOT_FOUND",
          "连接恢复申请不存在或已经处理。",
        );
      result = { approved: true };
      targetType = "device_authorization";
      targetId = input.authorizationId;
    } else {
      throw new ApiError(
        400,
        "WIDGET_ACTION_UNSUPPORTED",
        "不支持的审核操作。",
      );
    }

    await audit(
      request,
      actor,
      `widget.${input.kind}`,
      targetType,
      targetId,
      "decision" in input
        ? { decision: input.decision }
        : "reason" in input
          ? { reason: input.reason }
          : "instruction" in input
            ? { instruction: input.instruction }
            : {},
    );
    return { ok: true, result };
  });

  app.post("/v1/widget/unbind", async (request) => {
    const actor = await requireWidgetActor(request);
    const input = widgetUnbindSchema.parse(request.body);
    const codeHash = sha256(input.bindingCode.trim().toUpperCase());

    const collector = await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select pi.id
        from plugin_binding_codes pbc
        join plugin_instances pi on pi.id = pbc.plugin_instance_id
          and pi.tenant_id = pbc.tenant_id
        where pbc.code_hash = ${codeHash}
          and pbc.status = 'claimed'
          and pi.tenant_id = ${actor.tenantId}
          and pi.team_id = ${actor.teamId}
          and pi.partner_id = ${actor.partnerId}
          and pi.client_kind = 'collector'
          and pi.status = 'active'
        for update of pbc, pi
      `;
      const matched = rows[0];
      if (!matched) return null;

      await tx`
        update plugin_instances set status = 'revoked', access_expires_at = now(),
          updated_at = now()
        where tenant_id = ${actor.tenantId}
          and id in (${matched.id}, ${actor.pluginInstanceId})
          and status = 'active'
      `;
      await tx`
        update plugin_binding_codes set status = 'revoked', updated_at = now()
        where tenant_id = ${actor.tenantId}
          and plugin_instance_id in (${matched.id}, ${actor.pluginInstanceId})
          and status <> 'revoked'
      `;
      return matched;
    });

    if (!collector)
      throw new ApiError(
        400,
        "BINDING_CODE_INVALID",
        "绑定码不正确，请输入绑定插件时使用的绑定码。",
      );

    await audit(
      request,
      actor,
      "widget.plugin_unbound",
      "plugin_instance",
      collector.id,
      { widgetPluginInstanceId: actor.pluginInstanceId },
    );
    return { ok: true };
  });
}
