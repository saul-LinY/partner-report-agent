import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("partner report skill packaging", () => {
  it("resolves the installed plugin path without relying on hook-only environment variables", () => {
    const skill = readFileSync(resolve(import.meta.dirname, "../skills/partner-report-sync/SKILL.md"), "utf8");

    expect(skill).toContain("codex plugin list --json");
    expect(skill).toContain("source.path");
    expect(skill).toContain("node \"<PLUGIN_PATH>/dist/cli.mjs\"");
    expect(skill).toContain("weekly-collect");
    expect(skill).toContain("every Friday at 13:00");
    expect(skill).not.toContain("Stop` and `SessionEnd");
    expect(skill).not.toContain("node \"${PLUGIN_ROOT}/dist/cli.mjs\"");
  });
});
