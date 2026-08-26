import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pluginLogBatchSchema } from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  requirePluginActor,
  requireWebActor,
} from "../common.js";
import {
  PLUGIN_SCHEDULE,
  projectPluginMonitoringStatus,
  projectSystemComponents,
  type MonitoringSeverity,
} from "../monitoring.js";
import {
  groupPluginExecutions,
  type PluginExecutionEvent,
} from "../plugin-log-diagnostics.js";
import { runSystemProbe, systemProbeKeys } from "../system-probes.js";

export function isValidPluginLogDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const adminLogQuerySchema = z
  .object({
    pluginInstanceId: z.string().uuid(),
    executionId: z.string().trim().min(1).max(120).optional(),
    runId: z.string().uuid().optional(),
    level: z.enum(["debug", "info", "warning", "error"]).optional(),
    date: z
      .string()
      .refine(isValidPluginLogDate, "日期必须是有效的 YYYY-MM-DD。")
      .optional(),
    limit: z.coerce.number().int().min(1).max(5_000).default(2_000),
  })
  .strict();

const pluginLogAnalysisSchema = z
  .object({
    pluginInstanceId: z.string().uuid(),
    executionId: z.string().trim().min(1).max(120),
  })
  .strict();

const systemProbeParamsSchema = z
  .object({ component: z.enum(systemProbeKeys) })
  .strict();

const secretPatterns: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi, "Bearer <REDACTED>"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<REDACTED_API_KEY>"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "<REDACTED_PRIVATE_KEY>",
  ],
  [
    /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s,;"']{4,}/gi,
    "$1$2<REDACTED>",
  ],
  [/\/Users\/[^/\s]+/g, "<USER_HOME>"],
  [/[A-Za-z]:\\Users\\[^\\\s]+/g, "<USER_HOME>"],
];

export function sanitizePluginLogText(value: string) {
  return secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

export function sanitizePluginLogDetails(value: unknown): unknown {
  if (typeof value === "string") return sanitizePluginLogText(value);
  if (Array.isArray(value)) return value.map(sanitizePluginLogDetails);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|secret|password|authorization|credential/i.test(key)
          ? "<REDACTED>"
          : sanitizePluginLogDetails(item),
      ]),
    );
  return value;
}

