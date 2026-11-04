import { z } from "zod";
import { projectStatusSchema } from "./project-status.js";

export { buildTeamReportWorkCards } from "./team-report-source.js";
export * from "./collector.js";
export type { TeamReportSourceWorkCards } from "./team-report-source.js";

export const idSchema: z.ZodTypeAny = z.string().uuid();

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
  // schemaVersion gates payload compatibility; skillVersion is provenance.
  skillVersion: z
    .string()
    .regex(
      /^partner-report-(sync|platform)\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    ),
  promptVersion: z.string().min(1).max(80),
  schemaVersion: z.literal("1.0"),
  producer: z.enum(["codex-skill", "data-platform"]),
  modelVersion: z.string().min(1).optional(),
});

/** A manager-facing picture of where the whole project is heading and where it stands. */
export const projectOutlookSchema = z
  .object({
    goal: z.string().trim().min(1).max(200),
    roadmap: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(40),
            state: z.enum(["done", "current", "todo"]),
          })
          .strict(),
      )
      .min(2)
      .max(6),
    position: z.string().trim().min(1).max(200),
  })
  .strict();
export type ProjectOutlook = z.infer<typeof projectOutlookSchema>;

export const aggregationGroupSchema: z.ZodTypeAny = z
  .object({
    projectKey: z.string().default(""),
    status: workStatusSchema,
    projectStatus: projectStatusSchema.optional(),
    projectStatusReason: z.string().trim().max(500).optional(),
    currentFocus: z.string().trim().min(1).max(240).optional(),
    projectOutlook: projectOutlookSchema.optional(),
    keyEvents: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            type: z.enum([
              "goal_change",
              "milestone",
              "decision",
              "blocker",
              "stage_change",
            ]),
            title: z.string().trim().min(1).max(160),
            detail: z.string().trim().min(1).max(500),
            step: z.string().trim().max(40).optional(),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    overview: z.string().trim().min(1),
    dailyProgress: z
      .array(
        z
          .object({
            date: z.string().default(""),
            summary: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const aggregationResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  groups: z.array(aggregationGroupSchema),
  qualityWarnings: z.array(z.string()).default([]),
  production: productionMetadataSchema,
});

export const teamReportClaimSchema: z.ZodTypeAny = z.object({
  claim: z.string().default(""),
  workCardSnapshotIds: z.array(z.string()).default([]),
});

export const teamReportSectionSchema: z.ZodTypeAny = z.object({
  key: z.enum(["project_progress", "week_comparison", "risks"]),
  title: z.string(),
  markdown: z.string(),
  claims: z.array(teamReportClaimSchema).default([]),
});

export const teamReportGenerationSectionSchema: z.ZodTypeAny = z.object({
  key: z.enum(["project_progress", "week_comparison", "risks"]),
  markdown: z.string(),
  claims: z.array(teamReportClaimSchema).default([]),
});

export const teamReportProjectProgressSchema = z.object({
  partnerId: z.string(),
  partnerName: z.string(),
  projectKey: z.string().nullable(),
  projectName: z.string(),
  projectDescription: z.string().max(100).default(""),
  progress: z.string(),
  workCardSnapshotIds: z.array(z.string()),
});

export const teamReportGenerationResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  summary: z.string().trim().min(1),
  sections: z.array(teamReportGenerationSectionSchema),
  projectProgress: z.array(teamReportProjectProgressSchema).optional(),
  missingPartnerIds: z.array(z.string()).default([]),
  qualityWarnings: z.array(z.string()).default([]),
  production: productionMetadataSchema,
});

export const teamReportResultSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string(),
  summary: z.string().trim().min(1),
  sections: z.array(teamReportSectionSchema).min(1).max(3),
  projectProgress: z.array(teamReportProjectProgressSchema).optional(),
  markdown: z.string(),
  missingPartnerIds: z.array(idSchema).default([]),
  qualityWarnings: z.array(z.string()).default([]),
  production: productionMetadataSchema,
});

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
  source: z.literal("web").default("web"),
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
