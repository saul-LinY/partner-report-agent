import { describe, expect, it } from "vitest";
import {
  STRUCTURED_FACT_UPLOAD_CONSENT_SCOPE,
  STRUCTURED_FACT_UPLOAD_CONSENT_VERSION,
  hasValidStructuredFactUploadConsent,
  normalizeServerUrl,
  withStructuredFactUploadConsent,
  withoutStructuredFactUploadConsent,
  type PluginConfig,
} from "./config.js";

describe("normalizeServerUrl", () => {
  it("normalizes HTTPS server URLs and preserves a base path", () => {
    expect(normalizeServerUrl(" https://reports.example.com/api/ ")).toBe(
      "https://reports.example.com/api",
    );
  });

  it("allows loopback HTTP for local development", () => {
    expect(normalizeServerUrl("http://127.0.0.1:4310/")).toBe(
      "http://127.0.0.1:4310",
    );
    expect(normalizeServerUrl("http://localhost:4310")).toBe(
      "http://localhost:4310",
    );
  });

  it("requires HTTPS for a remote server by default", () => {
    expect(() => normalizeServerUrl("http://reports.example.com:4310")).toThrow(
      "必须使用 HTTPS",
    );
    expect(normalizeServerUrl("http://reports.example.com:4310", true)).toBe(
      "http://reports.example.com:4310",
    );
  });

  it("rejects credentials, query strings, and unsupported protocols", () => {
    expect(() =>
      normalizeServerUrl("https://user:pass@reports.example.com"),
    ).toThrow("用户名或密码");
    expect(() =>
      normalizeServerUrl("https://reports.example.com?token=value"),
    ).toThrow("查询参数或锚点");
    expect(() => normalizeServerUrl("file:///tmp/server")).toThrow("只支持");
  });
});

describe("structured fact upload consent", () => {
  const config: PluginConfig = {
    serverUrl: "https://reports.example.com",
    pluginInstanceId: "instance-1",
    deviceName: "Test Mac",
    accessExpiresAt: "2026-08-04T01:00:00.000Z",
    excludedSessionIds: [],
    excludedPaths: [],
  };

  it("binds consent to the current endpoint and plugin instance", () => {
    const granted = withStructuredFactUploadConsent(
      config,
      "2026-08-04T00:00:00.000Z",
    );

    expect(hasValidStructuredFactUploadConsent(granted)).toBe(true);
    expect(granted.structuredFactUploadConsent).toEqual({
      version: STRUCTURED_FACT_UPLOAD_CONSENT_VERSION,
      scope: STRUCTURED_FACT_UPLOAD_CONSENT_SCOPE,
      grantedAt: "2026-08-04T00:00:00.000Z",
      serverUrl: config.serverUrl,
      pluginInstanceId: config.pluginInstanceId,
      source: "interactive-user-confirmation",
    });
    expect(
      hasValidStructuredFactUploadConsent({
        ...granted,
        serverUrl: "https://other.example.com",
      }),
    ).toBe(false);
    expect(
      hasValidStructuredFactUploadConsent({
        ...granted,
        pluginInstanceId: "instance-2",
      }),
    ).toBe(false);
  });

  it("supports explicit revocation", () => {
    const granted = withStructuredFactUploadConsent(config);
    const revoked = withoutStructuredFactUploadConsent(granted);

    expect(hasValidStructuredFactUploadConsent(revoked)).toBe(false);
    expect(revoked.structuredFactUploadConsent).toBeUndefined();
  });
});
