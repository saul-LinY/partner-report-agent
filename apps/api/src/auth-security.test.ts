import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoginTicket, TokenPayload } from "google-auth-library";
import {
  decodeOAuthTransaction,
  encodeOAuthTransaction,
  loadGoogleAuthConfig,
  newOAuthTransaction,
  readSessionToken,
  safeNext,
  signSessionToken,
  verifyGoogleIdentity,
  type GoogleAuthConfig,
} from "./auth-security.js";

const now = 1_786_579_200;
const config: GoogleAuthConfig = {
  clientId: "client.apps.googleusercontent.com",
  redirectUri: "https://app.example.com/auth/google/callback",
  sessionSecret: "s".repeat(32),
  allowedDomains: new Set(),
  allowedEmails: new Set(),
};

function payload(overrides: Partial<TokenPayload> = {}): TokenPayload {
  return {
    iss: "https://accounts.google.com",
    aud: config.clientId,
    sub: "google-subject-1",
    email: "user@example.com",
    email_verified: true,
    name: "Example User",
    nonce: "expected-nonce",
    iat: now - 30,
    exp: now + 300,
    ...overrides,
  };
}

function client(claims: TokenPayload, rejects = false) {
  return {
    verifyIdToken: vi.fn(async () => {
      if (rejects) throw new Error("signature rejected");
      return { getPayload: () => claims } as LoginTicket;
    }),
  };
}

