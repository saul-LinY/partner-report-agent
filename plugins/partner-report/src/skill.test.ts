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
    expect(skill).toContain("collect-review --run");
    expect(skill).toContain("collect-submit --run");
    expect(skill).toContain('decision: "ignore"');
    expect(skill).toContain("项目目录只是上下文");
    expect(skill).toContain("第一次运行只采集运行开始前最近 1 天");
    expect(skill).toContain("未变化且曾被判定为 `ignore`");
    expect(skill).toContain("不维护 Turn 游标");
    expect(skill).toContain("官方 Codex Scheduled Task");
    expect(skill).toContain("必须使用简体中文");
    expect(skill).toContain("防重与成功游标以 CLI 本地状态和中台状态为准");
    expect(skill).toContain("所有 `nextCommand` 都必须执行");
    expect(skill).toContain("终态审查");
    expect(skill).not.toContain("continuation-task-config");
    expect(skill).not.toContain("next-local");
    expect(skill).not.toContain("daily-finish");
    expect(skill).not.toContain("SQLite");
  });
});
