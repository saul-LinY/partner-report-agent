import { describe, expect, it } from "vitest";
import {
  SCHEDULED_COLLECTION_PROMPT,
  SCHEDULED_COLLECTION_TASK,
  SCHEDULED_COLLECTION_TASK_POLICY,
} from "./collection-config.js";

describe("scheduled collection prompt", () => {
  it("uses Chinese instructions and documents the safe memory boundary", () => {
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "首次运行不回采任何历史 Session",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).not.toContain("检查同名 Codex");
    expect(SCHEDULED_COLLECTION_PROMPT).not.toContain("更新 Prompt");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("必须使用中文");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("通俗、精简、直接");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("automation memory");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "本地 accepted/ignored 哈希记录和中台哈希",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("采集和终态审查两个阶段");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("collect_review");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("任何 nextTool");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("collect_defer");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("连续三次真实失败");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("禁止批量 collect_skip");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("不得运行 CLI 或 shell");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "deferred、failedExtract 和 notProcessed",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("本地项目权限文件缺失");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("绑定命令负责项目发现");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "只读取 Codex 状态数据库中的元数据",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "最近 7 天有实际活动且未归档",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("重新发送项目范围审核提醒");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("worktree 合并");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "每个真实项目至少 1 个 Session 即可登记",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "本地 allowed/denied 修改会在采集前提交中台",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "project_scope_approval_required",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "project_scope_approval_waiting",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "已有授权队列清空后才重新读取 thread/list 元数据扫描新项目",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("审批 30 分钟");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("不得回采授权前内容");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("稳定本地目录");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("上传成功时当前开放周期");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("约 150 字中文候选描述");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("语义指纹变化时才生成");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("project_description_job");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "project_scope_no_candidates",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "checkpointAdvanced 为 true 才记录成功",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).not.toContain(
      "Use $partner-report-sync",
    );
  });

  it("uses the first-activation defaults", () => {
    expect(SCHEDULED_COLLECTION_TASK).toMatchObject({
      destination: "new_chat",
      project: null,
      schedule: {
        rrule: "RRULE:FREQ=DAILY;BYHOUR=16;BYMINUTE=0",
        timezone: "Asia/Shanghai",
      },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      notifications: "all_runs",
    });
  });

  it("supports explicit prompt updates and full task resets", () => {
    expect(SCHEDULED_COLLECTION_TASK_POLICY).toEqual({
      automaticCheck: false,
      automaticRepair: false,
      installationOwner: "plugin_connect",
      createIfMissing: true,
      preserveExistingTask: true,
      customPromptAllowed: true,
      promptUpdateTrigger: "explicit_user_request_only",
      promptUpdateFields: ["prompt"],
      fullResetTrigger: "explicit_user_request_only",
      fullResetFields: [
        "destination",
        "project",
        "schedule",
        "model",
        "reasoningEffort",
        "notifications",
        "prompt",
      ],
      preserveTaskIdentity: true,
    });
    expect(SCHEDULED_COLLECTION_TASK_POLICY).not.toHaveProperty("frequency");
    expect(SCHEDULED_COLLECTION_TASK_POLICY).not.toHaveProperty("failureMode");
  });
});
