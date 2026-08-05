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
    "partner-report-sync/0.3.0",
    "partner-report-sync/0.4.0",
    "partner-report-platform/0.2.0",
    "partner-report-platform/0.3.0",
  ]),
  promptVersion: z.string().min(1).max(80),
  schemaVersion: z.literal("1.0"),
  producer: z.enum(["codex-skill", "data-platform"]),
  modelVersion: z.string().min(1).optional(),
});

export const projectIdentitySchema: z.ZodTypeAny = z
  .object({
    id: idSchema.nullable(),
    name: z.string().min(1).max(120),
    matchMethod: z.enum([
      "exact_root",
      "descendant_path",
      "path_discovered",
      "unassigned",
    ]),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    rootName: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((project, context) => {
    if (project.matchMethod === "path_discovered" && !project.rootName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rootName"],
        message: "path_discovered project requires rootName",
      });
    }
  });

export const contributionKindSchema: z.ZodTypeAny = z.enum([
  "outcome",
  "progress",
  "decision",
  "blocker",
  "next_step",
]);

export const contributionItemSchema: z.ZodTypeAny = z
  .object({
    kind: contributionKindSchema,
    text: z.string().min(1).max(600),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

export const sessionContributionSchema: z.ZodTypeAny = z
  .object({
    schemaVersion: z.literal("1.0"),
    periodKey: z.string().min(1).max(80),
    sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    project: projectIdentitySchema,
    activity: z
      .object({
        startedAt: isoDateTimeSchema,
        endedAt: isoDateTimeSchema,
      })
      .strict(),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1600),
    status: workStatusSchema,
    contributions: z.array(contributionItemSchema).min(1).max(40),
    observedAt: isoDateTimeSchema,
    production: productionMetadataSchema,
  })
  .strict()
  .superRefine((contribution, context) => {
    if (
      new Date(contribution.activity.startedAt).getTime() >
      new Date(contribution.activity.endedAt).getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity", "endedAt"],
        message: "activity.endedAt must not precede activity.startedAt",
      });
    }
  });

export const sessionExtractionResultSchema: z.ZodTypeAny = z.discriminatedUnion(
  "decision",
  [
    z
      .object({
        schemaVersion: z.literal("1.0"),
        decision: z.literal("ignore"),
        reason: z.enum([
          "casual_conversation",
          "unrelated_to_project",
          "no_meaningful_contribution",
          "insufficient_context",
        ]),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal("1.0"),
        decision: z.literal("include"),
        contribution: sessionContributionSchema,
      })
      .strict(),
  ],
);

export const sessionContributionStateQuerySchema: z.ZodTypeAny = z
  .object({
    periodKey: z.string().min(1).max(80),
  })
  .strict();

export const coverageSchema: z.ZodTypeAny = z.object({
  discovered: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative().default(0),
  readable: z.number().int().nonnegative(),
  extracted: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative().default(0),
  failedRead: z.number().int().nonnegative(),
  failedExtract: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  pendingSync: z.number().int().nonnegative(),
  activeAtCutoff: z.number().int().nonnegative(),
  hookMissed: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  lastSyncAt: isoDateTimeSchema.optional(),
});

export const aggregationGroupSchema: z.ZodTypeAny = z
  .object({
    projectKey: z.string().min(1).max(160),
    status: workStatusSchema,
    overview: z.string().min(1).max(1600),
    dailyProgress: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            summary: z.string().min(1).max(1200),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const aggregationResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  groups: z.array(aggregationGroupSchema),
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

export const teamReportClaimSchema: z.ZodTypeAny = z.object({
  claim: z.string().min(1).max(1000),
  individualReportVersionIds: z.array(idSchema).min(1),
});

export const teamReportSectionSchema: z.ZodTypeAny = z.object({
  key: z.enum([
    "summary",
    "project_progress",
    "risks",
    "next_priorities",
    "coverage",
  ]),
  title: z.string().min(1).max(100),
  markdown: z.string().max(16000),
  claims: z.array(teamReportClaimSchema).default([]),
});

export const teamReportResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1600),
  sections: z.array(teamReportSectionSchema).length(5),
  markdown: z.string().min(1).max(80000),
  missingPartnerIds: z.array(idSchema).default([]),
  qualityWarnings: z.array(z.string()).default([]),
  production: productionMetadataSchema,
});

