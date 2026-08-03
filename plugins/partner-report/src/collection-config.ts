export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";

export const SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=0",
    timezone: "Asia/Shanghai",
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "failures_only",
  prompt:
    "Use $partner-report-sync to run daily-collect and return only the safe collection summary.",
} as const;
