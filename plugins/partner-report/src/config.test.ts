import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migratePersistentDataDirectory,
  normalizeServerUrl,
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

describe("persistent plugin data", () => {
  it("migrates durable state without copying transient locks", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-config-test-"));
    const source = resolve(root, "old-plugin-data");
    const target = resolve(root, "stable-user-data");
    mkdirSync(source);
    writeFileSync(resolve(source, "config.json"), '{"source":"old"}\n');
    writeFileSync(resolve(source, "collection-state.json"), "{}\n");
    writeFileSync(resolve(source, "project-scope.json"), "{}\n");
    writeFileSync(resolve(source, "collection.lock"), "temporary\n");
    try {
      migratePersistentDataDirectory(source, target);
      expect(readFileSync(resolve(target, "config.json"), "utf8")).toContain(
        '"source":"old"',
      );
      expect(
        readFileSync(resolve(target, "collection-state.json"), "utf8"),
      ).toContain("{}");
      expect(
        readFileSync(resolve(target, "project-scope.json"), "utf8"),
      ).toContain("{}");
      expect(() => readFileSync(resolve(target, "collection.lock"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
