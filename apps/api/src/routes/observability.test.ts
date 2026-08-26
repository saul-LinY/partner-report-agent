import { describe, expect, it } from "vitest";
import {
  isValidPluginLogDate,
  sanitizePluginLogDetails,
  sanitizePluginLogText,
} from "./observability.js";

describe("plugin log date validation", () => {
  it("accepts real calendar days and rejects normalized overflow dates", () => {
    expect(isValidPluginLogDate("2026-08-26")).toBe(true);
    expect(isValidPluginLogDate("2024-02-29")).toBe(true);
    expect(isValidPluginLogDate("2026-02-29")).toBe(false);
    expect(isValidPluginLogDate("2026-04-31")).toBe(false);
    expect(isValidPluginLogDate("08/26/2026")).toBe(false);
  });
});

describe("plugin log sanitization", () => {
  it("keeps debugging context while removing credentials and local identity", () => {
    const sanitized = sanitizePluginLogText(
      "Bearer abcdefghijk password=hunter2 at /Users/saul/project/cli.ts:42",
    );
    expect(sanitized).toContain("cli.ts:42");
    expect(sanitized).not.toContain("abcdefghijk");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("/Users/saul");
  });

  it("recursively redacts secret fields in structured details", () => {
    expect(
      sanitizePluginLogDetails({
        retry: { attempt: 2, accessToken: "secret-value" },
        message: "failed under /Users/alice/project",
      }),
    ).toEqual({
      retry: { attempt: 2, accessToken: "<REDACTED>" },
      message: "failed under <USER_HOME>/project",
    });
  });
});
