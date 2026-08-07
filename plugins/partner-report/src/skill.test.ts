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
    expect(skill).toContain("不要比较、解释或向用户展示 Skill 缓存路径");
    expect(skill).toContain('node "<PLUGIN_PATH>/dist/cli.mjs"');
    expect(skill).toContain("collect-start");
    expect(skill).toContain("collect-next --run");
    expect(skill).toContain("collect-review --run");
    expect(skill).toContain("collect-submit --run");
    expect(skill).toContain('decision: "ignore"');
    expect(skill).toContain("项目目录只是上下文");
    expect(skill).toContain("第一次运行只采集运行开始前最近 1 天");
    expect(skill).toContain("已接收和已忽略 Session");
    expect(skill).toContain("模型不会再次读取、判断或上传");
    expect(skill).toContain("不是需要模型处理的数量");
    expect(skill).toContain("KEYCHAIN_ACCESS_REQUIRED");
    expect(skill).toContain("不维护 Turn 游标");
    expect(skill).toContain("官方 Codex Scheduled Task");
    expect(skill).toContain("必须使用简体中文");
    expect(skill).toContain("用户稳定数据目录中的 CLI 本地状态和中台状态");
    expect(skill).toContain("所有 `nextCommand` 都必须执行");
    expect(skill).toContain("持续执行 `project-scope-card-wait`");
    expect(skill).toContain("`project_scope_no_candidates`");
    expect(skill).toContain("绑定命令完成后才允许通过 `thread/list` 读取元数据");
    expect(skill).not.toContain("feishu_identity_confirmation_required");
    expect(skill).not.toContain("identity-wait");
    expect(skill).toContain("多个 worktree 归并为一个逻辑项目");
    expect(skill).toContain("首次白名单项目即使只有 1 个 Session 也可登记审批");
    expect(skill).toContain("最近 7 天有已知 Session 活动");
    expect(skill).toContain("项目根目录白名单");
    expect(skill).toContain("pending 文件夹不会因新增 Session 重复发送审核卡");
    expect(skill).toContain("不读取或上传 Session");
    expect(skill).toContain("本地文件是采集前的强制隐私门禁");
    expect(skill).toContain("下一次定时运行");
    expect(skill).toContain("终态审查");
    expect(skill).not.toContain("continuation-task-config");
    expect(skill).not.toContain("next-local");
    expect(skill).not.toContain("daily-finish");
    expect(skill).not.toContain("SQLite");
  });
});
