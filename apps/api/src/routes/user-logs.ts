import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collectorPipelineStage } from "@partner-report/contracts";
import { sqlClient as sql, loadCollectorPipeline } from "@partner-report/db";
import { ApiError, requireWebActor } from "../common.js";
import { collectorLogStages } from "../collector-contracts.js";
import { logDateSchema } from "../sanitize.js";

const ONLINE_WINDOW_MINUTES = 5;
const MEMBER_WINDOW_HOURS = 24;
const EVENT_LIMIT = 1_000;

type Severity = "normal" | "warning" | "critical" | "unknown";
const severityRank: Record<Severity, number> = {
  unknown: 0,
  normal: 1,
  warning: 2,
  critical: 3,
};

const partnerParamsSchema = z.object({ partnerId: z.string().uuid() }).strict();

const detailQuerySchema = z
  .object({
    date: logDateSchema.optional(),
    level: z.enum(["info", "warning", "error"]).optional(),
    stage: z.enum(collectorLogStages).optional(),
    deviceId: z.string().uuid().optional(),
  })
  .strict();

type MemberDeviceRow = {
  id: string;
  partner_id: string;
  partner_name: string;
  device_name: string;
  version: string;
  last_log_at: Date | null;
  last_upload_at: Date | null;
  online: boolean;
  error_count: number;
  severity: Severity;
};

type DetailDeviceRow = {
  id: string;
  device_name: string;
  version: string;
  last_log_at: Date | null;
  last_upload_at: Date | null;
  client_state: unknown;
  state_observed_at: Date | null;
  online: boolean;
  notification_code: string | null;
};

type EventRow = {
  event_id: string;
  device_id: string;
  device_name: string;
  occurred_at: Date;
  received_at: Date;
  stage: string;
  level: string;
  code: string;
  upload_id: string | null;
  session_count: number;
  message: string | null;
  details: unknown;
};

