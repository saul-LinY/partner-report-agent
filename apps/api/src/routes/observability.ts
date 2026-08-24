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

const adminLogQuerySchema = z
  .object({
    pluginInstanceId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    level: z.enum(["debug", "info", "warning", "error"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
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
        runId?: string;
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
            id, tenant_id, team_id, partner_id, plugin_instance_id, run_id,
            level, stage, event_code, message, stack, retryable, attempt,
            duration_ms, request_id, details, occurred_at
          ) values (
            ${event.eventId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
            ${actor.pluginInstanceId}, ${event.runId ?? null}, ${event.level},
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
    const plugins = await sql<Array<{ id: string; partner_id: string }>>`
      select id, partner_id from plugin_instances
      where id = ${query.pluginInstanceId} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId}
      limit 1
    `;
    const plugin = plugins[0];
    if (!plugin)
      throw new ApiError(404, "PLUGIN_NOT_FOUND", "Plugin Instance 不存在。");

    const events = await sql<any[]>`
      select id, run_id, level, stage, event_code, message, stack, retryable,
        attempt, duration_ms, request_id, details, occurred_at, created_at
      from plugin_log_events
      where tenant_id = ${actor.tenantId}
        and plugin_instance_id = ${query.pluginInstanceId}
        and (${query.runId ?? null}::uuid is null or run_id = ${query.runId ?? null})
        and (${query.level ?? null}::text is null or level = ${query.level ?? null})
      order by occurred_at desc, created_at desc
      limit ${query.limit}
    `;
    const generationJobs = await sql<any[]>`
      select aj.id, aj.type, aj.status, aj.attempt_count, aj.max_attempts,
        aj.error_code, aj.error_message, aj.created_at, aj.updated_at,
        aj.completed_at
      from agent_jobs aj
      where aj.tenant_id = ${actor.tenantId} and aj.team_id = ${actor.teamId}
        and aj.partner_id = ${plugin.partner_id}
      order by aj.updated_at desc limit 100
    `;
    const runs = await sql<any[]>`
      select run_id,
        min(occurred_at) as started_at,
        max(occurred_at) as last_event_at,
        count(*)::int as event_count,
        count(*) filter (where level = 'error')::int as error_count,
        count(*) filter (where level = 'warning')::int as warning_count
      from plugin_log_events
      where tenant_id = ${actor.tenantId}
        and plugin_instance_id = ${query.pluginInstanceId}
        and run_id is not null
      group by run_id
      order by max(occurred_at) desc limit 50
    `;
    return { pluginInstanceId: plugin.id, events, runs, generationJobs };
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
            count(*) filter (where type in ('AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT') and status = 'SUCCEEDED' and completed_at >= now() - interval '24 hours')::int as generation_completed_24h
          from agent_jobs
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
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
}
