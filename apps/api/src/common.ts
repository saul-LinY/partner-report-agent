import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { stableJsonHash } from "@partner-report/contracts/hash";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError } from "./api-error.js";
import { readSessionToken, SESSION_COOKIE_NAME } from "./auth-security.js";

export { stableJsonHash };
export { ApiError } from "./api-error.js";

export type DomainActor = {
  actorType: string;
  actorId: string;
  userId: string | null;
  tenantId: string;
  teamId: string;
  partnerId: string | null;
};

export type WebActor = DomainActor & {
  type: "user";
  userId: string;
  roles: string[];
  email: string;
  displayName: string;
};

export type PluginActor = DomainActor & {
  type: "plugin";
  pluginInstanceId: string;
  partnerId: string;
  userId: null;
  status: string;
  version: string;
  clientKind: "collector" | "widget";
};

export function isDevelopmentLoginEnabled(
  env: NodeJS.ProcessEnv = process.env,
) {
  return (
    env.NODE_ENV === "development" && env.PARTNER_REPORT_DEV_LOGIN === "true"
  );
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function userCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const left = Array.from(
    bytes.subarray(0, 4),
    (byte) => alphabet[byte % alphabet.length],
  ).join("");
  const right = Array.from(
    bytes.subarray(4),
    (byte) => alphabet[byte % alphabet.length],
  ).join("");
  return `${left}-${right}`;
}

export async function requireWebActor(
  request: FastifyRequest,
  role?: "admin" | "partner",
) {
  const token = readSessionToken(
    request.cookies[SESSION_COOKIE_NAME],
    process.env.SESSION_SECRET?.trim(),
  );
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");

  const rows = await sql<WebActor[]>`
    select
      'user' as type,
      'user' as "actorType",
      u.id as "actorId",
      u.id as "userId",
      m.tenant_id as "tenantId",
      m.team_id as "teamId",
      m.partner_id as "partnerId",
      m.roles,
      u.email,
      u.display_name as "displayName"
    from web_sessions s
    join users u on u.id = s.user_id
    join memberships m on m.user_id = u.id
    where s.token_hash = ${sha256(token)}
      and s.expires_at > now()
      and u.status = 'active'
    order by m.created_at asc
    limit 1
  `;
  const actor = rows[0];
  if (!actor)
    throw new ApiError(401, "UNAUTHENTICATED", "登录已过期，请重新登录。");
  if (role && !actor.roles.includes(role)) {
    if (!(role === "partner" && actor.roles.includes("admin"))) {
      throw new ApiError(403, "FORBIDDEN", "当前账号没有此操作权限。");
    }
  }

  if (role === "partner" && actor.roles.includes("admin")) {
    const simulatedPartnerId = request.headers["x-partner-id"];
    if (typeof simulatedPartnerId === "string" && simulatedPartnerId) {
      const partners = await sql<{ id: string }[]>`
        select id from partners
        where id = ${simulatedPartnerId} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and status = 'active'
        limit 1
      `;
      if (!partners[0]) {
        throw new ApiError(
          403,
          "PARTNER_SCOPE_INVALID",
          "模拟审核的 Partner 不属于当前 Team。",
        );
      }
      actor.partnerId = partners[0].id;
    }
  }

  await sql`update web_sessions set last_seen_at = now() where token_hash = ${sha256(token)}`;
  return actor;
}

export async function requirePluginActor(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHENTICATED", "缺少 Plugin Access Token。");
  }
  const token = authorization.slice("Bearer ".length);
  const rows = await sql<PluginActor[]>`
    select
      'plugin' as type,
      'plugin' as "actorType",
      id as "actorId",
      null::uuid as "userId",
      id as "pluginInstanceId",
      tenant_id as "tenantId",
      team_id as "teamId",
      partner_id as "partnerId",
      status,
      version,
      client_kind as "clientKind"
    from plugin_instances
    where access_token_hash = ${sha256(token)}
      and access_expires_at > now()
    limit 1
  `;
  const actor = rows[0];
  if (!actor || actor.status !== "active") {
    throw new ApiError(
      401,
      "PLUGIN_BINDING_INVALID",
      "Plugin 绑定已过期或被撤销。",
    );
  }
  return actor;
}

export async function audit(
  request: FastifyRequest,
  actor: DomainActor,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) {
  return auditWithRequestId(
    request.id,
    actor,
    action,
    targetType,
    targetId,
    metadata,
  );
}

export async function auditWithRequestId(
  requestId: string,
  actor: DomainActor,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) {
  await sql`
    insert into audit_events (
      id, tenant_id, team_id, actor_type, actor_id, action,
      target_type, target_id, request_id, metadata
    ) values (
      ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.actorType},
      ${actor.actorId},
      ${action}, ${targetType}, ${targetId}, ${requestId}, ${JSON.stringify(metadata)}::jsonb
    )
  `;
}