describe("Google OIDC security", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a fully verified Google identity", async () => {
    await expect(
      verifyGoogleIdentity(
        client(payload()),
        "id-token",
        config,
        "expected-nonce",
        now,
      ),
    ).resolves.toEqual({
      subject: "google-subject-1",
      email: "user@example.com",
      displayName: "Example User",
      hostedDomain: null,
    });
  });

  it("rejects a token whose signature verification fails", async () => {
    await expect(
      verifyGoogleIdentity(
        client(payload(), true),
        "bad-token",
        config,
        "expected-nonce",
        now,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_TOKEN_INVALID" });
  });

  it.each([
    ["expired token", { exp: now - 1 }, "GOOGLE_TOKEN_INVALID"],
    ["wrong audience", { aud: "other-client" }, "GOOGLE_TOKEN_INVALID"],
    ["wrong issuer", { iss: "https://issuer.invalid" }, "GOOGLE_TOKEN_INVALID"],
    ["future issued-at", { iat: now + 120 }, "GOOGLE_TOKEN_INVALID"],
    ["stale issued-at", { iat: now - 7_201 }, "GOOGLE_TOKEN_INVALID"],
    ["unverified email", { email_verified: false }, "GOOGLE_EMAIL_UNVERIFIED"],
    ["missing email", { email: undefined }, "GOOGLE_IDENTITY_INCOMPLETE"],
    ["missing subject", { sub: undefined }, "GOOGLE_IDENTITY_INCOMPLETE"],
  ])("rejects %s", async (_name, overrides, code) => {
    await expect(
      verifyGoogleIdentity(
        client(payload(overrides as Partial<TokenPayload>)),
        "id-token",
        config,
        "expected-nonce",
        now,
      ),
    ).rejects.toMatchObject({ code });
  });

  it("rejects an invalid nonce", async () => {
    await expect(
      verifyGoogleIdentity(
        client(payload({ nonce: "other" })),
        "id-token",
        config,
        "expected-nonce",
        now,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_NONCE_INVALID" });
  });

  it("enforces allowed domains using both email domain and hd", async () => {
    const restricted = { ...config, allowedDomains: new Set(["company.com"]) };
    await expect(
      verifyGoogleIdentity(
        client(payload({ email: "user@company.com", hd: "other.com" })),
        "id-token",
        restricted,
        "expected-nonce",
        now,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_ACCOUNT_NOT_ALLOWED" });
    await expect(
      verifyGoogleIdentity(
        client(payload({ email: "user@company.com", hd: "company.com" })),
        "id-token",
        restricted,
        "expected-nonce",
        now,
      ),
    ).resolves.toMatchObject({ email: "user@company.com" });
  });

  it("allows an explicit email when domain restrictions do not match", async () => {
    const restricted = {
      ...config,
      allowedDomains: new Set(["company.com"]),
      allowedEmails: new Set(["guest@example.com"]),
    };
    await expect(
      verifyGoogleIdentity(
        client(payload({ email: "guest@example.com" })),
        "id-token",
        restricted,
        "expected-nonce",
        now,
      ),
    ).resolves.toMatchObject({ email: "guest@example.com" });
  });
});

describe("OAuth transaction and session integrity", () => {
  it("preserves a safe local destination and rejects external next values", () => {
    expect(safeNext("/admin/reports?period=1#latest")).toBe(
      "/admin/reports?period=1#latest",
    );
    expect(safeNext("https://evil.example/path")).toBe("/admin");
    expect(safeNext("//evil.example/path")).toBe("/admin");
    expect(safeNext("/\\evil.example/path")).toBe("/admin");
  });

  it("rejects invalid state through a tampered transaction cookie", () => {
    const transaction = newOAuthTransaction("/admin/reports");
    const encoded = encodeOAuthTransaction(transaction, config.sessionSecret);
    expect(decodeOAuthTransaction(encoded, config.sessionSecret)).toMatchObject(
      transaction,
    );
    expect(
      decodeOAuthTransaction(`${encoded.slice(0, -1)}x`, config.sessionSecret),
    ).toBeNull();
  });

  it("rejects an expired OAuth transaction", () => {
    const transaction = { ...newOAuthTransaction("/admin"), expiresAt: now };
    const encoded = encodeOAuthTransaction(transaction, config.sessionSecret);
    expect(
      decodeOAuthTransaction(encoded, config.sessionSecret, now + 1),
    ).toBeNull();
  });

  it("accepts a signed session and rejects a tampered signed session", () => {
    const signed = signSessionToken("opaque-session", config.sessionSecret);
    expect(readSessionToken(signed, config.sessionSecret)).toBe(
      "opaque-session",
    );
    expect(
      readSessionToken(`${signed.slice(0, -1)}x`, config.sessionSecret),
    ).toBeNull();
  });
});

describe("Google auth configuration", () => {
  it("reports missing configuration clearly", () => {
    expect(() => loadGoogleAuthConfig({})).toThrowError(
      /Google 登录尚未正确配置/,
    );
  });

  it("parses optional email and domain restrictions", () => {
    const loaded = loadGoogleAuthConfig({
      GOOGLE_CLIENT_ID: config.clientId,
      GOOGLE_REDIRECT_URI: config.redirectUri,
      SESSION_SECRET: config.sessionSecret,
      GOOGLE_ALLOWED_DOMAIN: "@Company.com, subsidiary.com",
      GOOGLE_ALLOWED_EMAILS: "Admin@Example.com",
    });
    expect(loaded.allowedDomains).toEqual(
      new Set(["company.com", "subsidiary.com"]),
    );
    expect(loaded.allowedEmails).toEqual(new Set(["admin@example.com"]));
  });

  it("does not require a Google client secret", () => {
    const loaded = loadGoogleAuthConfig({
      GOOGLE_CLIENT_ID: config.clientId,
      GOOGLE_REDIRECT_URI: config.redirectUri,
      SESSION_SECRET: config.sessionSecret,
    });
    expect(loaded.clientId).toBe(config.clientId);
  });

  it("allows HTTP only for localhost development", () => {
    expect(() =>
      loadGoogleAuthConfig({
        GOOGLE_CLIENT_ID: config.clientId,
        GOOGLE_REDIRECT_URI: "http://172.20.10.14:4310/auth/google/callback",
        SESSION_SECRET: config.sessionSecret,
      }),
    ).toThrowError(/本地开发仅允许 http:\/\/localhost/);
    expect(
      loadGoogleAuthConfig({
        GOOGLE_CLIENT_ID: config.clientId,
        GOOGLE_REDIRECT_URI: "http://localhost:4310/auth/google/callback",
        SESSION_SECRET: config.sessionSecret,
      }).redirectUri,
    ).toBe("http://localhost:4310/auth/google/callback");
  });
});
