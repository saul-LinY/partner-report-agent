import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("partner report skill packaging", () => {
  it("resolves the installed plugin path without relying on hook-only environment variables", () => {
    const skill = readFileSync(
      resolve(import.meta.dirname, "../skills/partner-report-sync/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("codex plugin list --json");
    expect(skill).toContain("source.path");
    expect(skill).toContain('node "<PLUGIN_PATH>/dist/cli.mjs"');
    expect(skill).toContain("daily-collect");
    expect(skill).toContain("RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=0");
    expect(skill).toContain("Asia/Shanghai");
    expect(skill).toContain("Project: none");
    expect(skill).toContain("Model: `gpt-5.6-sol`");
    expect(skill).toContain("Reasoning effort: `medium`");
    expect(skill).toContain("Notifications: failures only");
    expect(skill).toContain("start a new chat for every run");
    expect(skill).toContain("required continuation of Connect");
    expect(skill).toContain("do not reset its destination");
    expect(skill).toContain(
      "only source of truth for model and reasoning effort",
    );
    expect(skill).toContain("Never launch `codex exec`");
    expect(skill).toContain("daily-finish");
    expect(skill).toContain("at most three total extraction attempts");
    expect(skill).toContain("must never hardcode or guess it");
    expect(skill).not.toContain("Stop` and `SessionEnd");
    expect(skill).not.toContain('node "${PLUGIN_ROOT}/dist/cli.mjs"');
  });
});
