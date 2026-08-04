import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("partner report skill packaging", () => {
  it("documents the Session-level value screening workflow", () => {
    const skill = readFileSync(
      resolve(import.meta.dirname, "../skills/partner-report-sync/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("codex plugin list --json");
    expect(skill).toContain("source.path");
    expect(skill).toContain('node "<PLUGIN_PATH>/dist/cli.mjs"');
    expect(skill).toContain("collect-start");
    expect(skill).toContain("collect-next --run");
    expect(skill).toContain("collect-submit --run");
    expect(skill).toContain('decision: "ignore"');
    expect(skill).toContain("project directory is context, not proof");
    expect(skill).toContain("Ignored Sessions are deleted locally");
    expect(skill).toContain("does not maintain a Turn cursor");
    expect(skill).toContain("official Codex Scheduled Task");
    expect(skill).not.toContain("continuation-task-config");
    expect(skill).not.toContain("next-local");
    expect(skill).not.toContain("daily-finish");
    expect(skill).not.toContain("SQLite");
  });
});
