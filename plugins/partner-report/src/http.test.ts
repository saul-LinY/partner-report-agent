import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadSecret, saveConfig, saveSecret } from "./config.js";
import { authenticatedRequest } from "./http.js";

describe.sequential("authenticatedRequest", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(resolve(tmpdir(), "partner-report-http-test-"));
    process.env.PARTNER_REPORT_DATA = directory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PARTNER_REPORT_DATA;
    rmSync(directory, { recursive: true, force: true });
  });

  it("shares one token refresh across parallel first-run requests", async () => {
    const pluginInstanceId = "test-plugin-instance";
    saveConfig({
      serverUrl: "https://partner-report.test",
      pluginInstanceId,
      deviceName: "Test Mac",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      excludedSessionIds: [],
      excludedPaths: [],
    });
    saveSecret(pluginInstanceId, "access", "expired-access-token");
    saveSecret(pluginInstanceId, "refresh", "current-refresh-token");

    let refreshCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/plugin-bindings/refresh")) {
        refreshCount += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        return Response.json({
          accessToken: "next-access-token",
          refreshToken: "next-refresh-token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          pluginInstanceId,
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      authenticatedRequest("/v1/plugin-bindings/me"),
      authenticatedRequest("/v1/project-scope"),
    ]);

    expect(refreshCount).toBe(1);
    expect(loadSecret(pluginInstanceId, "access")).toBe("next-access-token");
    expect(loadSecret(pluginInstanceId, "refresh")).toBe("next-refresh-token");
  });

  it("automatically restores missing credentials once for parallel requests", async () => {
    const pluginInstanceId = "missing-credentials-instance";
    saveConfig({
      serverUrl: "https://partner-report.test",
      pluginInstanceId,
      deviceName: "Test Mac",
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      pendingAuthRecovery: {
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      pendingConnectivityChallenge: {
        value: "stale-challenge",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      excludedSessionIds: [],
      excludedPaths: [],
    });

    let recoveryCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/plugin-bindings/automatic-recovery")) {
        recoveryCount += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        return Response.json({
          accessToken: "recovered-access-token",
          refreshToken: "recovered-refresh-token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          pluginInstanceId,
          verifiedAt: new Date().toISOString(),
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      authenticatedRequest("/v1/plugin-bindings/me"),
      authenticatedRequest("/v1/project-scope"),
    ]);

    expect(recoveryCount).toBe(1);
    expect(loadSecret(pluginInstanceId, "access")).toBe(
      "recovered-access-token",
    );
    expect(loadSecret(pluginInstanceId, "refresh")).toBe(
      "recovered-refresh-token",
    );
    expect(loadConfig()).not.toHaveProperty("pendingAuthRecovery");
    expect(loadConfig()).not.toHaveProperty("pendingConnectivityChallenge");
  });

  it("automatically restores credentials when the refresh token is invalid", async () => {
    const pluginInstanceId = "invalid-refresh-instance";
    saveConfig({
      serverUrl: "https://partner-report.test",
      pluginInstanceId,
      deviceName: "Test Mac",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      excludedSessionIds: [],
      excludedPaths: [],
    });
    saveSecret(pluginInstanceId, "access", "expired-access-token");
    saveSecret(pluginInstanceId, "refresh", "invalid-refresh-token");

    const requestedPaths: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname === "/v1/plugin-bindings/refresh")
        return Response.json(
          {
            code: "REFRESH_TOKEN_INVALID",
            message: "Refresh Token 无效或已轮换。",
          },
          { status: 401 },
        );
      if (url.pathname === "/v1/plugin-bindings/automatic-recovery")
        return Response.json({
          accessToken: "recovered-access-token",
          refreshToken: "recovered-refresh-token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          pluginInstanceId,
          verifiedAt: new Date().toISOString(),
        });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await authenticatedRequest("/v1/plugin-bindings/me");

    expect(requestedPaths).toEqual([
      "/v1/plugin-bindings/refresh",
      "/v1/plugin-bindings/automatic-recovery",
      "/v1/plugin-bindings/me",
    ]);
    expect(loadSecret(pluginInstanceId, "refresh")).toBe(
      "recovered-refresh-token",
    );
  });

  it("stops before the protected request when automatic recovery is rejected", async () => {
    const pluginInstanceId = "revoked-instance";
    saveConfig({
      serverUrl: "https://partner-report.test",
      pluginInstanceId,
      deviceName: "Test Mac",
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      excludedSessionIds: [],
      excludedPaths: [],
    });

    const requestedPaths: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      return Response.json(
        {
          code: "PLUGIN_AUTOMATIC_RECOVERY_NOT_AVAILABLE",
          message: "当前插件实例未启用或设备信息不匹配，请重新绑定。",
        },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authenticatedRequest("/v1/plugin-bindings/me"),
    ).rejects.toMatchObject({
      code: "PLUGIN_AUTOMATIC_RECOVERY_NOT_AVAILABLE",
    });
    expect(requestedPaths).toEqual(["/v1/plugin-bindings/automatic-recovery"]);
  });
});
