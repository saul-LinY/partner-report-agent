import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, requireWebActor } from "../common.js";
import {
  projectSystemComponents,
  type MonitoringSeverity,
} from "../monitoring.js";
import { logDateSchema, sanitizePluginLogText } from "../sanitize.js";
import { runSystemProbe, systemProbeKeys } from "../system-probes.js";
import {
  projectSystemLogExecutions,
  type SystemLogSource,
} from "../system-logs.js";

const systemLogQuerySchema = z
  .object({
    executionId: z.string().trim().min(1).max(120).optional(),
    date: logDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(2_000).default(500),
  })
  .strict();

const systemLogAnalysisSchema = z
  .object({ executionId: z.string().trim().min(1).max(120) })
  .strict();

const systemExecutionIdSchema = z
  .string()
  .regex(/^(notification|job|outbox|report):[0-9a-f-]{36}$/i);

const systemProbeParamsSchema = z
  .object({ component: z.enum(systemProbeKeys) })
  .strict();

export async function observabilityRoutes(app: FastifyInstance) {
  app.get("/v1/admin/system-logs", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = systemLogQuerySchema.parse(request.query);
    const teams = await sql<Array<{ timezone: string }>>`
      select timezone from teams
      where id = ${actor.teamId} and tenant_id = ${actor.tenantId}
      limit 1
    `;
    const timezone = teams[0]?.timezone ?? "Asia/Shanghai";
    const windows = query.date
      ? await sql<Array<{ window_start: Date; window_end: Date }>>`
          select
            (${query.date}::date::timestamp at time zone ${timezone}) as window_start,
            ((${query.date}::date + 1)::timestamp at time zone ${timezone}) as window_end
        `
      : await sql<Array<{ window_start: Date; window_end: Date }>>`
          select now() - interval '24 hours' as window_start, now() as window_end
        `;
    const window = windows[0]!;
    const [jobs, notifications, outbox, reports, workerRows] =
      await Promise.all([
        sql<any[]>`
        select aj.*, p.display_name as partner_name, link.upload_id, link.period_key
        from agent_jobs aj
        left join partners p on p.id = aj.partner_id and p.tenant_id = aj.tenant_id
        left join lateral (
          select cuj.upload_id, u.period_key
          from collector_upload_jobs cuj
          join collector_uploads u on u.id = cuj.upload_id
          where cuj.job_id = aj.id
          order by u.created_at desc limit 1
        ) link on true
        where aj.tenant_id = ${actor.tenantId} and aj.team_id = ${actor.teamId}
          and aj.type not like 'SYSTEM_HEALTH_%'
          and aj.type not in ('ANALYZE_SYSTEM_LOGS', 'ANALYZE_INSPECTION_FINDING')
          and (
            (aj.created_at >= ${window.window_start} and aj.created_at < ${window.window_end})
            or (aj.updated_at >= ${window.window_start} and aj.updated_at < ${window.window_end})
            or (aj.completed_at >= ${window.window_start} and aj.completed_at < ${window.window_end})
          )
        order by aj.updated_at desc limit ${query.limit}
      `,
        sql<any[]>`
        select n.*,p.display_name as partner_name from app_notifications n
        join partners p on p.id=n.partner_id and p.tenant_id=n.tenant_id
        where n.tenant_id=${actor.tenantId} and n.team_id=${actor.teamId}
          and ((n.created_at >= ${window.window_start} and n.created_at < ${window.window_end})
            or (n.delivered_at >= ${window.window_start} and n.delivered_at < ${window.window_end}))
        order by n.created_at desc limit ${query.limit}
      `,
        sql<any[]>`
        select * from outbox_events
        where tenant_id = ${actor.tenantId}
          and (
            payload->>'teamId' = ${actor.teamId}
            or (aggregate_type = 'plugin_instance' and exists (
              select 1 from plugin_instances pi
              where pi.id::text = outbox_events.aggregate_id
                and pi.tenant_id = ${actor.tenantId} and pi.team_id = ${actor.teamId}
            ))
            or (aggregate_type = 'review' and exists (
              select 1 from reviews r
              where r.id::text = outbox_events.aggregate_id
                and r.tenant_id = ${actor.tenantId} and r.team_id = ${actor.teamId}
            ))
            or (aggregate_type in ('report', 'team_report') and exists (
              select 1 from team_reports tr
              where tr.id::text = outbox_events.aggregate_id
                and tr.tenant_id = ${actor.tenantId} and tr.team_id = ${actor.teamId}
            ))
          )
          and (
            (created_at >= ${window.window_start} and created_at < ${window.window_end})
            or (published_at >= ${window.window_start} and published_at < ${window.window_end})
          )
        order by created_at desc limit ${query.limit}
      `,
        sql<any[]>`
        select tr.*, rp.period_key
        from team_reports tr
        join report_periods rp on rp.id = tr.period_id
          and rp.tenant_id = tr.tenant_id and rp.team_id = tr.team_id
        where tr.tenant_id = ${actor.tenantId} and tr.team_id = ${actor.teamId}
          and (
            (tr.created_at >= ${window.window_start} and tr.created_at < ${window.window_end})
            or (tr.updated_at >= ${window.window_start} and tr.updated_at < ${window.window_end})
            or (tr.generated_at >= ${window.window_start} and tr.generated_at < ${window.window_end})
            or (tr.locked_at >= ${window.window_start} and tr.locked_at < ${window.window_end})
          )
        order by tr.updated_at desc limit ${query.limit}
      `,
        sql<any[]>`
        select heartbeat_at, last_tick_at, status, error_code, capabilities
        from service_heartbeats where name = 'worker'
      `,
      ]);
    const projected = projectSystemLogExecutions({
      jobs,
      notifications,
      outbox,
      reports,
    });
    const selected = query.executionId
      ? projected.find((item) => item.executionId === query.executionId)
      : projected[0];
    const analysis = selected
      ? await sql<any[]>`
          select id, status, output_payload, error_code, error_message,
            created_at, updated_at, completed_at
          from agent_jobs
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and type = 'ANALYZE_SYSTEM_LOGS'
            and input_payload->>'executionId' = ${selected.executionId}
          order by created_at desc limit 1
        `
      : [];
    const worker = workerRows[0];
    return {
      window: {
        mode: query.date ? "day" : "recent",
        date: query.date ?? null,
        timezone,
        startedAt: window.window_start,
        endedAt: window.window_end,
      },
      worker: worker
        ? {
            heartbeatAt: worker.heartbeat_at,
            lastTickAt: worker.last_tick_at,
            status: worker.status,
            errorCode: worker.error_code,
            capabilities: worker.capabilities,
          }
        : null,
      selectedExecutionId: selected?.executionId ?? null,
      executions: projected.map(
        ({ events: _events, ...execution }) => execution,
      ),
      events: selected?.events ?? [],
      modelAnalysis: analysis[0] ?? null,
    };
  });

  app.post("/v1/admin/system-logs/analyze", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = systemLogAnalysisSchema.parse(request.body);
    const executionId = systemExecutionIdSchema.parse(input.executionId);
    const [source, sourceId] = executionId.split(":") as [
      SystemLogSource,
      string,
    ];
    z.string().uuid().parse(sourceId);
    const emptyRows: Parameters<typeof projectSystemLogExecutions>[0] = {
      jobs: [],
      notifications: [],
      outbox: [],
      reports: [],
    };
    if (source === "job")
      emptyRows.jobs = await sql<any[]>`
        select aj.*, p.display_name as partner_name, link.upload_id, link.period_key
        from agent_jobs aj
        left join partners p on p.id = aj.partner_id and p.tenant_id = aj.tenant_id
        left join lateral (
          select cuj.upload_id, u.period_key
          from collector_upload_jobs cuj
          join collector_uploads u on u.id = cuj.upload_id
          where cuj.job_id = aj.id
          order by u.created_at desc limit 1
        ) link on true
        where aj.id = ${sourceId} and aj.tenant_id = ${actor.tenantId}
          and aj.team_id = ${actor.teamId} limit 1
      `;
    else if (source === "notification")
      emptyRows.notifications = await sql<any[]>`
        select n.*,p.display_name as partner_name from app_notifications n
        join partners p on p.id=n.partner_id and p.tenant_id=n.tenant_id
        where n.id=${sourceId} and n.tenant_id=${actor.tenantId} and n.team_id=${actor.teamId} limit 1
      `;
    else if (source === "outbox")
      emptyRows.outbox = await sql<any[]>`
        select * from outbox_events where id = ${sourceId}
          and tenant_id = ${actor.tenantId}
          and (
            payload->>'teamId' = ${actor.teamId}
            or (aggregate_type = 'plugin_instance' and exists (
              select 1 from plugin_instances pi
              where pi.id::text = outbox_events.aggregate_id
                and pi.tenant_id = ${actor.tenantId} and pi.team_id = ${actor.teamId}
            ))
            or (aggregate_type = 'review' and exists (
              select 1 from reviews r
              where r.id::text = outbox_events.aggregate_id
                and r.tenant_id = ${actor.tenantId} and r.team_id = ${actor.teamId}
            ))
            or (aggregate_type in ('report', 'team_report') and exists (
              select 1 from team_reports tr
              where tr.id::text = outbox_events.aggregate_id
                and tr.tenant_id = ${actor.tenantId} and tr.team_id = ${actor.teamId}
            ))
          )
        limit 1
      `;
    else
      emptyRows.reports = await sql<any[]>`
        select tr.*, rp.period_key from team_reports tr
        join report_periods rp on rp.id = tr.period_id
          and rp.tenant_id = tr.tenant_id and rp.team_id = tr.team_id
        where tr.id = ${sourceId} and tr.tenant_id = ${actor.tenantId}
          and tr.team_id = ${actor.teamId} limit 1
      `;
    const execution = projectSystemLogExecutions(emptyRows)[0];
    if (!execution)
      throw new ApiError(
        404,
        "SYSTEM_EXECUTION_NOT_FOUND",
        "找不到这次中台运行记录。",
      );
    const idempotencyKey = `system-log-analysis:${execution.executionId}:${execution.lastEventAt}`;
    const rows = await sql<Array<{ id: string; status: string }>>`
      insert into agent_jobs (
        id, tenant_id, team_id, type, status, idempotency_key,
        input_payload, max_attempts
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId},
        'ANALYZE_SYSTEM_LOGS', 'PENDING', ${idempotencyKey},
        ${JSON.stringify({
          executionId: execution.executionId,
          source: execution.source,
          title: execution.title,
          subject: execution.subject,
          events: execution.events.map((event) => ({
            level: event.level,
            stage: event.stage,
            eventCode: event.eventCode,
            title: sanitizePluginLogText(event.title),
            message: sanitizePluginLogText(event.message),
            occurredAt: event.occurredAt,
            details: event.details,
          })),
        })}::jsonb,
        2
      ) on conflict (tenant_id, idempotency_key) do update set
        status = 'PENDING', attempt_count = 0, output_payload = null,
        error_code = null, error_message = null, completed_at = null,
        lease_until = null, updated_at = now()
      returning id, status
    `;
    await audit(
      request,
      actor,
      "system.logs.analysis_requested",
      "system_execution",
      execution.executionId,
      { jobId: rows[0]?.id, source: execution.source },
    );
    return { ok: true, job: rows[0] };
  });

  app.get("/v1/admin/system-monitoring", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const now = new Date();
    const [
      jobRows,
      notificationRows,
      reportRows,
      problemJobs,
      pendingNotifications,
      problemReports,
    ] = await Promise.all([
      sql<any[]>`
          select
            count(*) filter (where status = 'PENDING')::int as pending,
            count(*) filter (where status = 'LEASED')::int as leased,
            count(*) filter (where status = 'RETRY_WAIT')::int as retry_wait,
            count(*) filter (where status = 'LEASED' and lease_until < now())::int as expired_leases,
            min(created_at) filter (where status in ('PENDING', 'LEASED', 'RETRY_WAIT')) as oldest_active_at,
            count(*) filter (where type in ('EXTRACT_COLLECTOR_SESSION','AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT','REGENERATE_TEAM_REPORT') and status = 'FAILED')::int as generation_failed,
            count(*) filter (where type in ('EXTRACT_COLLECTOR_SESSION','AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT','REGENERATE_TEAM_REPORT') and status = 'RETRY_WAIT')::int as generation_retry_wait,
            count(*) filter (where type in ('EXTRACT_COLLECTOR_SESSION','AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT','REGENERATE_TEAM_REPORT') and status = 'COMPLETED' and completed_at >= now() - interval '24 hours')::int as generation_completed_24h
          from agent_jobs
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and type not like 'SYSTEM_HEALTH_%'
            and type not in ('ANALYZE_SYSTEM_LOGS', 'ANALYZE_INSPECTION_FINDING')
        `,
      sql<any[]>`
          select count(*) filter (where delivered_at is null)::int as pending,
            count(*) filter (where delivered_at is null and created_at < now()-interval '15 minutes')::int as stale_pending,
            count(*) filter (where delivered_at >= now()-interval '24 hours')::int as delivered_24h
          from app_notifications where tenant_id=${actor.tenantId} and team_id=${actor.teamId}
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
            and aj.type not in ('ANALYZE_SYSTEM_LOGS', 'ANALYZE_INSPECTION_FINDING')
            and (
              aj.status in ('FAILED', 'RETRY_WAIT')
              or (aj.status = 'LEASED' and aj.lease_until < now())
              or (aj.status = 'PENDING' and aj.created_at < now() - interval '1 hour')
            )
          order by aj.updated_at desc limit 50
        `,
      sql<any[]>`
          select n.id,n.title,n.created_at,p.display_name as partner_name
          from app_notifications n join partners p on p.id=n.partner_id and p.tenant_id=n.tenant_id
          where n.tenant_id=${actor.tenantId} and n.team_id=${actor.teamId}
            and n.delivered_at is null and n.created_at < now()-interval '15 minutes'
          order by n.created_at desc limit 50
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
    const notifications = notificationRows[0] ?? {};
    const reports = reportRows[0] ?? {};
    const [worker] = await sql<
      any[]
    >`select heartbeat_at,last_tick_at,status,error_code,capabilities from service_heartbeats where name='worker'`;
    const components = projectSystemComponents(
      {
        worker: worker ?? null,
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
        notifications: {
          pending: notifications.pending ?? 0,
          stalePending: notifications.stale_pending ?? 0,
          delivered24h: notifications.delivered_24h ?? 0,
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
        action: "前往异常巡检查看详情并决定是否重试。",
        href: "/admin/inspection",
      })),
      ...pendingNotifications.map((row) => ({
        id: "notification:" + row.id,
        sourceId: row.id,
        source: "notifications" as const,
        severity: "warning" as const,
        title: "App 通知尚未投递",
        message: row.title,
        errorCode: null,
        partnerName: row.partner_name,
        occurredAt: row.created_at,
        action: "确认 App 正在运行，并已允许 macOS 系统通知。",
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
        href: "/admin/inspection",
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
      worker: worker
        ? {
            heartbeatAt: worker.heartbeat_at,
            lastTickAt: worker.last_tick_at,
            status: worker.status,
            errorCode: worker.error_code,
            capabilities: worker.capabilities,
          }
        : null,
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
