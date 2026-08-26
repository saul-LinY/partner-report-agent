import { describe, expect, it } from "vitest";
import {
  SCHEDULED_COLLECTION_PROMPT,
  SCHEDULED_COLLECTION_TASK,
  SCHEDULED_COLLECTION_TASK_POLICY,
} from "./collection-config.js";

describe("scheduled collection prompt", () => {
  it("delegates policy to the Skill and keeps only the execution contract", () => {
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("$partner-report-sync");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("partner-report MCP");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("collect_review");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "completed、checkpointAdvanced: true 且无 nextTool",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("中文安全聚合摘要");
    expect(SCHEDULED_COLLECTION_PROMPT.length).toBeLessThanOrEqual(200);
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
