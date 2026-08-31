import { isDeepStrictEqual } from "node:util";

export const MAX_EXTRACTION_FAILURES = 3;
export const COLLECTION_RUN_BUDGET_MS = 50 * 60_000;
export const COLLECTION_JOB_RESERVE_MS = 5 * 60_000;

export const extractionFailureCodes = [
  "RESULT_JSON_INVALID",
  "SCHEMA_VALIDATION_FAILED",
  "IMMUTABLE_FIELD_MISMATCH",
  "CHINESE_OUTPUT_REQUIRED",
  "SENSITIVE_EGRESS_REJECTED",
] as const;

export type ExtractionFailureCode = (typeof extractionFailureCodes)[number];

export type ExtractionFailure = {
  code: ExtractionFailureCode;
  occurredAt: string;
};

export type JobTerminalStatus =
  "uploaded" | "ignored" | "skipped" | "failedExtract" | "deferred";

export type JobOutcome = {
  jobId: string;
  threadId?: string;
  status: JobTerminalStatus;
  errorCode?: string;
  causeCode?: ExtractionFailureCode;
  failureCount: number;
  failureCodes: ExtractionFailureCode[];
};

const immutableContributionKeys = [
  "schemaVersion",
  "periodKey",
  "sessionKey",
  "contentHash",
  "project",
  "activity",
  "observedAt",
  "production",
] as const;

export function immutableContributionFromRequirements(
  contribution: Record<string, unknown>,
) {
  return Object.fromEntries(
    immutableContributionKeys.map((key) => [key, contribution[key]]),
  );
}

export function collectionDeadline(createdAt: string) {
  return new Date(
    new Date(createdAt).getTime() + COLLECTION_RUN_BUDGET_MS,
  ).toISOString();
}

export function missingSessionCoverage<T extends { id: string }>(
  authorizedSessions: T[],
  processedSessionIds: Iterable<string>,
  sessionKey: (session: T) => string = (session) => session.id,
) {
  const processed = new Set(processedSessionIds);
  const seen = new Set<string>();
  return authorizedSessions.filter((session) => {
    const key = sessionKey(session);
    if (processed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function orderLocalCollectionFirst<T extends { hostId: string }>(
  queue: T[],
  localHostId: string,
) {
  return [...queue].sort(
    (left, right) =>
      Number(left.hostId !== localHostId) -
      Number(right.hostId !== localHostId),
  );
}

export function completedCollectionSources<
  T extends { hostId: string },
>(input: {
  queue: T[];
  processedSessionIds: Iterable<string>;
  sessionKey: (session: T) => string;
  localHostId: string;
  remoteHostIds: string[];
  remoteDiscoveryComplete: boolean;
}) {
  const processed = new Set(input.processedSessionIds);
  const sourceComplete = (hostId: string) =>
    input.queue
      .filter((session) => session.hostId === hostId)
      .every((session) => processed.has(input.sessionKey(session)));
  return {
    localComplete: sourceComplete(input.localHostId),
    completedRemoteHostIds: input.remoteDiscoveryComplete
      ? input.remoteHostIds.filter(sourceComplete)
      : [],
  };
}

export function reviewSnapshotCoverage<T extends { id: string }>(input: {
  snapshot: T[];
  processedSessionIds: Iterable<string>;
  terminalSessionIds: Iterable<string>;
  unresolvedSessionIds: Iterable<string>;
  sessionKey?: (session: T) => string;
}) {
  const terminal = new Set([
    ...input.processedSessionIds,
    ...input.terminalSessionIds,
  ]);
  const unresolved = new Set(input.unresolvedSessionIds);
  const sessionKey = input.sessionKey ?? ((session: T) => session.id);
  const missing = missingSessionCoverage(input.snapshot, terminal, sessionKey);
  return {
    retry: missing.filter((session) => unresolved.has(sessionKey(session))),
    unaccounted: missing.filter(
      (session) => !unresolved.has(sessionKey(session)),
    ),
  };
}

export function shouldStopBeforeClaim(
  deadlineAt: string,
  now = Date.now(),
  reserveMs = COLLECTION_JOB_RESERVE_MS,
) {
  const deadline = new Date(deadlineAt).getTime();
  return !Number.isFinite(deadline) || deadline - now <= reserveMs;
}

export function repairImmutableResult(result: unknown, expected: unknown) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result as Record<string, unknown>).decision !== "include" ||
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected)
  ) {
    return { result, repaired: false };
  }
  const record = result as Record<string, unknown>;
  const originalContribution =
    record.contribution &&
    typeof record.contribution === "object" &&
    !Array.isArray(record.contribution)
      ? (record.contribution as Record<string, unknown>)
      : {};
  const contribution = { ...originalContribution };
  for (const key of immutableContributionKeys)
    contribution[key] = (expected as Record<string, unknown>)[key];
  const repairedResult = { ...record, contribution };
  return {
    result: repairedResult,
    repaired: !isDeepStrictEqual(repairedResult, result),
  };
}

