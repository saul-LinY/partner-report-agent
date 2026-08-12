import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "./config.js";

describe("partner report skill packaging", () => {
  it("keeps package and plugin manifest versions aligned", () => {
    const packageManifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    );
    const pluginManifest = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../.codex-plugin/plugin.json"),
        "utf8",
      ),
    );

    expect(packageManifest.version).toBe(PLUGIN_VERSION);
    expect(pluginManifest.version.split("+")[0]).toBe(PLUGIN_VERSION);
  });

  it("documents the Session-level value screening workflow", () => {
    const skill = readFileSync(
      resolve(import.meta.dirname, "../skills/partner-report-sync/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("codex plugin list --json");
    expect(skill).toContain("source.path");
    expect(skill).toContain("不要比较、解释或向用户展示 Skill 缓存路径");
    expect(skill).toContain('node "<PLUGIN_PATH>/dist/cli.mjs"');
    expect(skill).toContain("每次定时采集都不得检查");
    expect(skill).toContain("用户提供了新 Prompt 时使用用户原文");
    expect(skill).toContain("恢复默认 Prompt");
    expect(skill).toContain("只更新 `prompt` 字段");
    expect(skill).toContain("不得修改 destination、project、schedule");
    expect(skill).toContain("Prompt 与插件内置默认值不同不构成错误");
    expect(skill).not.toContain("必须检查一次且只检查一次定时任务 Prompt");
    expect(skill).toContain("collect-start");
    expect(skill).toContain("collect-next --run");
    expect(skill).toContain("collect-review --run");
    expect(skill).toContain("collect-submit --run");
    expect(skill).toContain("collect-defer --run");
    expect(skill).toContain("连续三次真实失败");
    expect(skill).toContain("禁止编写循环或批量调用 `collect-skip`");
    expect(skill).toContain("`deferred` 不是提取失败");
    expect(skill).toContain("`notProcessed`");
    expect(skill).toContain("审查完成后由 CLI 按现有策略整体清理");
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
    expect(skill).toContain("通俗、精简、直接");
    expect(skill).toContain("用户稳定数据目录中的 CLI 本地状态和中台状态");
    expect(skill).toContain("所有 `nextCommand` 都必须执行");
    expect(skill).toContain("持续执行 `project-scope-card-wait`");
    expect(skill).toContain("`project_scope_no_candidates`");
    expect(skill).toContain(
      "绑定命令完成后才允许通过 `thread/list` 读取元数据",
    );
    expect(skill).not.toContain("feishu_identity_confirmation_required");
    expect(skill).not.toContain("identity-wait");
    expect(skill).toContain("多个 worktree 归并为一个逻辑项目");
    expect(skill).toContain("每个项目至少 1 个 Session 即登记");
    expect(skill).toContain("最近 7 天新建且未归档");
    expect(skill).toContain("不依赖 Codex 侧边栏项目列表");
    expect(skill).toContain("project-scope-sync");
    expect(skill).toContain("pending 项目保持待审批");
    expect(skill).toContain("project_scope_approval_waiting");
    expect(skill).toContain("project_scope_end_scan_card_waiting");
    expect(skill).toContain("已有授权队列清空后才重新读取 `thread/list`");
    expect(skill).toContain("审批 30 分钟");
    expect(skill).toContain("补采本周期");
    expect(skill).toContain("项目权限审核卡不展示项目描述");
    expect(skill).toContain("project_description_job");
    expect(skill).toContain("目标约 150 字");
    expect(skill).toContain("整张卡片接受后描述才成为中台正式描述");
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
