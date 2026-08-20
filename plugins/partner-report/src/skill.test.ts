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
    expect(pluginManifest.mcpServers).toBe("./.mcp.json");

    const mcpManifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../.mcp.json"), "utf8"),
    );
    // The current Codex plugin validator and VS Code host use the camelCase wrapper.
    expect(mcpManifest.mcpServers["partner-report"]).toEqual(
      expect.objectContaining({
        command: "node",
        args: ["./dist/mcp.mjs"],
        cwd: ".",
        default_tools_approval_mode: "approve",
      }),
    );
  });

  it("uses MCP for the complete Session screening workflow", () => {
    const skill = readFileSync(
      resolve(import.meta.dirname, "../skills/partner-report-sync/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("只使用插件自带的 `partner-report` MCP 工具");
    expect(skill).toContain("不得改用 shell 或 CLI");
    expect(skill).not.toContain('node "<PLUGIN_PATH>/dist/cli.mjs"');
    expect(skill).toContain("不得修改 Codex 的全局权限模式");
    expect(skill).toContain("工具结果包含 `nextTool` 时");
    expect(skill).toContain("只有 `completed` 且没有 `nextTool`");
    expect(skill).toContain("collect_start");
    expect(skill).toContain("collect_next");
    expect(skill).toContain("collect_submit");
    expect(skill).toContain("collect_review");
    expect(skill).toContain("collect_defer");
    expect(skill).toContain("project_description_submit");
    expect(skill).toContain("project_scope_card_wait");
    expect(skill).toContain("project_scope_sync");
    expect(skill).toContain("exclusion_set");
    expect(skill).toContain("jobInput");
    expect(skill).toContain("不得自行写结果文件");
    expect(skill).toContain("连续三次");
    expect(skill).toContain("禁止循环或批量跳过队列");
    expect(skill).toContain("`deferred` 不是提取失败");
    expect(skill).toContain("`notProcessed`");
    expect(skill).toContain('decision: "ignore"');
    expect(skill).toContain("项目目录只是上下文");
    expect(skill).toContain("第一次运行只采集运行开始前最近 1 天");
    expect(skill).toContain("模型不会再次读取、判断或上传");
    expect(skill).toContain("不维护 Turn 游标");
    expect(skill).toContain("CREDENTIAL_MIGRATION_REQUIRED");
    expect(skill).toContain(
      "正常连接、采集、上传、审查和状态查询都不访问 macOS Keychain",
    );
    expect(skill).toContain("官方 Codex Scheduled Task");
    expect(skill).toContain("必须使用简体中文");
    expect(skill).toContain("通俗、精简、直接");
    expect(skill).toContain("本地文件是采集前的强制隐私门禁");
    expect(skill).toContain("最近 7 天有实际活动且未归档");
    expect(skill).toContain("只读取 Codex 状态数据库中的元数据");
    expect(skill).toContain("多个 worktree 归并为一个逻辑项目");
    expect(skill).toContain("每个项目至少 1 个 Session 即登记");
    expect(skill).toContain("pending 项目保持待审批");
    expect(skill).toContain("审批 30 分钟");
    expect(skill).toContain("下一次运行补采本周期");
    expect(skill).toContain("项目工作卡片整体接受后");
    expect(skill).toContain("终态审查");
    expect(skill).not.toContain("continuation-task-config");
    expect(skill).not.toContain("next-local");
    expect(skill).not.toContain("daily-finish");
  });
});
