import { z } from "zod";

export const idSchema: z.ZodTypeAny = z.string().uuid();
export const isoDateTimeSchema: z.ZodTypeAny = z
  .string()
  .datetime({ offset: true });

export const workStatusSchema: z.ZodTypeAny = z.enum([
  "discussion",
  "planned",
  "in_progress",
  "awaiting_validation",
  "completed",
  "blocked",
  "cancelled",
]);

export const productionMetadataSchema: z.ZodTypeAny = z.object({
  skillVersion: z.enum([
    "partner-report-sync/0.2.0",
    "partner-report-platform/0.2.0",
  ]),
  promptVersion: z.string().min(1).max(80),
  schemaVersion: z.literal("1.0"),
  producer: z.enum(["codex-skill", "data-platform"]),
  modelVersion: z.string().min(1).optional(),
});

export const evidenceSchema: z.ZodTypeAny = z.object({
  turnId: z.string().min(1),
  occurredAt: isoDateTimeSchema,
  excerpt: z.string().max(240).optional(),
  excerptHash: z.string().min(16),
  redacted: z.boolean().default(false),
});

export const timelineEventSchema: z.ZodTypeAny = z.object({
  status: workStatusSchema,
  occurredAt: isoDateTimeSchema,
  summary: z.string().min(1).max(600),
  evidenceTurnIds: z.array(z.string()).default([]),
});

export const sessionWorkFactSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  factId: z.string().min(1),
  sessionId: z.string().min(1),
  sourceRevision: z.number().int().positive(),
  sourceHash: z.string().min(16),
  fromTurnId: z.string().min(1),
  toTurnId: z.string().min(1),
  title: z.string().min(1).max(200),
  projectHint: z.string().max(120).optional(),
  status: workStatusSchema,
  actions: z.array(z.string().max(500)).default([]),
  outcomes: z.array(z.string().max(500)).default([]),
  impact: z.array(z.string().max(500)).default([]),
  decisions: z.array(z.string().max(500)).default([]),
  blockers: z.array(z.string().max(500)).default([]),
  nextSteps: z.array(z.string().max(500)).default([]),
  timeline: z.array(timelineEventSchema).min(1),
  evidence: z.array(evidenceSchema).default([]),
  completionSupport: z.enum(["evidence", "uncertain"]),
  factOrigin: z.enum(["ai_extracted", "partner_supplied"]),
  redactionSummary: z.record(z.number().int().nonnegative()).default({}),
  production: productionMetadataSchema,
});

export const sessionFactUploadSchema: z.ZodTypeAny = z.object({
  sessionId: z.string().min(1),
  project: z.object({
    id: idSchema,
    matchMethod: z.enum(["exact_root", "descendant_path"]),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  sourceRevision: z.number().int().positive(),
  sourceHash: z.string().min(16),
  fromTurnId: z.string().min(1),
  toTurnId: z.string().min(1),
  observedAt: isoDateTimeSchema,
  status: z.enum(["extracted", "failed_read", "failed_extract", "excluded"]),
  facts: z.array(sessionWorkFactSchema),
});

export const factBatchSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  producerVersion: z.string().min(1),
  batchId: z.string().min(1),
  pluginInstanceId: idSchema,
  periodCandidates: z.array(z.string()).default([]),
  sessions: z.array(sessionFactUploadSchema).min(1).max(50),
});

export const coverageSchema: z.ZodTypeAny = z.object({
  discovered: z.number().int().nonnegative(),
  readable: z.number().int().nonnegative(),
  extracted: z.number().int().nonnegative(),
  failedRead: z.number().int().nonnegative(),
  failedExtract: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  pendingSync: z.number().int().nonnegative(),
  activeAtCutoff: z.number().int().nonnegative(),
  hookMissed: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  lastSyncAt: isoDateTimeSchema.optional(),
});

export const importanceSchema: z.ZodTypeAny = z.object({
  outcome: z.number().min(0).max(5),
  impact: z.number().min(0).max(5),
  statusChange: z.number().min(0).max(5),
  decision: z.number().min(0).max(5),
  blocker: z.number().min(0).max(5),
  monitorAction: z.number().min(0).max(5),
  partnerEmphasis: z.number().min(0).max(5),
  repetitionPenalty: z.number().min(0).max(5),
});

export const aggregationGroupSchema: z.ZodTypeAny = z.object({
  clientKey: z.string().min(1),
  title: z.string().min(1).max(200),
  factIds: z.array(z.string()).min(1),
  projectId: idSchema.optional(),
  projectConfidence: z.number().min(0).max(1),
  assignmentMethod: z.enum([
    "explicit",
    "external_id",
    "alias",
    "semantic",
    "independent",
  ]),
  status: workStatusSchema,
  summary: z.string().min(1).max(1200),
  outcomes: z.array(z.string().max(500)).default([]),
  blockers: z.array(z.string().max(500)).default([]),
  nextSteps: z.array(z.string().max(500)).default([]),
  importance: importanceSchema,
  mergeConfidence: z.number().min(0).max(1),
  rationaleCodes: z.array(z.string()).default([]),
});

