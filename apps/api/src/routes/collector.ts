import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  collectorPipelineStage,
  redactSessionText,
} from "@partner-report/contracts";
import {
  sqlClient as sql,
  dispatchAppNotifications,
  suppressedAppNotificationKinds,
  enqueueCollectorUpload,
  loadCollectorPipeline,
} from "@partner-report/db";
import {
  ApiError,
  randomToken,
  sha256,
  requireWebActor,
  audit,
} from "../common.js";
import {
  sanitizePluginLogDetails,
  sanitizePluginLogText,
} from "../sanitize.js";
import {
  loadProjectScopePolicy,
  decideProjectScopes,
  registerProjectScopeCandidates,
  type ScopeIdentity,
} from "../project-scope.js";
import {
  collectorClaimSchema,
  collectorLogSchema,
  collectorManifestSchema,
  collectorSessionsSchema,
  validateCollectorSessions,
  type CollectorLogDetails,
} from "../collector-contracts.js";

/** First upload covers the scanned month; allow a margin for month length and late uploads. */
const collectorRetentionMs = 62 * 24 * 60 * 60 * 1000;

type CollectorActor = ScopeIdentity & {
  deviceId: string;
  actorType: "collector";
  actorId: string;
  userId: null;
};

export async function requireCollector(
  request: FastifyRequest,
): Promise<CollectorActor> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer "))
    throw new ApiError(401, "UNAUTHENTICATED", "请先绑定 App。");
  const rows = await sql<CollectorActor[]>`
    select d.id as "deviceId", d.id as "actorId", 'collector' as "actorType", null::uuid as "userId",
      d.tenant_id as "tenantId", d.team_id as "teamId", d.partner_id as "partnerId", d.scope_instance_id as "pluginInstanceId"
    from collector_devices d join plugin_binding_codes b on b.id=d.binding_code_id
      join plugin_instances p on p.id=d.scope_instance_id
      join partners member on member.id=d.partner_id and member.status='active'
    where d.token_hash=${sha256(header.slice(7))} and d.status='active'
      and b.status <> 'revoked' and p.status in ('active','collector') limit 1`;
  if (!rows[0])
    throw new ApiError(
      401,
      "COLLECTOR_BINDING_INVALID",
      "App 绑定已失效，请重新绑定。",
    );
  return rows[0];
}

async function lockedPolicy(actor: CollectorActor, version: number, tx: any) {
  const rows = await tx`select version from project_scope_policies
    where plugin_instance_id=${actor.pluginInstanceId} and tenant_id=${actor.tenantId} for update`;
  if (rows[0]?.version !== version)
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "项目权限已变更，请刷新后重新准备上传。",
    );
  const entries = await tx`select scope_key from project_scope_entries
    where plugin_instance_id=${actor.pluginInstanceId} and tenant_id=${actor.tenantId} and status='allowed'`;
  return new Set<string>(entries.map((e: any) => e.scope_key));
}

async function uploadFor(actor: CollectorActor, id: string, tx: any) {
  const rows =
    await tx`select * from collector_uploads where id=${id} and device_id=${actor.deviceId} for update`;
  if (!rows[0]) throw new ApiError(404, "UPLOAD_NOT_FOUND", "上传批次不存在。");
  return rows[0];
}

