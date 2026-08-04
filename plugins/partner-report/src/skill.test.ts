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
    expect(skill).toContain("RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=30");
    expect(skill).toContain("Asia/Shanghai");
    expect(skill).toContain("Project: none");
    expect(skill).toContain("Model: `gpt-5.6-sol`");
    expect(skill).toContain("Reasoning effort: `medium`");
    expect(skill).toContain("Notifications: failures only");
    expect(skill).toContain("start a new chat for every run");
    expect(skill).toContain("required continuation of Connect");
    expect(skill).toContain(
      "Binding enables the documented scheduled collection scope by default",
    );
    expect(skill).toContain("Do not ask for a separate upload authorization");
    expect(skill).toContain("scheduled-task-config");
    expect(skill).toContain("do not reset its destination");
    expect(skill).toContain("Replace only its prompt when it differs");
    expect(skill).toContain(
      "only source of truth for model and reasoning effort",
    );
    expect(skill).toContain("Never launch `codex exec`");
    expect(skill).toContain("daily-finish");
    expect(skill).toContain("continuation-task-config");
    expect(skill).toContain("continuation_required");
    expect(skill).toContain("pendingLocalJobs` is zero");
    expect(skill).toContain("rolling 24 hours");
    expect(skill).toContain("project.id=null");
    expect(skill).toContain("exclude-session");
    expect(skill).toContain("sourceOccurredAt");
    expect(skill).toContain("at most three total extraction attempts");
    expect(skill).toContain("must never hardcode or guess it");
    expect(skill).toContain("Do not create or update automation memory");
    expect(skill).toContain(
      "Never store Session content, Facts, evidence, endpoint details, or identifiers",
    );
    expect(skill).not.toContain("consent-status");
    expect(skill).not.toContain("authorize-upload");
    expect(skill).not.toContain("Stop` and `SessionEnd");
    expect(skill).not.toContain('node "${PLUGIN_ROOT}/dist/cli.mjs"');
  });
});
