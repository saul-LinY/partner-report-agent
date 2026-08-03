import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "./config.js";

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