export async function userLogRoutes(app: FastifyInstance) {
  app.get("/v1/admin/user-logs", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const rows = await sql<MemberDeviceRow[]>`
      select d.id, d.partner_id, p.display_name as partner_name, d.device_name, d.version,
        d.last_log_at, d.last_upload_at,
        (d.last_log_at is not null and d.last_log_at >= now() - make_interval(mins => ${ONLINE_WINDOW_MINUTES})) as online,
        (select count(*)::int from collector_logs l
          where l.device_id = d.id and l.level = 'error'
            and l.received_at >= now() - make_interval(hours => ${MEMBER_WINDOW_HOURS})) as error_count,
        case when d.last_log_at is null then 'unknown'
          when d.last_log_at < now() - make_interval(mins => ${ONLINE_WINDOW_MINUTES}) then 'warning'
          when exists(select 1 from (select distinct on (l.stage) l.level from collector_logs l
            where l.device_id = d.id and l.stage in ('scan','upload')
            order by l.stage, l.received_at desc) latest where latest.level = 'error') then 'critical'
          when exists(select 1 from collector_uploads u where u.device_id = d.id and u.status = 'receiving'
            and u.updated_at < now() - interval '15 minutes') then 'warning'
          else 'normal' end as severity
      from collector_devices d
        join partners p on p.id = d.partner_id and p.tenant_id = d.tenant_id and p.team_id = d.team_id
        join plugin_binding_codes b on b.id = d.binding_code_id and b.status <> 'revoked'
        join plugin_instances scope on scope.id = d.scope_instance_id and scope.status in ('active','collector')
      where d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
        and d.status = 'active' and p.status = 'active'
      order by p.display_name, p.id, d.last_log_at desc nulls last, d.id
    `;
    const members = new Map<
      string,
      {
        partnerId: string;
        name: string;
        devices: Array<{
          id: string;
          deviceName: string;
          version: string;
          lastLogAt: Date | null;
          lastUploadAt: Date | null;
        }>;
        appVersion: string | null;
        online: boolean;
        lastLogAt: Date | null;
        lastUploadAt: Date | null;
        errorCount: number;
        severity: Severity;
      }
    >();
    for (const row of rows) {
      let member = members.get(row.partner_id);
      if (!member) {
        member = {
          partnerId: row.partner_id,
          name: row.partner_name,
          devices: [],
          // Rows are ordered by latest log first, so the first device is the most recent.
          appVersion: row.version,
          online: false,
          lastLogAt: null,
          lastUploadAt: null,
          errorCount: 0,
          severity: "unknown",
        };
        members.set(row.partner_id, member);
      }
      member.devices.push({
        id: row.id,
        deviceName: row.device_name,
        version: row.version,
        lastLogAt: row.last_log_at,
        lastUploadAt: row.last_upload_at,
      });
      member.online ||= row.online;
      member.errorCount += row.error_count;
      if (
        row.last_log_at &&
        (!member.lastLogAt || row.last_log_at > member.lastLogAt)
      )
        member.lastLogAt = row.last_log_at;
      if (
        row.last_upload_at &&
        (!member.lastUploadAt || row.last_upload_at > member.lastUploadAt)
      )
        member.lastUploadAt = row.last_upload_at;
      if (severityRank[row.severity] > severityRank[member.severity])
        member.severity = row.severity;
    }
    return {
      checkedAt: new Date().toISOString(),
      onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
      windowHours: MEMBER_WINDOW_HOURS,
      members: [...members.values()],
    };
  });

  app.get("/v1/admin/user-logs/:partnerId", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { partnerId } = partnerParamsSchema.parse(request.params);
    const query = detailQuerySchema.parse(request.query);
    const [team] = await sql<Array<{ timezone: string }>>`
      select timezone from teams where id = ${actor.teamId} and tenant_id = ${actor.tenantId} limit 1
    `;
    const timezone = team?.timezone ?? "Asia/Shanghai";
    const [partner] = await sql<Array<{ id: string; display_name: string }>>`
      select id, display_name from partners
      where id = ${partnerId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'active' limit 1
    `;
    const devices = partner
      ? await sql<DetailDeviceRow[]>`
          select d.id, d.device_name, d.version, d.last_log_at, d.last_upload_at,
            d.client_state, d.state_observed_at,
            (d.last_log_at is not null and d.last_log_at >= now() - make_interval(mins => ${ONLINE_WINDOW_MINUTES})) as online,
            notification.code as notification_code
          from collector_devices d
            join plugin_binding_codes b on b.id = d.binding_code_id and b.status <> 'revoked'
            join plugin_instances scope on scope.id = d.scope_instance_id and scope.status in ('active','collector')
            left join lateral (select l.code from collector_logs l
              where l.device_id = d.id and l.stage = 'notification'
              order by l.received_at desc, l.event_id desc limit 1) notification on true
          where d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
            and d.partner_id = ${partnerId} and d.status = 'active'
          order by d.last_log_at desc nulls last, d.id
        `
      : [];
    if (!partner || devices.length === 0)
      throw new ApiError(404, "PARTNER_NOT_FOUND", "成员没有可用的 App 设备。");

    const [window] = query.date
      ? await sql<Array<{ window_start: Date; window_end: Date }>>`
          select (${query.date}::date::timestamp at time zone ${timezone}) as window_start,
            ((${query.date}::date + 1)::timestamp at time zone ${timezone}) as window_end
        `
      : await sql<Array<{ window_start: Date; window_end: Date }>>`
          select now() - interval '24 hours' as window_start, now() as window_end
        `;
    if (!window) throw new ApiError(500, "WINDOW_UNAVAILABLE", "无法计算日志时间窗口。");

    const events = await sql<EventRow[]>`
      select l.event_id, l.device_id, d.device_name, l.occurred_at, l.received_at,
        l.stage, l.level, l.code, l.upload_id, l.session_count, l.message, l.details
      from collector_logs l
        join collector_devices d on d.id = l.device_id
      where d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
        and d.partner_id = ${partnerId}
        and l.received_at >= ${window.window_start} and l.received_at < ${window.window_end}
        ${query.level ? sql`and l.level = ${query.level}` : sql``}
        ${query.stage ? sql`and l.stage = ${query.stage}` : sql``}
        ${query.deviceId ? sql`and l.device_id = ${query.deviceId}` : sql``}
      order by l.received_at desc, l.event_id desc
      limit ${EVENT_LIMIT}
    `;
    const uploads = await loadCollectorPipeline(sql, {
      tenantId: actor.tenantId,
      teamId: actor.teamId,
      partnerId,
    });
    return {
      partner: { id: partner.id, name: partner.display_name },
      window: {
        mode: query.date ? "day" : "recent",
        date: query.date ?? null,
        timezone,
        startedAt: window.window_start,
        endedAt: window.window_end,
      },
      devices: devices.map((device) => ({
        id: device.id,
        deviceName: device.device_name,
        version: device.version,
        lastLogAt: device.last_log_at,
        lastUploadAt: device.last_upload_at,
        clientState: device.client_state,
        stateObservedAt: device.state_observed_at,
        online: device.online,
        notificationCode: device.notification_code,
      })),
      events: events.map((event) => ({
        eventId: event.event_id,
        deviceId: event.device_id,
        deviceName: event.device_name,
        occurredAt: event.occurred_at,
        receivedAt: event.received_at,
        stage: event.stage,
        level: event.level,
        code: event.code,
        uploadId: event.upload_id,
        sessionCount: event.session_count,
        message: event.message,
        details: event.details,
      })),
      uploads: uploads.map((upload: Record<string, unknown>) => ({
        ...upload,
        ...collectorPipelineStage(upload),
      })),
    };
  });
}
