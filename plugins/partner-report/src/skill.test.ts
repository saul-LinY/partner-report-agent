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
    expect(skill).toContain("project_scope_sync");
    expect(skill).toContain("只有插件完成首次项目扫描");
    expect(skill).toContain("`bindingCompleted: true`");
    expect(skill).toContain("飞书权限卡仅“请求发送”不等于已经送达");
    expect(skill).toContain("exclusion_set");
    expect(skill).toContain("jobInput");
    expect(skill).toContain("不得自行写结果文件");
    expect(skill).toContain("连续三次");
    expect(skill).toContain("禁止循环或批量跳过队列");
    expect(skill).toContain("`deferred` 不是提取失败");
    expect(skill).toContain("`notProcessed`");
    expect(skill).toContain('decision: "ignore"');
    expect(skill).toContain("项目目录只是上下文");
    expect(skill).toContain("第一次运行固定从当前周的周一 00:00 开始");
    expect(skill).toContain("最近一组完整问答的最终回答时间");
    expect(skill).toContain("全部完整问答拼成一个整体");
    expect(skill).toContain("新版本取代该 Session 的旧贡献");
    expect(skill).toContain("CREDENTIAL_MIGRATION_REQUIRED");
    expect(skill).toContain(
      "正常连接、采集、上传、审查和状态查询都不访问 macOS Keychain",
    );
    expect(skill).toContain("向中台为原 Plugin Instance 自动补发凭据");
    expect(skill).toContain("不发送飞书卡、不等待用户确认");
    expect(skill).toContain("自动恢复成功前不得列举或读取 Session");
    expect(skill).toContain("Partner Report daily collection");
    expect(skill).toContain("Codex 官方自动化工具");
    expect(skill).toContain("插件不得直接写 Codex 内部自动化文件");
    expect(skill).toContain("`scheduledTaskInstallation.status` 为 `required`");
    expect(skill).toContain("不得让用户手动配置");
    expect(skill).toContain("未命名任务");
    expect(skill).toContain("必须使用简体中文");
    expect(skill).toContain("通俗、精简、直接");
    expect(skill).toContain("本地文件是采集前的强制隐私门禁");
    expect(skill).toContain("最近 7 天有实际活动且未归档");
    expect(skill).toContain("通过 `thread/list` 扫描项目元数据");
    expect(skill).toContain("多个 worktree 归并为一个逻辑项目");
    expect(skill).toContain("每个项目至少 1 个 Session 即登记为 pending");
    expect(skill).toContain("用户输入绑定码只允许插件");
    expect(skill).toContain("必须通过飞书项目权限卡由用户逐项允许或拒绝");
    expect(skill).toContain(
      "历史上未经飞书确认却为 allowed 的项目必须恢复为 pending",
    );
    expect(skill).toContain("后续发现的项目只能从飞书允许时间起进入采集");
    expect(skill).toContain(
      "`project_scope_approval_required` 是本轮等待飞书审核的正常终态",
    );
    expect(skill).toContain("每天北京时间 16:00");
    expect(skill).toContain("不得向用户展示带 `Z` 的 UTC 时间");
    expect(skill).toContain("`gpt-5.6-sol`");
    expect(skill).toContain("作为下一周期普通工作");
    expect(skill).toContain("项目工作卡片整体接受后");
    expect(skill).toContain("项目工作卡片审核");
    expect(skill).toContain("终态审查");
    expect(skill).toContain("差集和 `unresolvedReadFailures` 都为空");
    expect(skill).not.toContain("continuation-task-config");
    expect(skill).not.toContain("next-local");
    expect(skill).not.toContain("daily-finish");
  });
});
