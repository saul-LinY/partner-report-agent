import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./server.js";

describe("Google auth HTTP security", () => {
  const originalEnv = { ...process.env };
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = "client.apps.googleusercontent.com";
    process.env.GOOGLE_REDIRECT_URI =
      "https://app.example.com/auth/google/callback";
    process.env.SESSION_SECRET = "s".repeat(32);
    delete process.env.AUTH_COOKIE_SECURE;
    delete process.env.SESSION_COOKIE_SECURE;
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("returns GIS redirect configuration with state and nonce", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/google?next=%2Fadmin%2Freports",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.com",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      clientId: "client.apps.googleusercontent.com",
      loginUri: "https://app.example.com/auth/google/callback",
      state: expect.any(String),
      nonce: expect.any(String),
    });
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).toContain("SameSite=None");
    expect(response.headers["set-cookie"]).toContain("Path=/auth/google");
  });

  it("rejects invalid state and clears the transaction cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: "g_csrf_token=csrf",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload:
        "credential=not-a-real-google-id-token&g_csrf_token=csrf&state=invalid",
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("state 无效或已过期");
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("rejects unauthenticated protected pages and APIs", async () => {
    const me = await app.inject({ method: "GET", url: "/auth/me" });
    const admin = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
    });
    expect(me.statusCode).toBe(401);
    expect(admin.statusCode).toBe(401);
  });

  it("rejects a tampered signed session before database access", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: "pra_session=v1.opaque.invalid-signature" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("clears the session cookie on logout", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("pra_session=");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]).toContain("Path=/");
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });
});

describe("Google auth configuration failure", () => {
  it("returns one clear error without redirecting", async () => {
    const previous = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    const app = await buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/auth/google" });
      expect(response.statusCode).toBe(503);
      expect(response.headers.location).toBeUndefined();
      expect(response.json().message).toContain("GOOGLE_CLIENT_ID");
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = previous;
    }
  });
});
