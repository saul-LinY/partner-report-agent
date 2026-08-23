import { randomUUID, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import {
  clearOAuthTransactionCookie,
  clearSessionCookie,
  createGoogleClient,
  decodeOAuthTransaction,
  loadGoogleAuthConfig,
  loadSessionSecret,
  newOAuthTransaction,
  OAUTH_TRANSACTION_COOKIE_NAME,
  readSessionToken,
  safeNext,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  setOAuthTransactionCookie,
  setSessionCookie,
  verifyGoogleIdentity,
} from "../auth-security.js";
import {
  ApiError,
  isDevelopmentLoginEnabled,
  randomToken,
  requireWebActor,
  sha256,
} from "../common.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(200),
});

const inviteAcceptSchema = z.object({
  token: z.string().min(20),
  displayName: z.string().min(1).max(120),
  password: z.string().min(12).max(200),
});

const googleStartSchema = z.object({ next: z.string().optional() });
const googleCallbackSchema = z.object({
  credential: z.string().min(20),
  g_csrf_token: z.string().min(1),
  state: z.string().min(1),
  select_by: z.string().optional(),
  client_id: z.string().optional(),
});

function webUrl(path: string) {
  const configured = process.env.WEB_ORIGIN ?? "http://172.20.10.14:4311";
  try {
    return new URL(path, new URL(configured).origin).toString();
  } catch {
    throw new ApiError(
      503,
      "WEB_ORIGIN_INVALID",
      "WEB_ORIGIN 必须是完整的应用源地址。",
    );
  }
}

async function createWebSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) {
  loadSessionSecret();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await sql`
    insert into web_sessions (id, user_id, token_hash, expires_at)
    values (${randomUUID()}, ${userId}, ${sha256(token)}, ${expiresAt.toISOString()})
  `;
  setSessionCookie(request, reply, token, expiresAt);
}

async function currentUser(request: FastifyRequest) {
  const actor = await requireWebActor(request);
  const rows = await sql<{ teamName: string; partnerName: string | null }[]>`
    select t.name as "teamName", p.display_name as "partnerName"
    from teams t
    left join partners p on p.id = ${actor.partnerId}
    where t.id = ${actor.teamId} and t.tenant_id = ${actor.tenantId}
  `;
  return { ...actor, ...rows[0] };
}