export async function observabilityRoutes(app: FastifyInstance) {
  app.post("/v1/plugin-instances/me/log-events", async (request) => {
    const actor = await requirePluginActor(request);
    const input = pluginLogBatchSchema.parse(request.body) as {
      events: Array<{
        eventId: string;
        invocationId?: string;
        runId?: string;
        sequence?: number;
        command?: string;
        eventType?: string;
        level: string;
        stage: string;
        eventCode: string;
        message: string;
        stack?: string;
        occurredAt: string;
        retryable: boolean;
        attempt?: number;
        durationMs?: number;
        requestId?: string;
        details?: Record<string, unknown>;
      }>;
    };
    let accepted = 0;
    await sql.begin(async (tx) => {
      for (const event of input.events) {
        const rows = await tx<{ id: string }[]>`
          insert into plugin_log_events (
            id, tenant_id, team_id, partner_id, plugin_instance_id,
            invocation_id, run_id, sequence, command, event_type,
            level, stage, event_code, message, stack, retryable, attempt,
            duration_ms, request_id, details, occurred_at
          ) values (
            ${event.eventId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
            ${actor.pluginInstanceId}, ${event.invocationId ?? null},
            ${event.runId ?? null}, ${event.sequence ?? null},
            ${event.command ?? null}, ${event.eventType ?? null}, ${event.level},
            ${event.stage}, ${event.eventCode}, ${sanitizePluginLogText(event.message)},
            ${event.stack ? sanitizePluginLogText(event.stack) : null},
            ${event.retryable}, ${event.attempt ?? null}, ${event.durationMs ?? null},
            ${event.requestId ?? request.id},
            ${JSON.stringify(sanitizePluginLogDetails(event.details ?? {}))}::jsonb,
            ${event.occurredAt}
          ) on conflict (id) do nothing
          returning id
        `;
        accepted += rows.length;
      }
    });
    const issueInvocations = new Map<string, (typeof input.events)[number]>();
    for (const event of input.events)
      if (
        event.invocationId &&
        (event.level === "error" || event.level === "warning")
      )
        issueInvocations.set(event.invocationId, event);
    await Promise.all(
      [...issueInvocations.entries()].map(
        ([invocationId, event]) =>
          sql`
          insert into agent_jobs (
            id, tenant_id, team_id, partner_id, plugin_instance_id,
            type, status, idempotency_key, input_payload, max_attempts
          ) values (
            ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
            ${actor.pluginInstanceId}, 'ANALYZE_PLUGIN_LOGS', 'PENDING',
            ${`plugin-log-analysis:${actor.pluginInstanceId}:${invocationId}`},
            ${JSON.stringify({
              executionId: `invocation:${invocationId}`,
              invocationId,
              runId: event.runId ?? null,
              command: event.command ?? null,
            })}::jsonb,
            2
          ) on conflict (tenant_id, idempotency_key) do nothing
        `,
      ),
    );
    await audit(
      request,
      actor,
      "plugin.logs.received",
      "plugin_instance",
      actor.pluginInstanceId,
      { accepted, submitted: input.events.length },
    );
    return { ok: true, accepted, submitted: input.events.length };
  });

  app.get("/v1/admin/plugin-logs", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = adminLogQuerySchema.parse(request.query);
    const plugins = await sql<
      Array<{ id: string; partner_id: string; timezone: string }>
    >`
      select pi.id, pi.partner_id, t.timezone
      from plugin_instances pi
      join teams t on t.id = pi.team_id and t.tenant_id = pi.tenant_id
      where pi.id = ${query.pluginInstanceId} and pi.tenant_id = ${actor.tenantId}
        and pi.team_id = ${actor.teamId}
      limit 1
    `;
    const plugin = plugins[0];
    if (!plugin)
      throw new ApiError(404, "PLUGIN_NOT_FOUND", "Plugin Instance 不存在。");

    const windows = query.date
      ? await sql<Array<{ window_start: Date; window_end: Date }>>`
          select
            (${query.date}::date::timestamp at time zone ${plugin.timezone}) as window_start,
            ((${query.date}::date + 1)::timestamp at time zone ${plugin.timezone}) as window_end
        `
      : await sql<Array<{ window_start: Date; window_end: Date }>>`
          select now() - interval '24 hours' as window_start, now() as window_end
        `;
    const logWindow = windows[0]!;
    const recentEvents = await sql<any[]>`
      select id, invocation_id, run_id, sequence, command, event_type,
        level, stage, event_code, message, stack, retryable,
        attempt, duration_ms, request_id, details, occurred_at, created_at
      from plugin_log_events
      where tenant_id = ${actor.tenantId}
        and plugin_instance_id = ${query.pluginInstanceId}
        and occurred_at >= ${logWindow.window_start}
        and occurred_at < ${logWindow.window_end}
      order by occurred_at desc, created_at desc
      limit ${query.limit}
    `;
    const grouped = groupPluginExecutions(
      recentEvents as PluginExecutionEvent[],
    );
    const selected = query.executionId
      ? grouped.find((execution) => execution.executionId === query.executionId)
      : query.runId
        ? grouped.find((execution) => execution.runId === query.runId)
        : grouped[0];
    const events = (selected?.events ?? []).filter(
      (event) => !query.level || event.level === query.level,
    );
    const executions = grouped.map(
      ({ events: _events, ...execution }) => execution,
    );
    const analysisRows = selected
      ? await sql<any[]>`
          select id, status, output_payload, error_code, error_message,
            created_at, updated_at, completed_at
          from agent_jobs
          where tenant_id = ${actor.tenantId}
            and plugin_instance_id = ${query.pluginInstanceId}
            and type = 'ANALYZE_PLUGIN_LOGS'
            and input_payload ->> 'executionId' = ${selected.executionId}
          order by created_at desc limit 1
        `
      : [];
    return {
      pluginInstanceId: plugin.id,
      window: {
        mode: query.date ? "day" : "recent",
        date: query.date ?? null,
        timezone: plugin.timezone,
        startedAt: logWindow.window_start,
        endedAt: logWindow.window_end,
      },
      selectedExecutionId: selected?.executionId ?? null,
      events,
      executions,
      modelAnalysis: analysisRows[0] ?? null,
      // Kept for older admin clients while they upgrade to execution-level grouping.
      runs: executions
        .filter((execution) => execution.runId)
        .map((execution) => ({
          run_id: execution.runId,
          started_at: execution.startedAt,
          last_event_at: execution.lastEventAt,
          event_count: execution.eventCount,
          error_count: execution.errorCount,
          warning_count: execution.warningCount,
        })),
      generationJobs: [],
    };
  });

  app.post("/v1/admin/plugin-logs/analyze", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = pluginLogAnalysisSchema.parse(request.body);
    const pluginRows = await sql<Array<{ id: string; partner_id: string }>>`
      select id, partner_id from plugin_instances
      where id = ${input.pluginInstanceId} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId}
      limit 1
    `;
    const plugin = pluginRows[0];
    if (!plugin)
      throw new ApiError(404, "PLUGIN_NOT_FOUND", "Plugin Instance 不存在。");
    const invocationId = input.executionId.startsWith("invocation:")
      ? input.executionId.slice("invocation:".length)
      : "";
    if (!z.string().uuid().safeParse(invocationId).success)
      throw new ApiError(
        409,
        "PLUGIN_EXECUTION_NOT_ANALYZABLE",
        "只有提供命令执行 ID 的单次命令日志才能进行模型分析。",
      );
    const recentEvents = await sql<any[]>`
      select id, invocation_id, run_id, sequence, command, event_type,
        level, stage, event_code, message, stack, retryable,
        attempt, duration_ms, request_id, details, occurred_at, created_at
      from plugin_log_events
      where tenant_id = ${actor.tenantId}
        and plugin_instance_id = ${input.pluginInstanceId}
        and invocation_id = ${invocationId}
      order by occurred_at desc, created_at desc limit 2000
    `;
    const execution = groupPluginExecutions(
      recentEvents as PluginExecutionEvent[],
    ).find((item) => item.executionId === input.executionId);
    if (!execution)
      throw new ApiError(
        404,
        "PLUGIN_EXECUTION_NOT_FOUND",
        "找不到这次插件运行。",
      );
    if (execution.grouping !== "invocation")
      throw new ApiError(
        409,
        "PLUGIN_EXECUTION_NOT_ANALYZABLE",
        "只有提供命令执行 ID 的单次命令日志才能进行模型分析。",
      );
    const idempotencyKey = `plugin-log-analysis:${input.pluginInstanceId}:${execution.executionId}:${execution.lastEventAt}`;
    const rows = await sql<Array<{ id: string; status: string }>>`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, plugin_instance_id,
        type, status, idempotency_key, input_payload, max_attempts
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${plugin.partner_id},
        ${input.pluginInstanceId}, 'ANALYZE_PLUGIN_LOGS', 'PENDING',
        ${idempotencyKey},
        ${JSON.stringify({
          executionId: execution.executionId,
          invocationId: execution.invocationId,
          runId: execution.runId,
          command: execution.command,
        })}::jsonb,
        2
      ) on conflict (tenant_id, idempotency_key) do update
        set status = 'PENDING', attempt_count = 0, output_payload = null,
          error_code = null, error_message = null, completed_at = null,
          lease_until = null, updated_at = now()
      returning id, status
    `;
    await audit(
      request,
      actor,
      "plugin.logs.analysis_requested",
      "plugin_instance",
      input.pluginInstanceId,
      { executionId: input.executionId, jobId: rows[0]?.id },
    );
    return { ok: true, job: rows[0] };
  });

  app.get("/v1/admin/plugin-monitoring", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const rows = await sql<any[]>`
      select
        pi.id, pi.partner_id, pi.device_name, pi.version, pi.created_at,
        pi.last_heartbeat_at, pi.last_sync_at, pi.runner_state,
        pi.pending_local_jobs, pi.retry_count, pi.last_error_code,
        pi.last_collection_started_at, pi.last_collection_completed_at,
        p.display_name as partner_name,
        latest_event.occurred_at as latest_event_at,
        latest_event.stage as latest_stage,
        latest_event.event_code as latest_event_code,
        latest_event.message as latest_message,
        latest_state.event_code as latest_state_code,
        latest_error.occurred_at as latest_error_at
      from plugin_instances pi
      join partners p on p.id = pi.partner_id and p.tenant_id = pi.tenant_id
      left join lateral (
        select occurred_at, stage, event_code, message
        from plugin_log_events ple
        where ple.tenant_id = pi.tenant_id and ple.plugin_instance_id = pi.id
        order by occurred_at desc, created_at desc
        limit 1
      ) latest_event on true
      left join lateral (
        select event_code
        from plugin_log_events ple
        where ple.tenant_id = pi.tenant_id and ple.plugin_instance_id = pi.id
          and ple.event_code not in ('command.started', 'command.completed')
        order by occurred_at desc, created_at desc
        limit 1
      ) latest_state on true
      left join lateral (
        select occurred_at
        from plugin_log_events ple
        where ple.tenant_id = pi.tenant_id and ple.plugin_instance_id = pi.id
          and ple.level = 'error'
        order by occurred_at desc, created_at desc
        limit 1
      ) latest_error on true
      where pi.tenant_id = ${actor.tenantId} and pi.team_id = ${actor.teamId}
        and pi.status = 'active'
      order by p.display_name, pi.created_at desc
    `;
    const now = new Date();
    const plugins = rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      deviceName: row.device_name,
      version: row.version,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastSyncAt: row.last_sync_at,
      lastCollectionStartedAt: row.last_collection_started_at,
      lastCollectionCompletedAt: row.last_collection_completed_at,
      latestEventAt: row.latest_event_at,
      latestStage: row.latest_stage,
      latestEventCode: row.latest_event_code,
      latestMessage: row.latest_message,
      pendingLocalJobs: row.pending_local_jobs,
      runnerState: row.runner_state,
      status: projectPluginMonitoringStatus(
        {
          createdAt: row.created_at,
          lastCollectionStartedAt: row.last_collection_started_at,
          lastCollectionCompletedAt: row.last_collection_completed_at,
          lastHeartbeatAt: row.last_heartbeat_at,
          latestEventAt: row.latest_event_at,
          latestEventCode: row.latest_state_code ?? row.latest_event_code,
          latestErrorAt: row.latest_error_at,
          lastErrorCode: row.last_error_code,
          runnerState: row.runner_state,
          retryCount: row.retry_count,
          pendingLocalJobs: row.pending_local_jobs,
        },
        now,
      ),
    }));
    const summary = {
      total: plugins.length,
      normal: plugins.filter((plugin) => plugin.status.severity === "normal")
        .length,
      warning: plugins.filter((plugin) => plugin.status.severity === "warning")
        .length,
      critical: plugins.filter(
        (plugin) => plugin.status.severity === "critical",
      ).length,
      unknown: plugins.filter((plugin) => plugin.status.severity === "unknown")
        .length,
    };
    return {
      checkedAt: now.toISOString(),
      schedule: {
        timezone: PLUGIN_SCHEDULE.timezone,
        time: `${String(PLUGIN_SCHEDULE.hour).padStart(2, "0")}:00`,
        graceMinutes: PLUGIN_SCHEDULE.graceMinutes,
        staleRunMinutes: PLUGIN_SCHEDULE.staleRunMinutes,
      },
      summary,
      plugins,
    };
  });

  app.get("/v1/admin/system-monitoring", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const now = new Date();
    const [
      jobRows,
      feishuRows,
      reportRows,
      problemJobs,
      problemDeliveries,
      problemReports,
    ] = await Promise.all([
      sql<any[]>`
          select
            count(*) filter (where status = 'PENDING')::int as pending,
            count(*) filter (where status = 'LEASED')::int as leased,
            count(*) filter (where status = 'RETRY_WAIT')::int as retry_wait,
            count(*) filter (where status = 'LEASED' and lease_until < now())::int as expired_leases,
            min(created_at) filter (where status in ('PENDING', 'LEASED', 'RETRY_WAIT')) as oldest_active_at,
            count(*) filter (where type in ('AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT') and status = 'FAILED')::int as generation_failed,
            count(*) filter (where type in ('AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT') and status = 'RETRY_WAIT')::int as generation_retry_wait,
            count(*) filter (where type in ('AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT') and status = 'COMPLETED' and completed_at >= now() - interval '24 hours')::int as generation_completed_24h
          from agent_jobs
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and type not like 'SYSTEM_HEALTH_%'
            and type <> 'ANALYZE_PLUGIN_LOGS'
        `,
      sql<any[]>`
          select
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'retry_wait')::int as retry_wait,
            count(*) filter (where status = 'deferred')::int as deferred,
            count(*) filter (where status = 'sending' and last_attempt_at < now() - interval '2 minutes')::int as stuck_sending,
            count(*) filter (where status = 'pending' and created_at < now() - interval '5 minutes')::int as stale_pending,
            count(*) filter (where status = 'sent' and sent_at >= now() - interval '24 hours')::int as sent_24h
          from feishu_deliveries
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        `,
      sql<any[]>`
          select
            count(*) filter (where status = 'AGGREGATING')::int as aggregating,
            count(*) filter (where status = 'AGGREGATING' and updated_at < now() - interval '1 hour')::int as stale_aggregating,
            count(*) filter (where status = 'TEAM_DRAFT')::int as drafts,
            count(*) filter (where status = 'LOCKED' and locked_at >= now() - interval '24 hours')::int as locked_24h
          from team_reports
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        `,
      sql<any[]>`
          select aj.id, aj.type, aj.status, aj.error_code, aj.error_message,
            aj.updated_at, p.display_name as partner_name
          from agent_jobs aj
          left join partners p on p.id = aj.partner_id and p.tenant_id = aj.tenant_id
          where aj.tenant_id = ${actor.tenantId} and aj.team_id = ${actor.teamId}
            and aj.type not like 'SYSTEM_HEALTH_%'
            and aj.type <> 'ANALYZE_PLUGIN_LOGS'
            and (
              aj.status in ('FAILED', 'RETRY_WAIT')
              or (aj.status = 'LEASED' and aj.lease_until < now())
              or (aj.status = 'PENDING' and aj.created_at < now() - interval '1 hour')
            )
          order by aj.updated_at desc limit 50
        `,
      sql<any[]>`
          select fd.id, fd.kind, fd.status, fd.last_error_code,
            fd.last_error_message, fd.updated_at, p.display_name as partner_name
          from feishu_deliveries fd
          join partners p on p.id = fd.partner_id and p.tenant_id = fd.tenant_id
          where fd.tenant_id = ${actor.tenantId} and fd.team_id = ${actor.teamId}
            and (
              fd.status in ('failed', 'retry_wait', 'deferred')
              or (fd.status = 'sending' and fd.last_attempt_at < now() - interval '2 minutes')
              or (fd.status = 'pending' and fd.created_at < now() - interval '5 minutes')
            )
          order by fd.updated_at desc limit 50
        `,
      sql<any[]>`
          select id, status, updated_at
          from team_reports
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and status = 'AGGREGATING' and updated_at < now() - interval '1 hour'
          order by updated_at desc limit 20
        `,
    ]);
    const jobs = jobRows[0] ?? {};
    const feishu = feishuRows[0] ?? {};
    const reports = reportRows[0] ?? {};
    const components = projectSystemComponents(
      {
        queue: {
          pending: jobs.pending ?? 0,
          leased: jobs.leased ?? 0,
          retryWait: jobs.retry_wait ?? 0,
          expiredLeases: jobs.expired_leases ?? 0,
          oldestActiveAt: jobs.oldest_active_at ?? null,
        },
        generation: {
          failed: jobs.generation_failed ?? 0,
          retryWait: jobs.generation_retry_wait ?? 0,
          completed24h: jobs.generation_completed_24h ?? 0,
        },
        feishu: {
          failed: feishu.failed ?? 0,
          retryWait: feishu.retry_wait ?? 0,
          deferred: feishu.deferred ?? 0,
          stuckSending: feishu.stuck_sending ?? 0,
          stalePending: feishu.stale_pending ?? 0,
          sent24h: feishu.sent_24h ?? 0,
        },
        reports: {
          aggregating: reports.aggregating ?? 0,
          staleAggregating: reports.stale_aggregating ?? 0,
          drafts: reports.drafts ?? 0,
          locked24h: reports.locked_24h ?? 0,
        },
      },
      now,
    );
    const incidents = [
      ...problemJobs.map((row) => ({
        id: `job:${row.id}`,
        sourceId: row.id,
        source: "generation" as const,
        severity: (row.status === "FAILED" || row.status === "LEASED"
          ? "critical"
          : "warning") as MonitoringSeverity,
        title:
          row.status === "LEASED"
            ? "后台任务执行超时"
            : row.status === "FAILED"
              ? "内容生成任务失败"
              : "内容生成等待重试",
        message:
          row.error_message?.trim() ||
          (row.status === "LEASED"
            ? "任务租约已经过期，Worker 没有按时完成处理。"
            : "任务没有返回更详细的错误信息。"),
        errorCode: row.error_code,
        partnerName: row.partner_name,
        occurredAt: row.updated_at,
        action: "前往异常任务查看详情并决定是否重试。",
        href: "/admin/jobs",
      })),
      ...problemDeliveries.map((row) => ({
        id: `feishu:${row.id}`,
        sourceId: row.id,
        source: "feishu" as const,
        severity: (row.status === "failed" || row.status === "sending"
          ? "critical"
          : "warning") as MonitoringSeverity,
        title:
          row.status === "sending"
            ? "飞书消息发送超时"
            : row.status === "retry_wait"
              ? "飞书消息等待重试"
              : "飞书消息未送达",
        message: row.last_error_message?.trim() || "消息暂时没有成功送达用户。",
        errorCode: row.last_error_code,
        partnerName: row.partner_name,
        occurredAt: row.updated_at,
        action: "检查飞书连接和接收人绑定状态。",
        href: null,
      })),
      ...problemReports.map((row) => ({
        id: `report:${row.id}`,
        sourceId: row.id,
        source: "reports" as const,
        severity: "critical" as const,
        title: "报告生成时间过长",
        message: "报告进入生成阶段后超过一小时仍未完成。",
        errorCode: null,
        partnerName: null,
        occurredAt: row.updated_at,
        action: "检查关联的内容生成任务，并确认 Worker 是否正常运行。",
        href: "/admin/jobs",
      })),
    ]
      .sort(
        (left, right) =>
          new Date(right.occurredAt).getTime() -
          new Date(left.occurredAt).getTime(),
      )
      .slice(0, 100);
    const critical = components.filter(
      (component) => component.severity === "critical",
    ).length;
    const warning = components.filter(
      (component) => component.severity === "warning",
    ).length;
    return {
      checkedAt: now.toISOString(),
      overallSeverity:
        critical > 0 ? "critical" : warning > 0 ? "warning" : "normal",
      summary: {
        componentCount: components.length,
        normal: components.filter(
          (component) => component.severity === "normal",
        ).length,
        warning,
        critical,
        openIncidents: incidents.length,
      },
      components,
      incidents,
    };
  });

  app.post("/v1/admin/system-monitoring/:component/test", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { component } = systemProbeParamsSchema.parse(request.params);
    const result = await runSystemProbe(component, {
      tenantId: actor.tenantId,
      teamId: actor.teamId,
    });
    await audit(
      request,
      actor,
      "system_component.tested",
      "system_component",
      component,
      {
        status: result.status,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
      },
    );
    return result;
  });
}
