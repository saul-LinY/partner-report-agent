import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  collectionStatusSchema,
  connectivityTestSchema,
  heartbeatSchema,
  pluginDiagnosticBatchSchema,
} from "@partner-report/contracts";
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
import {
  CONNECTIVITY_CAPABILITY_VERSION,
  CONNECTIVITY_CHALLENGE_TTL_MS,
  connectivityErrorMessage,
  diagnosticErrorMessage,
  validateConnectivityAttempt,
} from "../connectivity.js";
import {
  beginProjectScopeBootstrap,
  decideProjectScopes,
  loadProjectScopePolicy,
  registerProjectScopeCandidates,
} from "../project-scope.js";
import {
  loadProjectDescriptionState,
  registerProjectDescriptionCandidate,
} from "../project-description.js";

const deviceStartSchema = z.object({
  deviceName: z.string().min(1).max(120),
  pluginVersion: z.string().min(1).max(40),
});

const recoveryStartSchema = deviceStartSchema.extend({
  pluginInstanceId: z.string().uuid(),
  deviceCode: z.string().min(20).max(512),
});

const automaticRecoverySchema = deviceStartSchema.extend({
  pluginInstanceId: z.string().uuid(),
});

const deviceTokenSchema = z.object({ deviceCode: z.string().min(20) });
const refreshSchema = z.object({ refreshToken: z.string().min(20) });
const claimSchema = z.object({
  bindingCode: z.string().min(8).max(80),
  deviceName: z.string().min(1).max(120),
  pluginVersion: z.string().min(1).max(40),
});

function accessExpiry() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

function issueConnectivityChallenge() {
  const challenge = randomToken();
  return {
    challenge,
    challengeHash: sha256(challenge),
    challengeExpiresAt: new Date(Date.now() + CONNECTIVITY_CHALLENGE_TTL_MS),
  };
}

async function recordConnectivityFailure(
  actor: Awaited<ReturnType<typeof requirePluginActor>>,
  requestId: string,
  code: string,
) {
  const status = code === "CHALLENGE_EXPIRED" ? "expired" : "failed";
  const message = connectivityErrorMessage(code);
  await sql.begin(async (tx) => {
    await tx`
      update plugin_instances set
        connectivity_status = ${status}, last_connectivity_attempt_at = now(),
        last_connectivity_error_code = ${code}, last_connectivity_error_at = now(),
        last_connectivity_request_id = ${requestId}, updated_at = now()
      where id = ${actor.pluginInstanceId} and tenant_id = ${actor.tenantId}
    `;
    await tx`
      insert into plugin_diagnostic_events (
        id, tenant_id, team_id, partner_id, plugin_instance_id, stage,
        error_code, occurred_at, retryable, request_id, safe_message
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
        ${actor.pluginInstanceId}, 'connectivity', ${code}, now(), true,
        ${requestId}, ${message}
      )
    `;
  });
}