export async function collectorRoutes(app: FastifyInstance) {
  app.get("/v1/collector/pipeline", async (request) => {
    const actor = await requireCollector(request);
    return {
      uploads: (await loadCollectorPipeline(sql, actor)).map((upload: any) => ({
        ...upload,
        ...collectorPipelineStage(upload),
      })),
    };
  });

  // Restores what a re-bound App forgot: which message versions the system already holds,
  // and the batches it received. Only digests and counts leave the server, never conversation text.
  app.get("/v1/collector/sync-state", async (request) => {
    const actor = await requireCollector(request);
    const since = new Date(Date.now() - collectorRetentionMs).toISOString();
    const sessions = await sql<
      { id: string; messages: Record<string, string> }[]
    >`
      select id, messages from (
        select distinct on (s.item->>'id') s.item->>'id' as id,
          (select coalesce(jsonb_object_agg(m.key, m.digest), '{}'::jsonb) from (
            select (t.turn->>'id') || ':prompt' as key,
              encode(sha256(convert_to(t.turn->>'prompt', 'UTF8')), 'hex') as digest
            from jsonb_array_elements(s.item->'turns') t(turn)
            union all
            select (t.turn->>'id') || ':answer',
              encode(sha256(convert_to(t.turn->>'answer', 'UTF8')), 'hex')
            from jsonb_array_elements(s.item->'turns') t(turn)
            where t.turn->>'answer' is not null
          ) m) as messages
        from collector_uploads u
          join collector_devices d on d.id = u.device_id
          join collector_upload_parts p on p.upload_id = u.id
          cross join lateral jsonb_array_elements(p.sessions) s(item)
        where d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
          and d.partner_id = ${actor.partnerId} and d.status <> 'test'
          and u.status = 'completed' and u.created_at >= ${since}
        order by s.item->>'id', (s.item->>'modifiedAt')::timestamptz desc, u.created_at desc
      ) latest`;
    const uploads = await sql<
      {
        id: string;
        periodKey: string;
        sessionCount: number;
        completedAt: Date | null;
        createdAt: Date;
        projects: {
          scopeKey: string;
          sessionCount: number;
          messageCount: number;
        }[];
      }[]
    >`
      select u.id, u.period_key as "periodKey", u.session_count as "sessionCount",
        u.completed_at as "completedAt", u.created_at as "createdAt",
        (select coalesce(jsonb_agg(jsonb_build_object('scopeKey', g.scope_key, 'sessionCount', g.sessions,
            'messageCount', g.messages)), '[]'::jsonb) from (
          select s.item->>'scopeKey' as scope_key, count(*)::int as sessions,
            sum(jsonb_array_length(s.item->'turns') +
              (select count(*) from jsonb_array_elements(s.item->'turns') t(turn) where t.turn->>'answer' is not null))::int as messages
          from collector_upload_parts p cross join lateral jsonb_array_elements(p.sessions) s(item)
          where p.upload_id = u.id group by 1) g) as projects
      from collector_uploads u join collector_devices d on d.id = u.device_id
      where d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
        and d.partner_id = ${actor.partnerId} and d.status <> 'test'
        and u.status = 'completed' and u.created_at >= ${since}
      order by u.completed_at desc nulls last limit 50`;
    return { sessions, uploads };
  });
  app.post("/v1/admin/collector-uploads/:id/retry", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await sql.begin(async (tx) => {
      const [upload] =
        await tx`select u.* from collector_uploads u join collector_devices d on d.id=u.device_id
        where u.id=${id} and d.tenant_id=${actor.tenantId} and d.team_id=${actor.teamId} for update of u`;
      if (!upload)
        throw new ApiError(404, "UPLOAD_NOT_FOUND", "上传批次不存在。");
      if (upload.status !== "completed")
        throw new ApiError(
          409,
          "UPLOAD_INCOMPLETE",
          "会话包尚未完整接收，请在 App 中重试上传。",
        );
      await enqueueCollectorUpload(tx, id);
      const retried =
        await tx`update agent_jobs set status='PENDING',error_code=null,error_message=null,next_retry_at=null,
        max_attempts=greatest(max_attempts,attempt_count+3),updated_at=now()
        where tenant_id=${actor.tenantId} and status in ('FAILED','RETRY_WAIT') and id in
          (select job_id from collector_upload_jobs where upload_id=${id}) returning id`;
      const cards =
        await tx`update agent_jobs j set status='PENDING',error_code=null,error_message=null,next_retry_at=null,
        max_attempts=greatest(max_attempts,attempt_count+3),updated_at=now()
        from collector_devices d join report_periods rp on rp.tenant_id=d.tenant_id and rp.team_id=d.team_id and rp.period_key=${upload.period_key}
        where d.id=${upload.device_id} and j.tenant_id=d.tenant_id and j.partner_id=d.partner_id
          and j.type='AGGREGATE_WORK_ITEMS' and j.input_payload->'period'->>'id'=rp.id::text
          and j.status in ('FAILED','RETRY_WAIT') returning j.id`;
      const reports =
        await tx`update agent_jobs j set status='PENDING',error_code=null,error_message=null,next_retry_at=null,
        max_attempts=greatest(max_attempts,attempt_count+3),updated_at=now()
        from collector_devices d join report_periods rp on rp.tenant_id=d.tenant_id and rp.team_id=d.team_id and rp.period_key=${upload.period_key}
        where d.id=${upload.device_id} and j.tenant_id=d.tenant_id and j.team_id=d.team_id
          and j.type in ('GENERATE_TEAM_REPORT','REGENERATE_TEAM_REPORT') and j.input_payload->'period'->>'id'=rp.id::text
          and j.status in ('FAILED','RETRY_WAIT') returning j.id`;
      return {
        ok: true,
        retried: retried.length + cards.length + reports.length,
      };
    });
    await audit(
      request,
      actor,
      "collector.analysis.retry",
      "collector_upload",
      id,
      { retried: result.retried },
    );
    return result;
  });
  app.get("/v1/collector/notifications", async (request) => {
    const actor = await requireCollector(request);
    await dispatchAppNotifications(100, actor.tenantId);
    const notifications = await sql`
      select id,kind,title,body,target_type as "targetType",target_id as "targetId",created_at as "createdAt"
      from app_notifications where tenant_id=${actor.tenantId} and team_id=${actor.teamId}
        and partner_id=${actor.partnerId} and delivered_at is null
        and kind not in ${sql(suppressedAppNotificationKinds)}
      order by created_at,id limit 100
    `;
    return {
      notifications: notifications.map((notification) => ({
        ...notification,
        createdAt: new Date(notification.createdAt).toISOString(),
      })),
    };
  });
  app.post("/v1/collector/notifications/delivered", async (request) => {
    const actor = await requireCollector(request);
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
      .strict()
      .parse(request.body);
    const unique = [...new Set(ids)];
    await sql.begin(async (tx) => {
      const own =
        await tx`select id from app_notifications where id in ${tx(unique)}
        and tenant_id=${actor.tenantId} and team_id=${actor.teamId} and partner_id=${actor.partnerId} for update`;
      if (own.length !== unique.length)
        throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "通知不存在。");
      await tx`update app_notifications set delivered_at=coalesce(delivered_at,now()),delivered_device_id=coalesce(delivered_device_id,${actor.deviceId})
        where id in ${tx(unique)}`;
    });
    return { ok: true, accepted: unique };
  });
  app.post("/v1/admin/partners/:id/notifications/test", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const partners =
      await sql`select id from partners where id=${id} and tenant_id=${actor.tenantId} and team_id=${actor.teamId} and status='active'`;
    if (!partners[0]) throw new ApiError(404, "NOT_FOUND", "成员不存在。");
    const notificationId = randomUUID();
    await sql`insert into app_notifications (id,tenant_id,team_id,partner_id,source_event_id,kind,title,body,target_type)
      values (${notificationId},${actor.tenantId},${actor.teamId},${id},${randomUUID()},'notification.test','weekly report 测试通知','这是一条来自中台的测试提醒。','app')`;
    await audit(
      request,
      actor,
      "app.notification.test_requested",
      "partner",
      id,
    );
    return { id: notificationId, status: "queued" };
  });
  app.get(
    "/v1/admin/partners/:id/notifications/:notificationId",
    async (request) => {
      const actor = await requireWebActor(request, "admin");
      const { id, notificationId } = z
        .object({
          id: z.string().uuid(),
          notificationId: z.string().uuid(),
        })
        .parse(request.params);
      const [notification] =
        await sql`select id,delivered_at from app_notifications
      where id=${notificationId} and partner_id=${id}
        and tenant_id=${actor.tenantId} and team_id=${actor.teamId}`;
      if (!notification)
        throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "通知不存在。");
      if (notification.delivered_at)
        return { id: notificationId, status: "delivered" };
      const devices =
        await sql`select d.last_log_at,l.code from collector_devices d
      join plugin_binding_codes b on b.id=d.binding_code_id and b.status <> 'revoked'
      join plugin_instances scope on scope.id=d.scope_instance_id and scope.status in ('active','collector')
      left join lateral (select code from collector_logs where device_id=d.id and stage='notification'
        order by received_at desc,event_id desc limit 1) l on true
      where d.tenant_id=${actor.tenantId} and d.team_id=${actor.teamId} and d.partner_id=${id} and d.status='active'`;
      const online = devices.filter(
        (d) =>
          d.last_log_at &&
          Date.now() - new Date(d.last_log_at).getTime() < 3 * 60_000,
      );
      const status = online.some((d) => d.code === "NOTIFICATIONS_ALLOWED")
        ? "queued"
        : online.some((d) => d.code === "NOTIFICATIONS_DENIED")
          ? "permission_denied"
          : online.some((d) => d.code === "NOTIFICATIONS_NOT_CONFIGURED")
            ? "permission_required"
            : online.length
              ? "queued"
              : "app_offline";
      return { id: notificationId, status };
    },
  );
  const claimAttempts = new Map<string, { count: number; expires: number }>();
  app.post("/v1/collector/bindings/claim", async (request) => {
    const now = Date.now();
    for (const [ip, state] of claimAttempts)
      if (state.expires < now) claimAttempts.delete(ip);
    const attempt = claimAttempts.get(request.ip) ?? {
      count: 0,
      expires: now + 10 * 60_000,
    };
    if (attempt.count >= 20)
      throw new ApiError(
        429,
        "BINDING_RATE_LIMITED",
        "绑定尝试过于频繁，请稍后重试。",
      );
    attempt.count += 1;
    claimAttempts.set(request.ip, attempt);
    const input = collectorClaimSchema.parse(request.body);
    const token = randomToken();
    const deviceId = randomUUID();
    const identity = await sql.begin(async (tx) => {
      const bindings = await tx<
        any[]
      >`select b.*, p.display_name from plugin_binding_codes b
        join partners p on p.id=b.partner_id and p.tenant_id=b.tenant_id and p.team_id=b.team_id
        where b.code_hash=${sha256(input.bindingCode.toUpperCase())} and b.status in ('active','connecting','claimed')
          and p.status='active' for update of b, p`;
      const binding = bindings[0];
      // Do not reveal which half of the binding identity was incorrect.
      if (
        !binding ||
        binding.display_name.normalize("NFKC").trim() !==
          input.name.normalize("NFKC")
      )
        throw new ApiError(
          400,
          "BINDING_IDENTITY_INVALID",
          "名字或绑定码不匹配。",
        );
      const scopes = await tx<
        any[]
      >`select id from plugin_instances where tenant_id=${binding.tenant_id}
        and team_id=${binding.team_id} and partner_id=${binding.partner_id} and status in ('active','collector')
        order by (id=${binding.plugin_instance_id}) desc, (status='active') desc, created_at desc limit 1`;
      const scopeId = scopes[0]?.id ?? randomUUID();
      if (!scopes[0])
        await tx`insert into plugin_instances
        (id, tenant_id, team_id, partner_id, device_name, version, status, access_token_hash, refresh_token_hash, access_expires_at)
        values (${scopeId},${binding.tenant_id},${binding.team_id},${binding.partner_id},${input.deviceName},${input.version},
          'collector',${sha256(randomToken())},${sha256(randomToken())},now())`;
      await tx`update collector_devices set status='revoked',updated_at=now()
        where binding_code_id=${binding.id} and status='active'`;
      await tx`insert into collector_devices
        (id,tenant_id,team_id,partner_id,scope_instance_id,binding_code_id,device_name,version,token_hash)
        values (${deviceId},${binding.tenant_id},${binding.team_id},${binding.partner_id},${scopeId},${binding.id},${input.deviceName},${input.version},${sha256(token)})`;
      await tx`update plugin_binding_codes set status='claimed',plugin_instance_id=${scopeId},
        claimed_at=coalesce(claimed_at,now()),last_used_at=now(),updated_at=now() where id=${binding.id}`;
      return {
        tenantId: binding.tenant_id,
        teamId: binding.team_id,
        partnerId: binding.partner_id,
        pluginInstanceId: scopeId,
      };
    });
    const policy = await loadProjectScopePolicy(identity);
    return { token, deviceId, name: input.name, policy };
  });

  app.get("/v1/collector/project-scope", async (request) =>
    loadProjectScopePolicy(await requireCollector(request)),
  );
  app.post("/v1/collector/project-scope/decisions", async (request) => {
    const actor = await requireCollector(request);
    const policy = await decideProjectScopes(
      actor,
      actor.pluginInstanceId,
      request.body,
    );
    await audit(
      request,
      actor,
      "collector.permissions.changed",
      "plugin_instance",
      actor.pluginInstanceId,
      { version: policy.version },
    );
    return policy;
  });
  app.post("/v1/collector/project-scope/candidates", async (request) => {
    const actor = await requireCollector(request);
    return registerProjectScopeCandidates(actor, request.body);
  });

  app.post("/v1/collector/uploads", async (request) => {
    const actor = await requireCollector(request);
    const manifest = collectorManifestSchema.parse(request.body);
    return sql.begin(async (tx) => {
      await lockedPolicy(actor, manifest.policyVersion, tx);
      const periods = await tx<
        any[]
      >`select starts_at, ends_at from report_periods
        where tenant_id=${actor.tenantId} and team_id=${actor.teamId} and period_key=${manifest.periodKey} limit 1`;
      const period = periods[0];
      // Older unsent sessions may precede the period (first upload covers the scanned month);
      // they are retained but only in-period messages are analysed.
      if (
        !period ||
        Date.parse(manifest.startsAt) <
          new Date(period.starts_at).getTime() - collectorRetentionMs ||
        Date.parse(manifest.endsAt) < new Date(period.starts_at).getTime() ||
        Date.parse(manifest.endsAt) > new Date(period.ends_at).getTime()
      )
        throw new ApiError(
          400,
          "INVALID_COLLECTION_PERIOD",
          "上传范围必须结束于系统采集周期内，且最早不超过周期开始前 62 天。",
        );
      await tx`insert into collector_uploads (id,device_id,period_key,starts_at,ends_at,policy_version,session_count,part_digests)
        values (${manifest.id},${actor.deviceId},${manifest.periodKey},${manifest.startsAt},${manifest.endsAt},
          ${manifest.policyVersion},${manifest.sessionCount},${JSON.stringify(manifest.partDigests)}::jsonb) on conflict (id) do nothing`;
      const old = await uploadFor(actor, manifest.id, tx);
      if (
        old.policy_version !== manifest.policyVersion ||
        old.session_count !== manifest.sessionCount ||
        old.period_key !== manifest.periodKey ||
        new Date(old.starts_at).getTime() !== Date.parse(manifest.startsAt) ||
        new Date(old.ends_at).getTime() !== Date.parse(manifest.endsAt) ||
        JSON.stringify(old.part_digests) !==
          JSON.stringify(manifest.partDigests)
      )
        throw new ApiError(
          409,
          "UPLOAD_MANIFEST_CONFLICT",
          "批次标识已被不同内容使用。",
        );
      if (old.status === "superseded")
        throw new ApiError(
          409,
          "UPLOAD_SUPERSEDED",
          "此批次已被新会话包替代。",
        );
      if (old.status === "receiving")
        await tx`update collector_uploads set status='superseded',updated_at=now()
        where device_id=${actor.deviceId} and period_key=${manifest.periodKey} and status='receiving'
          and id <> ${manifest.id} and created_at < ${old.created_at}`;
      return { id: manifest.id, status: old.status };
    });
  });

  app.post(
    "/v1/collector/uploads/:id/parts",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request) => {
      const actor = await requireCollector(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z
        .object({
          partIndex: z.number().int().nonnegative(),
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
          data: z
            .string()
            .max(23 * 1024 * 1024)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .strict()
        .parse(request.body);
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length > 16 * 1024 * 1024 || sha256(bytes) !== input.checksum)
        throw new ApiError(400, "CHECKSUM_MISMATCH", "会话包校验失败。");
      let decoded: unknown;
      try {
        decoded = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ApiError(
          400,
          "INVALID_SESSION_PACKAGE",
          "会话包不是有效 JSON。",
        );
      }
      const sessions = collectorSessionsSchema.parse(decoded);
      return sql.begin(async (tx) => {
        // Policy first, then upload: all write routes use the same lock order.
        const versions = await tx<
          any[]
        >`select policy_version from collector_uploads where id=${id} and device_id=${actor.deviceId}`;
        if (!versions[0])
          throw new ApiError(404, "UPLOAD_NOT_FOUND", "上传批次不存在。");
        const allowed = await lockedPolicy(
          actor,
          versions[0].policy_version,
          tx,
        );
        const run = await uploadFor(actor, id, tx);
        if (run.status === "superseded")
          throw new ApiError(
            409,
            "UPLOAD_SUPERSEDED",
            "此批次已被新会话包替代。",
          );
        if (run.part_digests[input.partIndex] !== input.checksum)
          throw new ApiError(409, "PART_CONFLICT", "分包与批次清单不匹配。");
        const violation = validateCollectorSessions(
          sessions,
          { startsAt: run.starts_at, endsAt: run.ends_at },
          allowed,
        );
        if (violation)
          throw new ApiError(
            403,
            violation,
            "会话不属于已授权项目或采集范围。",
          );
        // The checksum above vouches for what the App sent; what is kept has credentials removed.
        if (run.status !== "completed")
          await tx`insert into collector_upload_parts (upload_id,part_index,checksum,sessions)
        values (${id},${input.partIndex},${input.checksum},${JSON.stringify(redactSessionText(sessions))}::jsonb) on conflict (upload_id,part_index) do nothing`;
        await tx`update collector_uploads set updated_at=now() where id=${id}`;
        return { ok: true, partIndex: input.partIndex };
      });
    },
  );

  app.post("/v1/collector/uploads/:id/complete", async (request) => {
    const actor = await requireCollector(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return sql.begin(async (tx) => {
      const versions = await tx<
        any[]
      >`select policy_version from collector_uploads where id=${id} and device_id=${actor.deviceId}`;
      if (!versions[0])
        throw new ApiError(404, "UPLOAD_NOT_FOUND", "上传批次不存在。");
      const allowed = await lockedPolicy(actor, versions[0].policy_version, tx);
      const run = await uploadFor(actor, id, tx);
      if (run.status === "superseded")
        throw new ApiError(
          409,
          "UPLOAD_SUPERSEDED",
          "此批次已被新会话包替代。",
        );
      if (run.status === "completed") {
        await enqueueCollectorUpload(tx, id);
        return { id, status: "completed", sessionCount: run.session_count };
      }
      const parts = await tx<
        any[]
      >`select part_index,sessions from collector_upload_parts where upload_id=${id} order by part_index`;
      const sessions = parts.flatMap((p) => p.sessions);
      if (
        parts.length !== run.part_digests.length ||
        sessions.length !== run.session_count
      )
        throw new ApiError(409, "UPLOAD_INCOMPLETE", "会话包尚未全部接收。");
      const violation = validateCollectorSessions(
        sessions,
        { startsAt: run.starts_at, endsAt: run.ends_at },
        allowed,
      );
      if (violation)
        throw new ApiError(403, violation, "会话包包含重复或未授权会话。");
      await tx`update collector_uploads set status='completed',completed_at=now(),updated_at=now() where id=${id}`;
      await tx`update collector_devices set last_upload_at=now(),updated_at=now() where id=${actor.deviceId}`;
      await enqueueCollectorUpload(tx, id);
      return { id, status: "completed", sessionCount: sessions.length };
    });
  });

  app.post("/v1/collector/logs", async (request) => {
    const actor = await requireCollector(request);
    const input = collectorLogSchema.parse(request.body);
    await sql.begin(async (tx) => {
      for (const event of input.events) {
        // details.message is stored in its own column after server-side redaction.
        const details: CollectorLogDetails = event.details ?? {};
        const { message, ...rest } = details;
        const storedMessage =
          message === undefined ? null : sanitizePluginLogText(message);
        const storedDetails = sanitizePluginLogDetails(rest);
        await tx`insert into collector_logs (device_id,event_id,occurred_at,stage,level,code,upload_id,session_count,message,details)
        values (${actor.deviceId},${event.eventId},${event.occurredAt},${event.stage},${event.level},${event.code},${event.uploadId ?? null},${event.sessionCount},
          ${storedMessage},${JSON.stringify(storedDetails)}::jsonb)
        on conflict (device_id,event_id) do nothing`;
      }
      await tx`update collector_devices set last_log_at=now(),updated_at=now() where id=${actor.deviceId}`;
      const latest = input.events
        .filter(
          (event) =>
            event.state && Date.parse(event.occurredAt) <= Date.now() + 60_000,
        )
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
      if (latest)
        await tx`update collector_devices set client_state=${JSON.stringify(latest.state)}::jsonb,
        state_observed_at=${latest.occurredAt} where id=${actor.deviceId}
        and (state_observed_at is null or state_observed_at <= ${latest.occurredAt})`;
    });
    return { ok: true, accepted: input.events.map((e) => e.eventId) };
  });
}
