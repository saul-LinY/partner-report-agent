import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { heartbeatSchema } from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  randomToken,
  requirePluginActor,
  requireWebActor,
  sha256,
  userCode,
} from "../common.js";

const deviceStartSchema = z.object({
  deviceName: z.string().min(1).max(120),
  pluginVersion: z.string().min(1).max(40),
});

const deviceTokenSchema = z.object({ deviceCode: z.string().min(20) });
const refreshSchema = z.object({ refreshToken: z.string().min(20) });

function accessExpiry() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

export async function pluginRoutes(app: FastifyInstance) {
  app.post("/v1/plugin-bindings/device-authorizations", async (request) => {
    const input = deviceStartSchema.parse(request.body);
    const deviceCode = randomToken();
    const code = userCode();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await sql`
      insert into plugin_device_authorizations (
        id, device_code_hash, user_code, device_name, plugin_version, expires_at
      ) values (${id}, ${sha256(deviceCode)}, ${code}, ${input.deviceName}, ${input.pluginVersion}, ${expiresAt.toISOString()})
    `;
    return {
      deviceCode,
      userCode: code,
      verificationUri: `${process.env.WEB_ORIGIN ?? "http://127.0.0.1:4311"}/connect-plugin?code=${code}`,
      expiresAt,
      intervalSeconds: 3,
    };
  });

  app.post(
    "/v1/plugin-bindings/device-authorizations/:userCode/approve",
    async (request) => {
      const actor = await requireWebActor(request, "partner");
      if (!actor.partnerId)
        throw new ApiError(
          403,
          "PARTNER_REQUIRED",
          "当前账号没有 Partner Profile。",
        );
      const params = z
        .object({ userCode: z.string().min(8) })
        .parse(request.params);

      const active = await sql`
      select 1 from plugin_instances
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and status = 'active'
      limit 1
    `;
      if (active.length > 0) {
        throw new ApiError(
          409,
          "ACTIVE_PLUGIN_EXISTS",
          "该 Partner 已有活动 Plugin，请先在 Admin 控制台撤销旧实例。",
        );
      }

      const rows = await sql<any[]>`
      update plugin_device_authorizations set
        tenant_id = ${actor.tenantId}, team_id = ${actor.teamId}, partner_id = ${actor.partnerId},
        status = 'approved', approved_at = now()
      where user_code = ${params.userCode.toUpperCase()}
        and status = 'pending'
        and expires_at > now()
      returning id
    `;
      if (!rows[0])
        throw new ApiError(404, "DEVICE_CODE_INVALID", "设备码无效或已过期。");
      await audit(
        request,
        actor,
        "plugin.binding.approved",
        "device_authorization",
        rows[0].id,
      );
      return { ok: true };
    },
  );

  app.post(
    "/v1/plugin-bindings/device-authorizations/token",
    async (request) => {
      const input = deviceTokenSchema.parse(request.body);
      const rows = await sql<any[]>`
      select * from plugin_device_authorizations
      where device_code_hash = ${sha256(input.deviceCode)}
      limit 1
    `;
      const authorization = rows[0];
      if (
        !authorization ||
        new Date(authorization.expires_at).getTime() <= Date.now()
      ) {
        throw new ApiError(400, "DEVICE_CODE_EXPIRED", "设备授权已过期。");
      }
      if (authorization.status === "pending") {
        throw new ApiError(
          428,
          "AUTHORIZATION_PENDING",
          "等待 Partner 在 Web 中确认。",
          { retryable: true },
        );
      }
      if (authorization.status !== "approved" || authorization.consumed_at) {
        throw new ApiError(409, "DEVICE_CODE_CONSUMED", "设备授权已使用。");
      }

      const accessToken = randomToken();
      const refreshToken = randomToken();
      const pluginInstanceId = randomUUID();
      const expiresAt = accessExpiry();
      await sql.begin(async (tx) => {
        await tx`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${pluginInstanceId}, ${authorization.tenant_id}, ${authorization.team_id}, ${authorization.partner_id},
          ${authorization.device_name}, ${authorization.plugin_version}, ${sha256(accessToken)},
          ${sha256(refreshToken)}, ${expiresAt.toISOString()}
        )
      `;
        await tx`
        update plugin_device_authorizations set status = 'consumed', consumed_at = now()
        where id = ${authorization.id} and status = 'approved'
      `;
        await tx`
        insert into audit_events (
          id, tenant_id, team_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata
        ) values (
          ${randomUUID()}, ${authorization.tenant_id}, ${authorization.team_id}, 'plugin', ${pluginInstanceId},
          'plugin.binding.activated', 'plugin_instance', ${pluginInstanceId}, ${request.id}, '{}'::jsonb
        )
      `;
      });
      return { accessToken, refreshToken, expiresAt, pluginInstanceId };
    },
  );

  app.post("/v1/plugin-bindings/refresh", async (request) => {
    const input = refreshSchema.parse(request.body);
    const rows = await sql<any[]>`
      select * from plugin_instances
      where refresh_token_hash = ${sha256(input.refreshToken)} and status = 'active'
      limit 1
    `;
    const plugin = rows[0];
    if (!plugin)
      throw new ApiError(
        401,
        "REFRESH_TOKEN_INVALID",
        "Refresh Token 无效或已轮换。",
      );
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = accessExpiry();
    await sql`
      update plugin_instances set
        access_token_hash = ${sha256(accessToken)}, refresh_token_hash = ${sha256(refreshToken)},
        access_expires_at = ${expiresAt.toISOString()}, updated_at = now()
      where id = ${plugin.id} and refresh_token_hash = ${sha256(input.refreshToken)}
    `;
    return {
      accessToken,
      refreshToken,
      expiresAt,
      pluginInstanceId: plugin.id,
    };
  });

  app.get("/v1/plugin-bindings/me", async (request) => {
    const actor = await requirePluginActor(request);
    const [teamRows, projectRows, periodRows] = await Promise.all([
      sql<
        any[]
      >`select * from teams where id = ${actor.teamId} and tenant_id = ${actor.tenantId}`,
      sql<any[]>`
        select id, name, aliases, allowed_paths, external_ids from projects
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and status = 'active'
        order by name
      `,
      sql<any[]>`
        select * from report_periods
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and status = 'open'
          and starts_at <= now() and ends_at >= now()
        order by starts_at desc limit 1
      `,
    ]);
    return {
      pluginInstanceId: actor.pluginInstanceId,
      partnerId: actor.partnerId,
      team: teamRows[0],
      projects: projectRows,
      currentPeriod: periodRows[0],
      schemaVersions: ["1.0"],
      serverTime: new Date().toISOString(),
    };
  });

  app.post("/v1/plugin-instances/me/heartbeat", async (request) => {
    const actor = await requirePluginActor(request);
    const input = heartbeatSchema.parse(request.body);
    await sql`
      update plugin_instances set
        version = ${input.pluginVersion}, device_name = ${input.deviceName}, last_heartbeat_at = now(),
        last_hook_at = coalesce(${input.lastHookAt ?? null}, last_hook_at),
        last_runner_at = coalesce(${input.lastRunnerAt ?? null}, last_runner_at),
        last_scan_at = coalesce(${input.lastScanAt ?? null}, last_scan_at),
        last_sync_at = coalesce(${input.lastSyncAt ?? null}, last_sync_at),
        next_due_at = ${input.nextDueAt ?? null}, runner_state = ${input.runnerState},
        dirty_sessions = ${input.dirtySessions}, extracting_sessions = ${input.extractingSessions},
        pending_local_jobs = ${input.pendingLocalJobs}, retry_count = ${input.retryCount},
        last_error_code = ${input.lastErrorCode ?? null}, updated_at = now()
      where id = ${actor.pluginInstanceId} and tenant_id = ${actor.tenantId}
    `;
    if (input.coverage) {
      const periods = await sql<any[]>`
        select id from report_periods
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and status = 'open'
          and starts_at <= now() and ends_at >= now()
        order by starts_at desc limit 1
      `;
      if (periods[0]) {
        await sql`
          insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
          values (
            ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${periods[0].id},
            ${JSON.stringify(input.coverage)}::jsonb
          )
        `;
      }
    }
    await audit(
      request,
      actor,
      "plugin.heartbeat",
      "plugin_instance",
      actor.pluginInstanceId,
      {
        pendingLocalJobs: input.pendingLocalJobs,
        runnerState: input.runnerState,
        dirtySessions: input.dirtySessions,
        extractingSessions: input.extractingSessions,
        retryCount: input.retryCount,
        lastErrorCode: input.lastErrorCode ?? null,
      },
    );
    return { ok: true, serverTime: new Date().toISOString() };
  });
}
