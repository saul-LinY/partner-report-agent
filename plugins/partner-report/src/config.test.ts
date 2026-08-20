import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migratePersistentDataDirectory,
  loadSecret,
  normalizeServerUrl,
  saveSecret,
  selectWritableDataDirectory,
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
  it("stores new credentials in the stable file with owner-only permissions", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-secret-test-"));
    const previous = process.env.PARTNER_REPORT_DATA;
    process.env.PARTNER_REPORT_DATA = root;
    try {
      saveSecret("instance-1", "access", "secret-value");
      expect(loadSecret("instance-1", "access")).toBe("secret-value");
      expect(statSync(resolve(root, "secrets.json")).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.PARTNER_REPORT_DATA;
      else process.env.PARTNER_REPORT_DATA = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("keeps the preferred writable directory for existing users", () => {
    const attempts: string[] = [];
    const selected = selectWritableDataDirectory(
      ["/preferred", "/plugin-data"],
      (candidate) => {
        attempts.push(candidate);
        return candidate;
      },
    );

    expect(selected).toBe("/preferred");
    expect(attempts).toEqual(["/preferred"]);
  });

  it("falls back to plugin data when the preferred directory is read-only", () => {
    const attempts: string[] = [];
    const selected = selectWritableDataDirectory(
      ["/read-only", "/plugin-data"],
      (candidate) => {
        attempts.push(candidate);
        if (candidate === "/read-only")
          throw Object.assign(new Error("not permitted"), { code: "EPERM" });
        return candidate;
      },
    );

    expect(selected).toBe("/plugin-data");
    expect(attempts).toEqual(["/read-only", "/plugin-data"]);
  });

  it("keeps using a remembered writable directory before other fallbacks", () => {
    const attempts: string[] = [];
    const selected = selectWritableDataDirectory(
      ["/remembered", "/stable", "/plugin-data"],
      (candidate) => {
        attempts.push(candidate);
        return candidate;
      },
    );

    expect(selected).toBe("/remembered");
    expect(attempts).toEqual(["/remembered"]);
  });

  it("returns a stable permission error when no data directory is writable", () => {
    expect(() =>
      selectWritableDataDirectory(["/one", "/two"], () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }),
    ).toThrow(
      expect.objectContaining({
        code: "LOCAL_DATA_WRITE_PERMISSION_REQUIRED",
      }),
    );
  });
});
