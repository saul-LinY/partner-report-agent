export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";

export const SCHEDULED_COLLECTION_PROMPT = [
  "Use $partner-report-sync to collect eligible Codex Sessions for the current Partner Report period.",
  "Read one Session at a time through the plugin CLI.",
  "First judge whether the Session contains meaningful work for its mapped project.",
  "Discard casual conversation, unrelated topics, low-value chatter, and Sessions without a concrete outcome, progress, decision, blocker, or next step.",
  "For eligible Sessions, write only the validated SessionExtractionResult requested by the Skill and upload only the SessionContribution.",
  "Never upload raw transcripts, absolute paths, raw Codex Session IDs, reasoning, tool calls, commands, file changes, or secrets.",
  "Continue until the CLI reports completed, then return only its safe aggregate summary.",
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
