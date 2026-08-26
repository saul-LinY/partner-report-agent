export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";

export const SCHEDULED_COLLECTION_PROMPT =
  "使用 $partner-report-sync 完成本周期采集。遵循该 Skill，仅调用 partner-report MCP，按 nextTool 逐个处理 Job。仅当 collect_review 返回 completed、checkpointAdvanced: true 且无 nextTool 时结束，否则继续。最终只输出 Skill 允许的中文安全聚合摘要。";

export const SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=16;BYMINUTE=0",
    timezone: "Asia/Shanghai",
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "all_runs",
  prompt: SCHEDULED_COLLECTION_PROMPT,
} as const;

export const SCHEDULED_COLLECTION_TASK_POLICY = {
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
} as const;
