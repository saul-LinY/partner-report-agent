import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OAuth2Client, type LoginTicket } from "google-auth-library";
import { sqlClient as sql } from "@partner-report/db";
import {
  decodeOAuthTransaction,
  OAUTH_TRANSACTION_COOKIE_NAME,
  signSessionToken,
} from "./auth-security.js";
import { buildApp } from "./server.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

function cookieValue(setCookie: string | string[] | undefined, name: string) {
  const source = Array.isArray(setCookie)
    ? setCookie.join("\n")
    : (setCookie ?? "");
  const match = source.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}

suite("Google login and session lifecycle", () => {
  const fixture = {
    tenant: randomUUID(),
    team: randomUUID(),
    admin: randomUUID(),
    adminMembership: randomUUID(),
    viewer: randomUUID(),
    viewerMembership: randomUUID(),
    expiredSession: randomUUID(),
  };
  const adminEmail = `google-admin-${fixture.admin}@example.com`;
  const viewerEmail = `google-viewer-${fixture.viewer}@example.com`;
  const expiredToken = `expired-${fixture.admin}`;
  const originalEnv = { ...process.env };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let expectedNonce = "";

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = "client.apps.googleusercontent.com";
    process.env.GOOGLE_REDIRECT_URI =
      "https://api.example.com/auth/google/callback";
    process.env.SESSION_SECRET = "integration-session-secret-1234567890";
    process.env.WEB_ORIGIN = "https://app.example.com";
    process.env.AUTH_COOKIE_SECURE = "true";
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenant}, 'Google Auth Fixture')`;
      await tx`insert into teams (id, tenant_id, name) values (${fixture.team}, ${fixture.tenant}, 'Google Auth Team')`;
      await tx`
        insert into users (id, email, display_name, password_hash)
        values
          (${fixture.admin}, ${adminEmail}, 'Google Admin', 'not-used'),
          (${fixture.viewer}, ${viewerEmail}, 'Google Viewer', 'not-used')
      `;
      await tx`
        insert into memberships (id, tenant_id, team_id, user_id, roles)
        values
          (${fixture.adminMembership}, ${fixture.tenant}, ${fixture.team}, ${fixture.admin}, '["admin"]'::jsonb),
          (${fixture.viewerMembership}, ${fixture.tenant}, ${fixture.team}, ${fixture.viewer}, '[]'::jsonb)
      `;
      await tx`
        insert into web_sessions (id, user_id, token_hash, expires_at)
        values (
          ${fixture.expiredSession}, ${fixture.admin},
          ${createHash("sha256").update(expiredToken).digest("hex")},
          ${new Date(Date.now() - 60_000).toISOString()}
        )
      `;
    });

    app = await buildApp({
      logger: false,
      auth: {
        googleClientFactory: (config) => {
          const client = new OAuth2Client({
            clientId: config.clientId,
          });
          vi.spyOn(client, "verifyIdToken").mockImplementation(
            async () =>
              ({
                getPayload: () => ({
                  iss: "https://accounts.google.com",
                  aud: config.clientId,
                  sub: `google-sub-${fixture.admin}`,
                  email: adminEmail,
                  email_verified: true,
                  name: "Google Admin",
                  nonce: expectedNonce,
                  iat: Math.floor(Date.now() / 1000) - 5,
                  exp: Math.floor(Date.now() / 1000) + 300,
                }),
              }) as LoginTicket,
          );
          return client;
        },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await sql.begin(async (tx) => {
      await tx`delete from web_sessions where user_id in (${fixture.admin}, ${fixture.viewer})`;
      await tx`delete from external_identities where user_id in (${fixture.admin}, ${fixture.viewer})`;
      await tx`delete from memberships where user_id in (${fixture.admin}, ${fixture.viewer})`;
      await tx`delete from users where id in (${fixture.admin}, ${fixture.viewer})`;
      await tx`delete from teams where id = ${fixture.team}`;
      await tx`delete from tenants where id = ${fixture.tenant}`;
    });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("logs in, binds the existing user and redirects once to the target", async () => {
    const start = await app.inject({
      method: "GET",
      url: "/auth/google?next=%2Fadmin%2Freports%3Fperiod%3Dcurrent",
    });
    expect(start.statusCode).toBe(200);
    const state = start.json().state as string;
    const transactionCookie = cookieValue(
      start.headers["set-cookie"],
      OAUTH_TRANSACTION_COOKIE_NAME,
    )!;
    const transaction = decodeOAuthTransaction(
      transactionCookie,
      process.env.SESSION_SECRET!,
    );
    expectedNonce = transaction!.nonce;

    const callback = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=${transactionCookie}; g_csrf_token=csrf-token`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        credential: "verified-google-id-token-placeholder",
        g_csrf_token: "csrf-token",
        state,
      }).toString(),
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://app.example.com/admin/reports?period=current",
    );
    const sessionCookie = cookieValue(
      callback.headers["set-cookie"],
      "pra_session",
    )!;
    const callbackCookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"].join("\n")
      : callback.headers["set-cookie"]!;
    expect(sessionCookie).toMatch(/^v1\./);
    expect(callbackCookies).toContain("HttpOnly");
    expect(callbackCookies).toContain("Secure");
    expect(callbackCookies).toContain("SameSite=Lax");

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `pra_session=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      userId: fixture.admin,
      email: adminEmail,
      roles: ["admin"],
    });
    const identities = await sql<{ count: number }[]>`
      select count(*)::int as count from external_identities
      where user_id = ${fixture.admin} and provider = 'google'
    `;
    expect(identities[0]?.count).toBe(1);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: `pra_session=${sessionCookie}` },
    });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `pra_session=${sessionCookie}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rejects a mismatched Google double-submit CSRF token", async () => {
    const start = await app.inject({
      method: "GET",
      url: "/auth/google?next=%2Fadmin",
    });
    const transactionCookie = cookieValue(
      start.headers["set-cookie"],
      OAUTH_TRANSACTION_COOKIE_NAME,
    )!;
    const response = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=${transactionCookie}; g_csrf_token=cookie-token`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        credential: "verified-google-id-token-placeholder",
        g_csrf_token: "body-token",
        state: start.json().state,
      }).toString(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("CSRF 校验失败");
  });

  it("rejects an expired database session", async () => {
    const cookie = signSessionToken(expiredToken, process.env.SESSION_SECRET);
    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `pra_session=${cookie}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("does not let a low-privilege user execute an admin operation", async () => {
    const token = `viewer-${fixture.viewer}`;
    await sql`
      insert into web_sessions (id, user_id, token_hash, expires_at)
      values (
        ${randomUUID()}, ${fixture.viewer},
        ${createHash("sha256").update(token).digest("hex")},
        ${new Date(Date.now() + 60_000).toISOString()}
      )
    `;
    const cookie = signSessionToken(token, process.env.SESSION_SECRET);
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: { cookie: `pra_session=${cookie}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