export function appendExtractionFailure(
  failures: ExtractionFailure[],
  code: ExtractionFailureCode,
  occurredAt = new Date().toISOString(),
) {
  if (failures.length >= MAX_EXTRACTION_FAILURES) return failures;
  return [...failures, { code, occurredAt }];
}

export function canMarkExtractFailed(
  failures: ExtractionFailure[],
  causeCode: string | undefined,
) {
  return (
    failures.length >= MAX_EXTRACTION_FAILURES &&
    extractionFailureCodes.includes(causeCode as ExtractionFailureCode) &&
    failures.at(-1)?.code === causeCode
  );
}

export function legalCollectSkipOutcome(input: {
  currentJobId: string;
  requestedJobId: string | undefined;
  errorCode: string | undefined;
  causeCode: string | undefined;
  failures: ExtractionFailure[];
}): Omit<JobOutcome, "jobId" | "failureCount" | "failureCodes"> {
  if (input.requestedJobId !== input.currentJobId)
    throw Object.assign(new Error("collect-skip 必须显式匹配当前 Job。"), {
      code: "JOB_ID_REQUIRED",
    });
  if (input.errorCode === "EXTRACT_FAILED") {
    if (!canMarkExtractFailed(input.failures, input.causeCode))
      throw Object.assign(
        new Error(
          "EXTRACT_FAILED 仅允许在同一 Job 连续三次真实校验失败后使用，并且必须保留最后一次安全原因码。",
        ),
        { code: "EXTRACT_FAILED_NOT_ALLOWED" },
      );
    return {
      status: "failedExtract",
      errorCode: input.errorCode,
      causeCode: input.causeCode as ExtractionFailureCode,
    };
  }
  if (
    input.errorCode === "SENSITIVE_EGRESS_REJECTED" &&
    input.failures.at(-1)?.code === input.errorCode
  )
    return {
      status: "skipped",
      errorCode: input.errorCode,
      causeCode: input.errorCode,
    };
  throw Object.assign(
    new Error("collect-skip 缺少合法、安全且与当前 Job 匹配的错误码。"),
    { code: "COLLECT_SKIP_NOT_ALLOWED" },
  );
}

export function failedExtractOutcomeIsExplained(outcome: JobOutcome) {
  const failureCodes = Array.isArray(outcome.failureCodes)
    ? outcome.failureCodes
    : [];
  return (
    outcome.status !== "failedExtract" ||
    (outcome.errorCode === "EXTRACT_FAILED" &&
      outcome.failureCount >= MAX_EXTRACTION_FAILURES &&
      failureCodes.length === outcome.failureCount &&
      failureCodes.at(-1) === outcome.causeCode &&
      extractionFailureCodes.includes(
        outcome.causeCode as ExtractionFailureCode,
      ))
  );
}

export function jobOutcomeFailureAuditIsValid(outcome: JobOutcome) {
  const failureCodes = Array.isArray(outcome.failureCodes)
    ? outcome.failureCodes
    : [];
  return (
    failureCodes.length === outcome.failureCount &&
    failureCodes.every((code) => extractionFailureCodes.includes(code))
  );
}

export function countJobOutcomes(outcomes: JobOutcome[]) {
  const counts = {
    uploaded: 0,
    ignored: 0,
    skipped: 0,
    failedExtract: 0,
    deferred: 0,
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}