export const agentJobTypeSchema: z.ZodTypeAny = z.enum([
  "AGGREGATE_WORK_ITEMS",
  "GENERATE_INDIVIDUAL_REPORT",
  "REGENERATE_INDIVIDUAL_REPORT",
  "GENERATE_TEAM_REPORT",
  "REGENERATE_TEAM_REPORT",
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
  discoveredCount: z.number().int().nonnegative().default(0),
  eligibleCount: z.number().int().nonnegative().default(0),
  deferredCount: z.number().int().nonnegative().default(0),
  excludedCount: z.number().int().nonnegative().default(0),
  lastScanAt: isoDateTimeSchema.optional(),
  lastSyncAt: isoDateTimeSchema.optional(),
  errorCode: z.string().max(120).optional(),
  coverage: coverageSchema.optional(),
});

export const connectivityCapabilityVersionSchema: z.ZodTypeAny =
  z.literal("1.0");

export const connectivityTestSchema: z.ZodTypeAny = z
  .object({
    challenge: z.string().min(20).max(200),
    pluginVersion: z.string().min(1).max(40),
    clientTime: isoDateTimeSchema,
    capabilityVersion: connectivityCapabilityVersionSchema,
  })
  .strict();

export const diagnosticStageSchema: z.ZodTypeAny = z.enum([
  "binding",
  "connectivity",
  "task_setup",
  "scan",
  "extract",
  "sync",
]);

export const diagnosticErrorCodeSchema: z.ZodTypeAny = z.enum([
  "DNS_FAILED",
  "TLS_FAILED",
  "CONNECTION_REFUSED",
  "CONNECTIVITY_TIMEOUT",
  "AUTH_FAILED",
  "VERSION_BLOCKED",
  "CHALLENGE_INVALID",
  "CHALLENGE_EXPIRED",
  "CLIENT_CLOCK_SKEW",
  "REQUEST_INVALID",
  "TASK_SETUP_FAILED",
  "SCAN_FAILED",
  "EXTRACT_FAILED",
  "SYNC_FAILED",
  "LOCAL_STORAGE_FAILED",
  "LOCAL_AGENT_FAILED",
  "SENSITIVE_EGRESS_REJECTED",
]);

export const pluginDiagnosticEventSchema: z.ZodTypeAny = z
  .object({
    eventId: z.string().uuid(),
    stage: diagnosticStageSchema,
    errorCode: diagnosticErrorCodeSchema,
    occurredAt: isoDateTimeSchema,
    retryable: z.boolean(),
    requestId: z.string().min(1).max(120).optional(),
  })
  .strict();

export const pluginDiagnosticBatchSchema: z.ZodTypeAny = z
  .object({
    events: z.array(pluginDiagnosticEventSchema).min(1).max(20),
  })
  .strict();

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

export function assertReportSemantics(report: {
  sections: Array<{ key: string; claims?: unknown[] }>;
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
  if (!report.sections.some((section) => (section.claims?.length ?? 0) > 0)) {
    throw new Error("Report must cite at least one current Work Item claim.");
  }
}

export function assertTeamReportSemantics(report: {
  sections: Array<{ key: string }>;
}) {
  const required = [
    "summary",
    "project_progress",
    "risks",
    "next_priorities",
    "coverage",
  ];
  const actual = new Set(report.sections.map((section) => section.key));
  if (
    actual.size !== required.length ||
    required.some((key) => !actual.has(key))
  ) {
    throw new Error(
      "Team Report must contain each required section exactly once.",
    );
  }
}