function sameSecret(left: string | undefined, right: string) {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AuthRouteOptions = {
  googleClientFactory?: typeof createGoogleClient;
};

export async function authRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions = {},
) {
  const googleClientFactory =
    options.googleClientFactory ??
    (createGoogleClient as (
      config: ReturnType<typeof loadGoogleAuthConfig>,
    ) => OAuth2Client);
  const localLogin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.LOCAL_LOGIN_ENABLED === "false") {
      throw new ApiError(
        403,
        "LOCAL_LOGIN_DISABLED",
        "本地账号密码登录已关闭，请使用 Google 登录。",
      );
    }
    const input = loginSchema.parse(request.body);
    const rows = await sql<{ id: string; password_hash: string }[]>`
      select id, password_hash from users
      where email = ${input.email.trim().toLowerCase()} and status = 'active'
      limit 1
    `;
    const user = rows[0];
    if (!user || !(await argon2.verify(user.password_hash, input.password))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确。");
    }
    await createWebSession(request, reply, user.id);
    return { ok: true };
  };

  const developmentLogin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const preferredEmail =
      process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
    const rows = await sql<{ id: string }[]>`
      select u.id
      from users u
      join memberships m on m.user_id = u.id
      where u.status = 'active'
        and m.roles @> '["admin"]'::jsonb
      order by
        case when lower(u.email) = ${preferredEmail} then 0 else 1 end,
        m.created_at asc
      limit 1
    `;
    const admin = rows[0];
    if (!admin) {
      throw new ApiError(
        503,
        "DEV_ADMIN_NOT_FOUND",
        "数据库中没有可用于开发环境免登录的有效管理员。",
      );
    }
    await createWebSession(request, reply, admin.id);
    return { ok: true };
  };

  const logout = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = readSessionToken(
      request.cookies[SESSION_COOKIE_NAME],
      process.env.SESSION_SECRET?.trim(),
    );
    if (token) {
      await sql`delete from web_sessions where token_hash = ${sha256(token)}`;
    }
    clearSessionCookie(request, reply);
    return { ok: true };
  };

  app.get("/login", async (request, reply) => {
    const query = googleStartSchema.parse(request.query);
    return reply.redirect(
      webUrl(`/login?next=${encodeURIComponent(safeNext(query.next))}`),
    );
  });

  app.get("/auth/google", async (request, reply) => {
    const query = googleStartSchema.parse(request.query);
    const config = loadGoogleAuthConfig();
    const transaction = newOAuthTransaction(query.next);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    setOAuthTransactionCookie(
      request,
      reply,
      transaction,
      config.sessionSecret,
    );
    return {
      clientId: config.clientId,
      loginUri: config.redirectUri,
      state: transaction.state,
      nonce: transaction.nonce,
    };
  });

  app.post("/auth/google/callback", async (request, reply) => {
    const input = googleCallbackSchema.parse(request.body);
    const config = loadGoogleAuthConfig();
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    const transaction = decodeOAuthTransaction(
      request.cookies[OAUTH_TRANSACTION_COOKIE_NAME],
      config.sessionSecret,
    );
    clearOAuthTransactionCookie(request, reply);

    if (!sameSecret(request.cookies.g_csrf_token, input.g_csrf_token)) {
      throw new ApiError(
        403,
        "GOOGLE_CSRF_INVALID",
        "Google 登录 CSRF 校验失败，请重新开始登录。",
      );
    }
    if (!transaction || !sameSecret(input.state, transaction.state)) {
      throw new ApiError(
        401,
        "GOOGLE_STATE_INVALID",
        "Google 登录 state 无效或已过期，请重新开始登录。",
      );
    }
    const client = googleClientFactory(config);
    const identity = await verifyGoogleIdentity(
      client,
      input.credential,
      config,
      transaction.nonce,
    );

    const identityRows = await sql<{ user_id: string }[]>`
      select u.id as user_id
      from external_identities ei
      join users u on u.id = ei.user_id
      join memberships m on m.user_id = u.id and m.tenant_id = ei.tenant_id
      where ei.provider = 'google'
        and ei.external_subject = ${identity.subject}
        and u.status = 'active'
      order by m.created_at asc
      limit 1
    `;
    let userId = identityRows[0]?.user_id;

    if (!userId) {
      const users = await sql<{ user_id: string; tenant_id: string }[]>`
        select u.id as user_id, m.tenant_id
        from users u
        join memberships m on m.user_id = u.id
        where lower(u.email) = ${identity.email} and u.status = 'active'
        order by m.created_at asc
        limit 1
      `;
      const existing = users[0];
      if (!existing) {
        throw new ApiError(
          403,
          "GOOGLE_ACCOUNT_NOT_PROVISIONED",
          "该 Google 邮箱尚未加入任何 Team，请先联系管理员邀请。",
        );
      }
      const otherIdentity = await sql<{ external_subject: string }[]>`
        select external_subject from external_identities
        where tenant_id = ${existing.tenant_id}
          and user_id = ${existing.user_id}
          and provider = 'google'
        limit 1
      `;
      if (
        otherIdentity[0] &&
        otherIdentity[0].external_subject !== identity.subject
      ) {
        throw new ApiError(
          403,
          "GOOGLE_IDENTITY_CONFLICT",
          "该用户已绑定另一个 Google 身份。",
        );
      }
      await sql`
        insert into external_identities (
          id, tenant_id, user_id, provider, external_subject
        ) values (
          ${randomUUID()}, ${existing.tenant_id}, ${existing.user_id},
          'google', ${identity.subject}
        )
        on conflict (tenant_id, provider, external_subject) do nothing
      `;
      const bound = await sql<{ user_id: string }[]>`
        select user_id from external_identities
        where tenant_id = ${existing.tenant_id}
          and provider = 'google'
          and external_subject = ${identity.subject}
        limit 1
      `;
      if (bound[0]?.user_id !== existing.user_id) {
        throw new ApiError(
          403,
          "GOOGLE_IDENTITY_CONFLICT",
          "该 Google 身份已绑定其他用户。",
        );
      }
      userId = existing.user_id;
    }

    await createWebSession(request, reply, userId);
    return reply.redirect(webUrl(transaction.next));
  });

  app.post("/v1/auth/login", localLogin);
  if (isDevelopmentLoginEnabled()) {
    app.post("/v1/auth/dev-login", developmentLogin);
  }
  app.post("/v1/auth/logout", logout);
  app.post("/auth/logout", logout);
  app.get("/v1/me", currentUser);
  app.get("/auth/me", currentUser);

  app.post("/v1/auth/invitations/accept", async (request, reply) => {
    const input = inviteAcceptSchema.parse(request.body);
    const tokenHash = sha256(input.token);
    const rows = await sql<
      {
        id: string;
        tenant_id: string;
        team_id: string;
        email: string;
        roles: string[];
      }[]
    >`
      select id, tenant_id, team_id, email, roles
      from invitations
      where token_hash = ${tokenHash}
        and accepted_at is null
        and expires_at > now()
      limit 1
    `;
    const invitation = rows[0];
    if (!invitation) {
      throw new ApiError(404, "INVITATION_INVALID", "邀请已失效或已使用。");
    }

    const userId = randomUUID();
    const partnerId = invitation.roles.includes("partner")
      ? randomUUID()
      : null;
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });

    await sql.begin(async (tx) => {
      await tx`
        insert into users (id, email, display_name, password_hash)
        values (${userId}, ${invitation.email}, ${input.displayName}, ${passwordHash})
      `;
      if (partnerId) {
        await tx`
          insert into partners (id, tenant_id, team_id, user_id, email, display_name)
          values (
            ${partnerId}, ${invitation.tenant_id}, ${invitation.team_id},
            ${userId}, ${invitation.email}, ${input.displayName}
          )
        `;
      }
      await tx`
        insert into memberships (id, tenant_id, team_id, user_id, partner_id, roles)
        values (
          ${randomUUID()}, ${invitation.tenant_id}, ${invitation.team_id},
          ${userId}, ${partnerId}, ${JSON.stringify(invitation.roles)}::jsonb
        )
      `;
      await tx`
        insert into external_identities (
          id, tenant_id, user_id, provider, external_subject
        ) values (
          ${randomUUID()}, ${invitation.tenant_id}, ${userId}, 'local',
          ${invitation.email}
        )
      `;
      await tx`update invitations set accepted_at = now() where id = ${invitation.id}`;
    });

    await createWebSession(request, reply, userId);
    return { ok: true };
  });
}