export async function pluginRoutes(app: FastifyInstance) {
  app.post("/v1/plugin-bindings/claim", async (request) => {
    const input = claimSchema.parse(request.body);
    const normalizedCode = input.bindingCode.trim().toUpperCase();
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const newPluginInstanceId = randomUUID();
    const expiresAt = accessExpiry();
    const connectivity = issueConnectivityChallenge();

    const binding = await sql.begin(async (tx) => {
      const rows = await tx<any[]>`
        select * from plugin_binding_codes
        where code_hash = ${sha256(normalizedCode)}
          and status in ('active', 'connecting')
        for update
      `;
      const row = rows[0];
      if (!row) return null;
      await tx`
        select id from partners
        where id = ${row.partner_id} and tenant_id = ${row.tenant_id}
          and team_id = ${row.team_id}
        for update
      `;
      const explicitRecoveryInstanceId = row.plugin_instance_id as
        string | null;
      const activeInstances = await tx<{ id: string }[]>`
        select id from plugin_instances
        where tenant_id = ${row.tenant_id} and team_id = ${row.team_id}
          and partner_id = ${row.partner_id} and status = 'active'
        order by
          (last_sync_at is not null) desc,
          last_sync_at desc nulls last,
          connectivity_verified_at desc nulls last,
          created_at desc
      `;
      if (
        explicitRecoveryInstanceId &&
        !activeInstances.some(
          (instance) => instance.id === explicitRecoveryInstanceId,
        )
      ) {
        return null;
      }
      const reusableInstanceId =
        explicitRecoveryInstanceId ?? activeInstances[0]?.id ?? null;
      let pluginInstanceId: string = newPluginInstanceId;
      if (reusableInstanceId) {
        await tx`
          update plugin_instances set
            status = 'revoked', access_expires_at = now(),
            connectivity_status = 'expired',
            connectivity_challenge_hash = null,
            connectivity_challenge_expires_at = null,
            updated_at = now()
          where tenant_id = ${row.tenant_id} and team_id = ${row.team_id}
            and partner_id = ${row.partner_id} and status = 'active'
            and id <> ${reusableInstanceId}
        `;
        const recovered = await tx<{ id: string }[]>`
          update plugin_instances set
            device_name = ${input.deviceName}, version = ${input.pluginVersion},
            access_token_hash = ${sha256(accessToken)},
            refresh_token_hash = ${sha256(refreshToken)},
            access_expires_at = ${expiresAt.toISOString()},
            connectivity_status = 'pending',
            connectivity_challenge_hash = ${connectivity.challengeHash},
            connectivity_challenge_expires_at = ${connectivity.challengeExpiresAt.toISOString()},
            connectivity_challenge_consumed_at = null,
            last_connectivity_error_code = null, last_connectivity_error_at = null,
            last_error_code = null, retry_count = 0, updated_at = now()
          where id = ${reusableInstanceId} and tenant_id = ${row.tenant_id}
            and team_id = ${row.team_id} and partner_id = ${row.partner_id}
            and status = 'active'
          returning id
        `;
        if (!recovered[0]) return null;
        pluginInstanceId = recovered[0].id;
      } else {
        await tx`
          insert into plugin_instances (
            id, tenant_id, team_id, partner_id, device_name, version,
            access_token_hash, refresh_token_hash, access_expires_at,
            connectivity_status, connectivity_challenge_hash,
            connectivity_challenge_expires_at
          ) values (
            ${pluginInstanceId}, ${row.tenant_id}, ${row.team_id}, ${row.partner_id},
            ${input.deviceName}, ${input.pluginVersion}, ${sha256(accessToken)},
            ${sha256(refreshToken)}, ${expiresAt.toISOString()}, 'pending',
            ${connectivity.challengeHash}, ${connectivity.challengeExpiresAt.toISOString()}
          )
        `;
      }
      await tx`
        update plugin_binding_codes set status = 'connecting',
          plugin_instance_id = ${pluginInstanceId}, claimed_at = null,
          last_used_at = now(), updated_at = now()
        where id = ${row.id}
      `;
      if (reusableInstanceId) {
        await tx`
          update plugin_binding_codes set status = 'revoked', updated_at = now()
          where plugin_instance_id = ${reusableInstanceId}
            and status in ('active', 'connecting')
            and id <> ${row.id}
        `;
      }
      await tx`
        insert into audit_events (
          id, tenant_id, team_id, actor_type, actor_id, action,
          target_type, target_id, request_id, metadata
        ) values (
          ${randomUUID()}, ${row.tenant_id}, ${row.team_id}, 'plugin', ${pluginInstanceId},
          ${reusableInstanceId ? "plugin.binding.recovery_started" : "plugin.binding.connection_started"},
          'plugin_binding_code', ${row.id}, ${request.id},
          ${JSON.stringify({ deviceName: input.deviceName, pluginVersion: input.pluginVersion })}::jsonb
        )
      `;
      return { row, pluginInstanceId };
    });
    if (!binding)
      throw new ApiError(400, "BINDING_CODE_INVALID", "绑定码无效或已使用。");
    return {
      accessToken,
      refreshToken,
      expiresAt,
      pluginInstanceId: binding.pluginInstanceId,
      partnerId: binding.row.partner_id,
      challenge: connectivity.challenge,
      challengeExpiresAt: connectivity.challengeExpiresAt,
      connectivityStatus: "pending",
      bindingStatus: "connecting",
      capabilityVersion: CONNECTIVITY_CAPABILITY_VERSION,
    };
  });

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
      verificationUri: `${process.env.WEB_ORIGIN ?? "http://172.20.10.14:4311"}/connect-plugin?code=${code}`,
      expiresAt,
      intervalSeconds: 3,
    };
  });

  app.post("/v1/plugin-bindings/recovery-authorizations", async (request) => {
    const input = recoveryStartSchema.parse(request.body);
    const deviceCodeHash = sha256(input.deviceCode);
    const existing = await sql<any[]>`
        select id, status, expires_at from plugin_device_authorizations
        where device_code_hash = ${deviceCodeHash}
          and plugin_instance_id = ${input.pluginInstanceId}
          and status in ('pending', 'approved') and expires_at > now()
        limit 1
      `;
    if (existing[0]) {
      return {
        status: existing[0].status ?? "pending",
        expiresAt: existing[0].expires_at,
      };
    }

    const id = randomUUID();
    const code = userCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const created = await sql.begin(async (tx) => {
      const plugins = await tx<any[]>`
          select pi.id, pi.tenant_id, pi.team_id, pi.partner_id
          from plugin_instances pi
          where pi.id = ${input.pluginInstanceId} and pi.status = 'active'
            and pi.device_name = ${input.deviceName}
          limit 1
          for update of pi
        `;
      const plugin = plugins[0];
      if (!plugin) return false;
      const pending = await tx<Array<{ id: string }>>`
          select id from plugin_device_authorizations
          where plugin_instance_id = ${input.pluginInstanceId}
            and status in ('pending', 'approved') and expires_at > now()
          limit 1
          for update
        `;
      if (pending[0]) return "already_pending" as const;
      await tx`
          insert into plugin_device_authorizations (
            id, device_code_hash, user_code, device_name, plugin_version,
            tenant_id, team_id, partner_id, plugin_instance_id, expires_at
          ) values (
            ${id}, ${deviceCodeHash}, ${code}, ${input.deviceName},
            ${input.pluginVersion}, ${plugin.tenant_id}, ${plugin.team_id},
            ${plugin.partner_id}, ${input.pluginInstanceId}, ${expiresAt.toISOString()}
          )
        `;
      await tx`
          insert into outbox_events (
            id, tenant_id, event_type, aggregate_type, aggregate_id, payload
          ) values (
            ${randomUUID()}, ${plugin.tenant_id},
            'plugin.binding.recovery.requested', 'device_authorization', ${id},
            ${JSON.stringify({
              teamId: plugin.team_id,
              partnerId: plugin.partner_id,
              pluginInstanceId: input.pluginInstanceId,
              deviceName: input.deviceName,
              expiresAt: expiresAt.toISOString(),
            })}::jsonb
          )
        `;
      return "created" as const;
    });
    if (created === "already_pending")
      throw new ApiError(
        409,
        "PLUGIN_RECOVERY_ALREADY_PENDING",
        "连接恢复申请已经存在，请在飞书中确认。",
      );
    if (created !== "created")
      throw new ApiError(
        404,
        "PLUGIN_RECOVERY_NOT_AVAILABLE",
        "当前插件连接无法恢复。",
      );
    return { status: "pending", expiresAt };
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
      const newPluginInstanceId = randomUUID();
      const expiresAt = accessExpiry();
      const connectivity = issueConnectivityChallenge();
      const pluginInstanceId = await sql.begin(async (tx) => {
        const claimed = await tx<any[]>`
          update plugin_device_authorizations set status = 'consumed', consumed_at = now()
          where id = ${authorization.id} and status = 'approved'
            and consumed_at is null and expires_at > now()
          returning *
        `;
        const current = claimed[0];
        if (!current) return null;
        const recoveryInstanceId = current.plugin_instance_id as string | null;
        let activatedInstanceId: string = newPluginInstanceId;
        if (recoveryInstanceId) {
          const recovered = await tx<{ id: string }[]>`
            update plugin_instances set
              device_name = ${current.device_name}, version = ${current.plugin_version},
              access_token_hash = ${sha256(accessToken)},
              refresh_token_hash = ${sha256(refreshToken)},
              access_expires_at = ${expiresAt.toISOString()},
              connectivity_status = 'pending',
              connectivity_challenge_hash = ${connectivity.challengeHash},
              connectivity_challenge_expires_at = ${connectivity.challengeExpiresAt.toISOString()},
              connectivity_challenge_consumed_at = null,
              last_connectivity_error_code = null, last_connectivity_error_at = null,
              last_error_code = null, retry_count = 0, updated_at = now()
            where id = ${recoveryInstanceId} and tenant_id = ${current.tenant_id}
              and team_id = ${current.team_id} and partner_id = ${current.partner_id}
              and status = 'active'
            returning id
          `;
          if (!recovered[0])
            throw new ApiError(
              409,
              "PLUGIN_RECOVERY_NOT_AVAILABLE",
              "原插件连接已失效，无法恢复。",
            );
          activatedInstanceId = recovered[0].id;
        } else {
          await tx`
            insert into plugin_instances (
              id, tenant_id, team_id, partner_id, device_name, version,
              access_token_hash, refresh_token_hash, access_expires_at,
              connectivity_status, connectivity_challenge_hash,
              connectivity_challenge_expires_at
            ) values (
              ${activatedInstanceId}, ${current.tenant_id}, ${current.team_id}, ${current.partner_id},
              ${current.device_name}, ${current.plugin_version}, ${sha256(accessToken)},
              ${sha256(refreshToken)}, ${expiresAt.toISOString()}, 'pending',
              ${connectivity.challengeHash}, ${connectivity.challengeExpiresAt.toISOString()}
            )
          `;
        }
        await tx`
        insert into audit_events (
          id, tenant_id, team_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata
        ) values (
          ${randomUUID()}, ${current.tenant_id}, ${current.team_id}, 'plugin', ${activatedInstanceId},
          ${recoveryInstanceId ? "plugin.binding.recovered" : "plugin.binding.activated"},
          'plugin_instance', ${activatedInstanceId}, ${request.id}, '{}'::jsonb
        )
      `;
        return activatedInstanceId;
      });
      if (!pluginInstanceId)
        throw new ApiError(409, "DEVICE_CODE_CONSUMED", "设备授权已使用。");
      return {
        accessToken,
        refreshToken,
        expiresAt,
        pluginInstanceId,
        challenge: connectivity.challenge,
        challengeExpiresAt: connectivity.challengeExpiresAt,
        connectivityStatus: "pending",
        capabilityVersion: CONNECTIVITY_CAPABILITY_VERSION,
      };
    },
  );

  app.post("/v1/plugin-bindings/refresh", async (request) => {
    const input = refreshSchema.parse(request.body);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = accessExpiry();
    const rows = await sql<{ id: string }[]>`
      update plugin_instances set
        access_token_hash = ${sha256(accessToken)}, refresh_token_hash = ${sha256(refreshToken)},
        access_expires_at = ${expiresAt.toISOString()}, updated_at = now()
      where refresh_token_hash = ${sha256(input.refreshToken)} and status = 'active'
      returning id
    `;
    const plugin = rows[0];
    if (!plugin)
      throw new ApiError(
        401,
        "REFRESH_TOKEN_INVALID",
        "Refresh Token 无效或已轮换。",
      );
    return {
      accessToken,
      refreshToken,
      expiresAt,
      pluginInstanceId: plugin.id,
    };
  });

  app.post("/v1/plugin-bindings/automatic-recovery", async (request) => {
    const input = automaticRecoverySchema.parse(request.body);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = accessExpiry();
    const verifiedAt = new Date();
    const plugin = await sql.begin(async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          tenant_id: string;
          team_id: string;
          partner_id: string;
        }>
      >`
        update plugin_instances set
          version = ${input.pluginVersion},
          access_token_hash = ${sha256(accessToken)},
          refresh_token_hash = ${sha256(refreshToken)},
          access_expires_at = ${expiresAt.toISOString()},
          connectivity_status = 'verified',
          connectivity_verified_at = ${verifiedAt.toISOString()},
          last_connectivity_attempt_at = ${verifiedAt.toISOString()},
          connectivity_challenge_hash = null,
          connectivity_challenge_expires_at = null,
          connectivity_challenge_consumed_at = null,
          last_connectivity_error_code = null,
          last_connectivity_error_at = null,
          last_error_code = null,
          retry_count = 0,
          updated_at = now()
        where id = ${input.pluginInstanceId}
          and device_name = ${input.deviceName}
          and status = 'active'
        returning id, tenant_id, team_id, partner_id
      `;
      const recovered = rows[0];
      if (!recovered) return null;
      await tx`
        insert into audit_events (
          id, tenant_id, team_id, actor_type, actor_id, action,
          target_type, target_id, request_id, metadata
        ) values (
          ${randomUUID()}, ${recovered.tenant_id}, ${recovered.team_id},
          'plugin', ${recovered.id}, 'plugin.binding.automatically_recovered',
          'plugin_instance', ${recovered.id}, ${request.id},
          ${JSON.stringify({ pluginVersion: input.pluginVersion })}::jsonb
        )
      `;
      return recovered;
    });
    if (!plugin)
      throw new ApiError(
        409,
        "PLUGIN_AUTOMATIC_RECOVERY_NOT_AVAILABLE",
        "当前插件实例未启用或设备信息不匹配，请重新绑定。",
      );
    return {
      accessToken,
      refreshToken,
      expiresAt,
      pluginInstanceId: plugin.id,
      connectivityStatus: "verified",
      verifiedAt,
    };
  });

  app.get("/v1/plugin-bindings/me", async (request) => {
    const actor = await requirePluginActor(request);
    const [teamRows, projectRows, periodRows, bindingRows] = await Promise.all([
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
      sql<Array<{ status: string }>>`
        select status from plugin_binding_codes
        where plugin_instance_id = ${actor.pluginInstanceId}
          and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and partner_id = ${actor.partnerId}
        order by updated_at desc limit 1
      `,
    ]);
    return {
      pluginInstanceId: actor.pluginInstanceId,
      partnerId: actor.partnerId,
      bindingStatus: bindingRows[0]?.status ?? "untracked",
      bindingCompleted: bindingRows[0]?.status === "claimed",
      team: teamRows[0],
      projects: projectRows,
      currentPeriod: periodRows[0],
      schemaVersions: ["1.0"],
      serverTime: new Date().toISOString(),
    };
  });

  app.get("/v1/project-scope", async (request) => {
    const actor = await requirePluginActor(request);
    return loadProjectScopePolicy(actor);
  });

  app.post("/v1/project-descriptions/state", async (request) => {
    const actor = await requirePluginActor(request);
    return loadProjectDescriptionState(actor, request.body);
  });

  app.post("/v1/project-descriptions/candidates", async (request) => {
    const actor = await requirePluginActor(request);
    const result = await registerProjectDescriptionCandidate(
      actor,
      request.body,
    );
    await audit(
      request,
      actor,
      "project_description.candidate_registered",
      "project_description_candidate",
      result.candidateId,
    );
    return result;
  });

  app.post("/v1/project-scope/candidates", async (request) => {
    const actor = await requirePluginActor(request);
    const policy = await registerProjectScopeCandidates(actor, request.body);
    await audit(
      request,
      actor,
      "project_scope.candidates_registered",
      "plugin_instance",
      actor.pluginInstanceId,
      {
        candidateCount: policy.entries.length,
        version: policy.version,
      },
    );
    return policy;
  });

  app.post("/v1/project-scope/remind", async (request) => {
    const actor = await requirePluginActor(request);
    const input = z
      .object({ periodKey: z.string().trim().min(1).max(40) })
      .parse(request.body);
    const policies = await sql<
      Array<{ version: number; initialized: boolean; pending_count: number }>
    >`
      select psp.version, psp.initialized,
        count(pse.id)::int as pending_count
      from project_scope_policies psp
      left join project_scope_entries pse
        on pse.plugin_instance_id = psp.plugin_instance_id
        and pse.tenant_id = psp.tenant_id and pse.status = 'pending'
      where psp.plugin_instance_id = ${actor.pluginInstanceId}
        and psp.tenant_id = ${actor.tenantId}
        and psp.team_id = ${actor.teamId}
        and psp.partner_id = ${actor.partnerId}
      group by psp.version, psp.initialized
      limit 1
    `;
    const policy = policies[0];
    const reminded = Boolean(
      policy && !policy.initialized && policy.pending_count > 0,
    );
    if (reminded) {
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${randomUUID()}, ${actor.tenantId}, 'project_scope.delivery.requested',
          'plugin_instance', ${actor.pluginInstanceId},
          ${JSON.stringify({
            teamId: actor.teamId,
            partnerId: actor.partnerId,
            pluginInstanceId: actor.pluginInstanceId,
            periodKey: input.periodKey,
            version: policy?.version,
          })}::jsonb
        )
      `;
    }
    return {
      reminded,
      periodKey: input.periodKey,
      policy: await loadProjectScopePolicy(actor),
    };
  });

  app.post("/v1/project-scope/bootstrap", async (request) => {
    const actor = await requirePluginActor(request);
    const reason =
      request.body &&
      typeof request.body === "object" &&
      "reason" in request.body
        ? request.body.reason
        : null;
    const policy = await beginProjectScopeBootstrap(actor, request.body);
    await audit(
      request,
      actor,
      "project_scope.bootstrap_started",
      "plugin_instance",
      actor.pluginInstanceId,
      { reason, version: policy.version },
    );
    return policy;
  });

  app.patch("/v1/project-scope", async (request) => {
    const actor = await requirePluginActor(request);
    const policy = await decideProjectScopes(
      actor,
      actor.pluginInstanceId,
      request.body,
    );
    await audit(
      request,
      actor,
      "project_scope.changed",
      "plugin_instance",
      actor.pluginInstanceId,
      { version: policy.version },
    );
    return policy;
  });

  app.post(
    "/v1/plugin-instances/me/connectivity-challenge",
    async (request) => {
      const actor = await requirePluginActor(request);
      const connectivity = issueConnectivityChallenge();
      await sql`
        update plugin_instances set
          connectivity_status = 'pending',
          connectivity_challenge_hash = ${connectivity.challengeHash},
          connectivity_challenge_expires_at = ${connectivity.challengeExpiresAt.toISOString()},
          connectivity_challenge_consumed_at = null,
          updated_at = now()
        where id = ${actor.pluginInstanceId} and tenant_id = ${actor.tenantId}
      `;
      await audit(
        request,
        actor,
        "plugin.connectivity.challenge_issued",
        "plugin_instance",
        actor.pluginInstanceId,
      );
      return {
        challenge: connectivity.challenge,
        challengeExpiresAt: connectivity.challengeExpiresAt,
        capabilityVersion: CONNECTIVITY_CAPABILITY_VERSION,
      };
    },
  );

  app.post("/v1/plugin-instances/me/connectivity-test", async (request) => {
    const actor = await requirePluginActor(request);
    const parsed = connectivityTestSchema.safeParse(request.body);
    if (!parsed.success) {
      await recordConnectivityFailure(actor, request.id, "REQUEST_INVALID");
      throw new ApiError(
        400,
        "REQUEST_INVALID",
        connectivityErrorMessage("REQUEST_INVALID"),
      );
    }
    const input = parsed.data as {
      challenge: string;
      pluginVersion: string;
      clientTime: string;
      capabilityVersion: string;
    };
    const rows = await sql<any[]>`
        select
          pi.version, pi.connectivity_status as "connectivityStatus",
          pi.connectivity_challenge_hash as "connectivityChallengeHash",
          pi.connectivity_challenge_expires_at as "connectivityChallengeExpiresAt",
          pi.connectivity_challenge_consumed_at as "connectivityChallengeConsumedAt",
          t.minimum_plugin_version as "minimumPluginVersion"
        from plugin_instances pi
        join teams t on t.id = pi.team_id and t.tenant_id = pi.tenant_id
        where pi.id = ${actor.pluginInstanceId} and pi.tenant_id = ${actor.tenantId}
        limit 1
      `;
    const plugin = rows[0];
    const failureCode = validateConnectivityAttempt(plugin, input);
    if (failureCode) {
      await recordConnectivityFailure(actor, request.id, failureCode);
      throw new ApiError(
        failureCode === "VERSION_BLOCKED" ? 426 : 400,
        failureCode,
        connectivityErrorMessage(failureCode),
      );
    }
    const alreadyVerified = Boolean(
      plugin.connectivityChallengeConsumedAt &&
      plugin.connectivityStatus === "verified",
    );
    await sql`
        update plugin_instances set
          version = ${input.pluginVersion}, connectivity_status = 'verified',
          connectivity_verified_at = coalesce(connectivity_verified_at, now()),
          last_connectivity_attempt_at = now(),
          last_connectivity_error_code = null,
          last_connectivity_error_at = null,
          last_connectivity_request_id = ${request.id},
          connectivity_challenge_consumed_at = coalesce(connectivity_challenge_consumed_at, now()),
          updated_at = now()
        where id = ${actor.pluginInstanceId} and tenant_id = ${actor.tenantId}
      `;
    await audit(
      request,
      actor,
      "plugin.connectivity.verified",
      "plugin_instance",
      actor.pluginInstanceId,
      {
        pluginVersion: input.pluginVersion,
        capabilityVersion: input.capabilityVersion,
        alreadyVerified,
      },
    );
    return {
      ok: true,
      connectivityStatus: "verified",
      verifiedAt: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      requestId: request.id,
      alreadyVerified,
    };
  });

  app.post("/v1/plugin-instances/me/diagnostics", async (request) => {
    const actor = await requirePluginActor(request);
    const input = pluginDiagnosticBatchSchema.parse(request.body) as {
      events: Array<{
        eventId: string;
        stage: string;
        errorCode: string;
        occurredAt: string;
        retryable: boolean;
        requestId?: string;
      }>;
    };
    let accepted = 0;
    await sql.begin(async (tx) => {
      for (const event of input.events) {
        const rows = await tx`
          insert into plugin_diagnostic_events (
            id, tenant_id, team_id, partner_id, plugin_instance_id, stage,
            error_code, occurred_at, retryable, request_id, safe_message
          ) values (
            ${event.eventId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
            ${actor.pluginInstanceId}, ${event.stage}, ${event.errorCode},
            ${event.occurredAt}, ${event.retryable},
            ${event.requestId ?? request.id}, ${diagnosticErrorMessage(event.errorCode)}
          ) on conflict (id) do nothing
          returning id
        `;
        accepted += rows.length;
      }
    });
    await audit(
      request,
      actor,
      "plugin.diagnostics.received",
      "plugin_instance",
      actor.pluginInstanceId,
      { accepted, submitted: input.events.length },
    );
    return { ok: true, accepted, submitted: input.events.length };
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

  app.post("/v1/plugin-instances/me/collection-status", async (request) => {
    const actor = await requirePluginActor(request);
    const input = collectionStatusSchema.parse(request.body);
    const completed = input.phase === "completed";
    if (completed && input.pendingLocalJobs > 0)
      throw new ApiError(
        409,
        "COLLECTION_NOT_DRAINED",
        "采集 Run 仍有本地任务，不能标记完成。",
      );
    const periods = await sql<{ id: string }[]>`
      select id from report_periods where tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId} and period_key = ${input.periodKey} limit 1
    `;
    await sql`
      update plugin_instances set
        version = ${input.pluginVersion}, device_name = ${input.deviceName},
        last_heartbeat_at = now(), last_scan_at = coalesce(${input.lastScanAt ?? null}, last_scan_at),
        last_sync_at = coalesce(${input.lastSyncAt ?? null}, last_sync_at),
        last_collection_started_at = case when ${input.phase} = 'started' then now() else last_collection_started_at end,
        last_collection_completed_at = case when ${completed} then now() else last_collection_completed_at end,
        last_collection_period_key = case when ${completed} then ${input.periodKey} else last_collection_period_key end,
        last_collection_session_count = case when ${completed} then ${input.sessionCount} else last_collection_session_count end,
        last_collection_fact_count = case when ${completed} then ${input.factCount} else last_collection_fact_count end,
        pending_local_jobs = ${input.pendingLocalJobs},
        runner_state = case
          when ${input.phase} = 'started' then 'working'
          when ${input.phase} = 'completed' then 'idle'
          else 'error' end,
        last_error_code = ${input.errorCode ?? null}, updated_at = now()
      where id = ${actor.pluginInstanceId} and tenant_id = ${actor.tenantId}
    `;
    if (input.coverage) {
      if (periods[0])
        await sql`
        insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
        values (${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
          ${periods[0].id}, ${JSON.stringify(input.coverage)}::jsonb)
      `;
    }
    await audit(
      request,
      actor,
      `plugin.collection.${input.phase}`,
      "plugin_instance",
      actor.pluginInstanceId,
      {
        periodKey: input.periodKey,
        sessionCount: input.sessionCount,
        factCount: input.factCount,
        errorCode: input.errorCode ?? null,
      },
    );
    return { ok: true, serverTime: new Date().toISOString() };
  });
}