export const aggregationResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  groups: z.array(aggregationGroupSchema),
  unassignedFactIds: z.array(z.string()).default([]),
  qualityWarnings: z.array(z.string()).default([]),
  production: productionMetadataSchema,
});

export const reportClaimSchema: z.ZodTypeAny = z.object({
  claim: z.string().min(1).max(800),
  workItemIds: z.array(idSchema).min(1),
});

export const reportSectionSchema: z.ZodTypeAny = z.object({
  key: z.enum([
    "summary",
    "achievements",
    "project_progress",
    "risks",
    "next_priorities",
    "coordination",
    "coverage",
  ]),
  title: z.string().min(1).max(100),
  markdown: z.string().max(12000),
  claims: z.array(reportClaimSchema).default([]),
});

export const individualReportResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1200),
  sections: z.array(reportSectionSchema).length(7),
  markdown: z.string().min(1).max(60000),
  qualityWarnings: z.array(z.string()).default([]),
  production: productionMetadataSchema,
});

export const agentJobTypeSchema: z.ZodTypeAny = z.enum([
  "AGGREGATE_WORK_ITEMS",
  "GENERATE_INDIVIDUAL_REPORT",
  "REGENERATE_INDIVIDUAL_REPORT",
  "REANALYZE_SESSIONS",
  "RESCAN_SESSIONS",
]);

export const reviewOperationSchema: z.ZodTypeAny = z.enum([
  "approve",
  "exclude",
  "restore",
  "update_fact",
  "add_fact",
  "set_emphasis",
  "assign_project",
  "update_status",
  "merge",
  "split",
  "change_period",
]);

export const reviewChangeRequestSchema: z.ZodTypeAny = z.object({
  workItemIds: z.array(idSchema).min(1),
  baseVersion: z.number().int().positive(),
  operation: reviewOperationSchema,
  value: z.unknown().optional(),
  source: z.enum(["web", "feishu"]).default("web"),
});

export const heartbeatSchema: z.ZodTypeAny = z.object({
  pluginVersion: z.string().min(1),
  deviceName: z.string().min(1).max(120),
  runnerState: z
    .enum(["starting", "idle", "working", "delayed", "error"])
    .default("idle"),
  lastHookAt: isoDateTimeSchema.optional(),
  lastRunnerAt: isoDateTimeSchema.optional(),
  lastScanAt: isoDateTimeSchema.optional(),
  lastSyncAt: isoDateTimeSchema.optional(),
  nextDueAt: isoDateTimeSchema.optional(),
  dirtySessions: z.number().int().nonnegative().default(0),
  extractingSessions: z.number().int().nonnegative().default(0),
  pendingLocalJobs: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().max(120).optional(),
  coverage: coverageSchema.optional(),
});

export const collectionStatusSchema: z.ZodTypeAny = z.object({
  pluginVersion: z.string().min(1),
  deviceName: z.string().min(1).max(120),
  phase: z.enum(["started", "completed", "failed"]),
  periodKey: z.string().min(1).max(80),
  sessionCount: z.number().int().nonnegative().default(0),
  factCount: z.number().int().nonnegative().default(0),
  pendingLocalJobs: z.number().int().nonnegative().default(0),
  lastScanAt: isoDateTimeSchema.optional(),
  lastSyncAt: isoDateTimeSchema.optional(),
  errorCode: z.string().max(120).optional(),
  coverage: coverageSchema.optional(),
});

const sensitivePatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?[^\s,;"']{8,}/gi,
];

export function containsSensitiveValue(value: unknown) {
  const text = JSON.stringify(value);
  return sensitivePatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function assertFactSemantics(fact: {
  status: string;
  completionSupport: string;
  evidence: unknown[];
}) {
  if (
    fact.status === "completed" &&
    (fact.completionSupport !== "evidence" || fact.evidence.length === 0)
  ) {
    throw new Error("Completed facts require explicit evidence.");
  }
}

export function assertReportSemantics(report: {
  sections: Array<{ key: string }>;
}) {
  const required = [
    "summary",
    "achievements",
    "project_progress",
    "risks",
    "next_priorities",
    "coordination",
    "coverage",
  ];
  const actual = new Set(report.sections.map((section) => section.key));
  if (
    actual.size !== required.length ||
    required.some((key) => !actual.has(key))
  ) {
    throw new Error("Report must contain each required section exactly once.");
  }
}
