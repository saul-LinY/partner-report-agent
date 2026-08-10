import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, randomToken, requireWebActor, sha256 } from "../common.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(200)
});

const inviteAcceptSchema = z.object({
  token: z.string().min(20),
  displayName: z.string().min(1).max(120),
  password: z.string().min(12).max(200)
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/v1/auth/login", async (request, reply) => {
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

    const token = randomToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await sql`
      insert into web_sessions (id, user_id, token_hash, expires_at)
      values (${randomUUID()}, ${user.id}, ${sha256(token)}, ${expiresAt.toISOString()})
    `;
    reply.setCookie("pra_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.SESSION_COOKIE_SECURE === "true",
      path: "/",
      expires: expiresAt
    });
    return { ok: true };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = request.cookies.pra_session;
    if (token) await sql`delete from web_sessions where token_hash = ${sha256(token)}`;
    reply.clearCookie("pra_session", { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (request) => {
    const actor = await requireWebActor(request);
    const rows = await sql<{ teamName: string; partnerName: string | null }[]>`
      select t.name as "teamName", p.display_name as "partnerName"
      from teams t
      left join partners p on p.id = ${actor.partnerId}
      where t.id = ${actor.teamId} and t.tenant_id = ${actor.tenantId}
    `;
    return { ...actor, ...rows[0] };
  });

  app.post("/v1/auth/invitations/accept", async (request, reply) => {
    const input = inviteAcceptSchema.parse(request.body);
    const tokenHash = sha256(input.token);
    const rows = await sql<{
      id: string;
      tenant_id: string;
      team_id: string;
      email: string;
      roles: string[];
    }[]>`
      select id, tenant_id, team_id, email, roles
      from invitations
      where token_hash = ${tokenHash}
        and accepted_at is null
        and expires_at > now()
      limit 1
    `;
    const invitation = rows[0];
    if (!invitation) throw new ApiError(404, "INVITATION_INVALID", "邀请已失效或已使用。");

    const userId = randomUUID();
    const partnerId = invitation.roles.includes("partner") ? randomUUID() : null;
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    await sql.begin(async (tx) => {
      await tx`
        insert into users (id, email, display_name, password_hash)
        values (${userId}, ${invitation.email}, ${input.displayName}, ${passwordHash})
      `;
      if (partnerId) {
        await tx`
          insert into partners (id, tenant_id, team_id, user_id, display_name)
          values (${partnerId}, ${invitation.tenant_id}, ${invitation.team_id}, ${userId}, ${input.displayName})
        `;
      }
      await tx`
        insert into memberships (id, tenant_id, team_id, user_id, partner_id, roles)
        values (
          ${randomUUID()}, ${invitation.tenant_id}, ${invitation.team_id}, ${userId}, ${partnerId},
          ${JSON.stringify(invitation.roles)}::jsonb
        )
      `;
      await tx`
        insert into external_identities (id, tenant_id, user_id, provider, external_subject)
        values (${randomUUID()}, ${invitation.tenant_id}, ${userId}, 'local', ${invitation.email})
      `;
      await tx`update invitations set accepted_at = now() where id = ${invitation.id}`;
    });

    const sessionToken = randomToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await sql`
      insert into web_sessions (id, user_id, token_hash, expires_at)
      values (${randomUUID()}, ${userId}, ${sha256(sessionToken)}, ${expiresAt.toISOString()})
    `;
    reply.setCookie("pra_session", sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.SESSION_COOKIE_SECURE === "true",
      path: "/",
      expires: expiresAt
    });
    return { ok: true };
  });
}
