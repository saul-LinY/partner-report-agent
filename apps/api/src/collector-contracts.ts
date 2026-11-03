import { z } from "zod";
import { collectorSessionSchema } from "@partner-report/contracts";
export { collectorSessionSchema } from "@partner-report/contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const collectorClaimSchema = z
  .object({
    bindingCode: z.string().trim().min(8).max(80),
    name: z.string().trim().min(1).max(120),
    deviceName: z.string().trim().min(1).max(120),
    version: z.string().min(1).max(40),
  })
  .strict();

export const collectorSessionsSchema = z
  .array(collectorSessionSchema)
  .max(10_000);
export const collectorManifestSchema = z
  .object({
    id: z.string().uuid(),
    periodKey: z.string().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    policyVersion: z.number().int().positive(),
    sessionCount: z.number().int().min(0).max(1_000_000),
    partDigests: z.array(digest).min(1).max(10_000),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.startsAt) <= Date.parse(v.endsAt) &&
      Date.parse(v.endsAt) <= Date.now() + 60_000,
    "Invalid collection window",
  );

export const collectorLogStages = [
  "app",
  "binding",
  "permissions",
  "discovery",
  "scan",
  "upload",
  "heartbeat",
  "notification",
  "review",
] as const;

export const collectorLogCodes = [
  "BOUND",
  "POLICY_SYNCED",
  "POLICY_SYNC_FAILED",
  "APP_LAUNCHED",
  "DISCOVERY_STARTED",
  "DISCOVERY_COMPLETED",
  "DISCOVERY_FAILED",
  "SCAN_STARTED",
  "SCAN_COMPLETED",
  "SCAN_FAILED",
  "SESSION_READ_FAILED",
  "UPLOAD_QUEUED",
  "UPLOAD_STARTED",
  "UPLOAD_PART_SENT",
  "UPLOAD_PART_FAILED",
  "UPLOAD_COMPLETED",
  "UPLOAD_FAILED",
  "UPLOAD_NETWORK_FAILED",
  "UPLOAD_AUTH_FAILED",
  "UPLOAD_POLICY_CHANGED",
  "UPLOAD_SERVER_FAILED",
  "UPLOAD_STORAGE_FAILED",
  "UPLOAD_TOO_LARGE",
  "ALIVE",
  "NOTIFICATIONS_ALLOWED",
  "NOTIFICATIONS_DENIED",
  "NOTIFICATIONS_NOT_CONFIGURED",
  "NOTIFICATION_RECEIPT_FAILED",
  "REVIEW_ACTION_FAILED",
] as const;

export const collectorErrorKinds = [
  "network",
  "auth",
  "policy",
  "server",
  "storage",
  "size",
  "read",
  "unknown",
] as const;

// Whitelisted diagnostic fields only. No paths, session text, tokens or free-form
// exception strings; `message` is a fixed description of our own error types and is
// additionally redacted server-side before storage.
export const collectorLogDetailsSchema = z
  .object({
    appVersion: z.string().min(1).max(40).optional(),
    osVersion: z.string().min(1).max(60).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    apiErrorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,80}$/)
      .optional(),
    errorDomain: z
      .string()
      .regex(/^[A-Za-z0-9_.]{1,80}$/)
      .optional(),
    errorCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    errorKind: z.enum(collectorErrorKinds).optional(),
    message: z.string().max(300).optional(),
    projectCount: z.number().int().min(0).max(1_000_000).optional(),
    sessionCount: z.number().int().min(0).max(1_000_000).optional(),
    failedSessionCount: z.number().int().min(0).max(1_000_000).optional(),
    partIndex: z.number().int().min(0).max(10_000).optional(),
    partCount: z.number().int().min(0).max(10_000).optional(),
    bytes: z.number().int().min(0).max(1_000_000_000).optional(),
    windowStart: z.string().datetime().optional(),
    windowEnd: z.string().datetime().optional(),
    periodKey: z.string().min(1).max(120).optional(),
    policyVersion: z.number().int().min(0).max(1_000_000).optional(),
    agent: z
      .enum([
        "codex",
        "claude",
        "opencode",
        "pi",
        "hermes",
        "omp",
        "grokbuild",
        "agy",
      ])
      .optional(),
    retryAttempt: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();
export type CollectorLogDetails = z.infer<typeof collectorLogDetailsSchema>;

export const collectorLogSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            eventId: z.string().uuid(),
            occurredAt: z.string().datetime(),
            stage: z.enum(collectorLogStages),
            level: z.enum(["info", "warning", "error"]),
            code: z.enum(collectorLogCodes),
            uploadId: z.string().uuid().optional(),
            sessionCount: z.number().int().min(0).max(1_000_000),
            state: z
              .object({
                startupStage: z.enum([
                  "binding",
                  "permissions",
                  "welcome",
                  "scanning",
                  "ready",
                ]),
                projectCount: z.number().int().nonnegative(),
                allowedProjectCount: z.number().int().nonnegative(),
                sessionCount: z.number().int().nonnegative(),
                unreadableSessionCount: z.number().int().nonnegative(),
                pendingSessionCount: z.number().int().nonnegative(),
                isScanning: z.boolean(),
                isUploading: z.boolean(),
                scanProcessed: z.number().int().nonnegative(),
                scanTotal: z.number().int().nonnegative(),
                uploadProcessed: z.number().int().nonnegative(),
                uploadTotal: z.number().int().nonnegative(),
                autoUpload: z.boolean(),
                frequency: z.enum(["daily", "weekly"]),
                uploadHour: z.number().int().min(0).max(23),
                uploadMinute: z.number().int().min(0).max(59),
                uploadWeekday: z
                  .number()
                  .int()
                  .min(1)
                  .max(7)
                  .nullable()
                  .optional(),
              })
              .strict()
              .optional(),
            details: collectorLogDetailsSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export function validateCollectorSessions(
  sessions: z.infer<typeof collectorSessionsSchema>,
  manifest: { startsAt: string | Date; endsAt: string | Date },
  allowed: Set<string>,
) {
  const start = new Date(manifest.startsAt).getTime();
  const end = new Date(manifest.endsAt).getTime();
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!allowed.has(session.scopeKey)) return "PROJECT_NOT_ALLOWED";
    const time = Date.parse(session.modifiedAt);
    if (time < start || time > end) return "SESSION_OUTSIDE_WINDOW";
    if (ids.has(session.id)) return "DUPLICATE_SESSION";
    ids.add(session.id);
  }
  return null;
}
