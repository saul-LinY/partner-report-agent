import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSecret, saveConfig, saveSecret } from "./config.js";
import { authenticatedRequest } from "./http.js";

describe.sequential("authenticatedRequest", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(resolve(tmpdir(), "partner-report-http-test-"));
    process.env.PARTNER_REPORT_DATA = directory;
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS = "1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PARTNER_REPORT_DATA;
    delete process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS;
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
});
