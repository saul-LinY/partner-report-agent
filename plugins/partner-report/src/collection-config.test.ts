import { describe, expect, it } from "vitest";
import {
  SCHEDULED_COLLECTION_PROMPT,
  SCHEDULED_COLLECTION_TASK,
} from "./collection-config.js";

describe("scheduled collection prompt", () => {
  it("uses Chinese instructions and documents the safe memory boundary", () => {
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("首次运行只采集最近 1 天");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("必须使用中文");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("automation memory");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "本地 accepted/ignored 哈希记录和中台哈希",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("采集和终态审查两个阶段");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("collect-review");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("任何 nextCommand");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("本地项目权限文件缺失");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("绑定命令负责首次项目发现");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("重新发送项目范围审核提醒");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("worktree 合并");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "首次白名单项目即使只有 1 个 Session 也可进入审批",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "project_scope_approval_required",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "project_scope_card_delivery_pending",
    );
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
        rrule: "RRULE:FREQ=DAILY;BYHOUR=14;BYMINUTE=30",
        timezone: "Asia/Shanghai",
      },
      model: "gpt-5.5",
      reasoningEffort: "low",
      notifications: "all_runs",
    });
  });
});
