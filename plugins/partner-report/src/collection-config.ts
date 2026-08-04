export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";
export const SCHEDULED_COLLECTION_PROMPT = [
  "Collect only eligible local Codex sessions, use only complete user prompts and final answers, extract validated structured facts, and upload only those facts to the configured Partner Report endpoint.",
  "A completed Plugin binding is the user's standing authorization for this bounded structured-Fact upload; stop if the CLI reports that the binding is missing or revoked.",
  "Never upload raw transcripts, reasoning, credentials, commands, tool calls, file changes, or incomplete turns.",
  "Process one Session at a time until the CLI reports empty or the invocation deadline is reached. A logical collection run is successful only after every queued Session is uploaded and pendingLocalJobs is zero.",
  "If one local job is blocked as SENSITIVE_EGRESS_REJECTED, exclude that job with the Skill's fail-local procedure and continue the logical run; never bypass the block.",
  "Do not create or update automation memory for this run. If the runtime requires a memory update, store only the run timestamp, completed or failed status, aggregate counts, and a safe error code; never store Session content, Facts, evidence, endpoint details, or identifiers.",
  "Use $partner-report-sync to run daily-collect and return only the safe collection summary.",
].join(" ");

export const SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=30",
    timezone: "Asia/Shanghai",
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "failures_only",
  prompt: SCHEDULED_COLLECTION_PROMPT,
} as const;

export const SCHEDULED_CONTINUATION_TASK = {
  name: "Partner Report collection continuation",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=2",
    timezone: "Asia/Shanghai",
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "failures_only",
  prompt: [
    SCHEDULED_COLLECTION_PROMPT,
    "Continue the existing logical collection run. If another invocation holds the run lease, exit safely. When daily-finish reports completed, pause this continuation task.",
  ].join(" "),
} as const;
