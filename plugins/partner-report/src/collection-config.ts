export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";
export const SCHEDULED_COLLECTION_PROMPT = [
  "Collect only eligible local Codex sessions, use only complete user prompts and final answers, extract validated structured facts, and upload only those facts to the configured Partner Report endpoint.",
  "Never upload raw transcripts, reasoning, credentials, commands, tool calls, file changes, or incomplete turns.",
  "Do not create or update automation memory for this run. If the runtime requires a memory update, store only the run timestamp, completed or failed status, aggregate counts, and a safe error code; never store Session content, Facts, evidence, endpoint details, or identifiers.",
  "Use $partner-report-sync to run daily-collect and return only the safe collection summary.",
].join(" ");

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
  prompt: SCHEDULED_COLLECTION_PROMPT,
} as const;
