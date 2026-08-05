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
