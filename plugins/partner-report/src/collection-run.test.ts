import { sessionExtractionResultSchema } from "@partner-report/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTION_FAILURES,
  appendExtractionFailure,
  canMarkExtractFailed,
  collectionDeadline,
  completedCollectionSources,
  countJobOutcomes,
  failedExtractOutcomeIsExplained,
  immutableContributionFromRequirements,
  jobOutcomeFailureAuditIsValid,
  legalCollectSkipOutcome,
  missingSessionCoverage,
  orderLocalCollectionFirst,
  repairImmutableResult,
  remoteCollectionCanStart,
  remoteCollectionStatus,
  reviewSnapshotCoverage,
  shouldStopBeforeClaim,
  splitCollectionSources,
  type ExtractionFailure,
  type JobOutcome,
} from "./collection-run.js";
import { reviewCollectionCompletion } from "./collection-state.js";

const expectedContribution = {
  schemaVersion: "1.0",
  periodKey: "2026-W32",
  sessionKey: "a".repeat(64),
  contentHash: "b".repeat(64),
  project: {
    id: null,
    name: "partner-report-agent",
    matchMethod: "path_discovered",
    rootFingerprint: "c".repeat(64),
    rootName: "partner-report-agent",
  },
  activity: {
    startedAt: "2026-08-04T04:00:00.000Z",
    endedAt: "2026-08-04T05:00:00.000Z",
  },
  observedAt: "2026-08-04T05:01:00.000Z",
  production: {
    skillVersion: "partner-report-sync/1.0.0",
    promptVersion: "2026-08-05.zh-session-value.v3",
    schemaVersion: "1.0",
    producer: "codex-skill",
  },
};

function failures(count: number, code = "SCHEMA_VALIDATION_FAILED") {
  let history: ExtractionFailure[] = [];
  for (let index = 0; index < count; index += 1)
    history = appendExtractionFailure(
      history,
      code as ExtractionFailure["code"],
      `2026-08-04T05:0${index}:00.000Z`,
    );
  return history;
}

describe("collection run guards", () => {
  it("keeps local and remote collection as separate peer sources", () => {
    const sources = splitCollectionSources(
      [
        { id: "same", hostId: "local" },
        { id: "same", hostId: "host-a" },
      ],
      "local",
    );
    expect(sources.local).toEqual([{ id: "same", hostId: "local" }]);
    expect(sources.remote).toEqual([{ id: "same", hostId: "host-a" }]);
  });

  it("does not initialize remote collection before the local checkpoint", () => {
    expect(
      remoteCollectionCanStart({
        localCheckpointAdvanced: false,
        remoteInitialized: false,
      }),
    ).toBe(false);
    expect(
      remoteCollectionCanStart({
        localCheckpointAdvanced: true,
        remoteInitialized: false,
      }),
    ).toBe(true);
    expect(
      remoteCollectionCanStart({
        localCheckpointAdvanced: true,
        remoteInitialized: true,
      }),
    ).toBe(false);
  });

  it("reports remote completion and pending permissions independently", () => {
    expect(
      remoteCollectionStatus({
        warningCount: 0,
        hostCount: 0,
        pendingProjectCount: 0,
      }),
    ).toBe("not_found");
    expect(
      remoteCollectionStatus({
        warningCount: 0,
        hostCount: 1,
        pendingProjectCount: 1,
      }),
    ).toBe("completed_with_pending_permission");
    expect(
      remoteCollectionStatus({
        warningCount: 1,
        hostCount: 1,
        pendingProjectCount: 0,
      }),
    ).toBe("partial");
  });

  it("keeps local jobs first and preserves local completion during remote failure", () => {
    const queue = orderLocalCollectionFirst(
      [
        { id: "remote", hostId: "host-a" },
        { id: "local", hostId: "local" },
      ],
      "local",
    );
    expect(queue.map((item) => item.id)).toEqual(["local", "remote"]);
    expect(
      completedCollectionSources({
        queue,
        processedSessionIds: ["local:local"],
        sessionKey: (item) => `${item.hostId}:${item.id}`,
        localHostId: "local",
        remoteHostIds: ["host-a"],
        remoteDiscoveryComplete: false,
      }),
    ).toEqual({ localComplete: true, completedRemoteHostIds: [] });
    expect(
      completedCollectionSources({
        queue,
        processedSessionIds: ["local:local", "host-a:remote"],
        sessionKey: (item) => `${item.hostId}:${item.id}`,
        localHostId: "local",
        remoteHostIds: ["host-a"],
        remoteDiscoveryComplete: true,
      }),
    ).toEqual({
      localComplete: true,
      completedRemoteHostIds: ["host-a"],
    });
  });
  it("finds every unprocessed authorized Session exactly once", () => {
    expect(
      missingSessionCoverage(
        [{ id: "processed" }, { id: "missing" }, { id: "missing" }],
        ["processed"],
      ),
    ).toEqual([{ id: "missing" }]);
  });

  it("audits the frozen Session snapshot without discovering new Sessions", () => {
    expect(
      reviewSnapshotCoverage({
        snapshot: [
          { id: "uploaded" },
          { id: "ignored" },
          { id: "failed-read" },
          { id: "unaccounted" },
          { id: "uploaded" },
        ],
        processedSessionIds: ["uploaded"],
        terminalSessionIds: ["ignored"],
        unresolvedSessionIds: ["failed-read"],
      }),
    ).toEqual({
      retry: [{ id: "failed-read" }],
      unaccounted: [{ id: "unaccounted" }],
    });
  });

  it("stops claiming before the time budget is exhausted", () => {
    const createdAt = "2026-08-10T02:00:00.000Z";
    const deadlineAt = collectionDeadline(createdAt);
    expect(
      shouldStopBeforeClaim(
        deadlineAt,
        new Date("2026-08-10T02:46:00.000Z").getTime(),
      ),
    ).toBe(true);
    expect(
      reviewCollectionCompletion({
        cursor: 2,
        queueLength: 5,
        hasCurrentJob: false,
        claimedJobs: 1,
        terminalJobs: 1,
        stopped: true,
        counts: {
          failedRead: 0,
          failedExtract: 0,
          deferred: 1,
          skipped: 0,
          notProcessed: 3,
        },
      }),
    ).toMatchObject({
      readyToFinalize: false,
      queueExhausted: false,
      checkpointEligible: false,
    });
  });

  it("records at most three schema failures for one Job", () => {
    const history = failures(4);
    expect(history).toHaveLength(MAX_EXTRACTION_FAILURES);
    expect(history.map((failure) => failure.code)).toEqual([
      "SCHEMA_VALIDATION_FAILED",
      "SCHEMA_VALIDATION_FAILED",
      "SCHEMA_VALIDATION_FAILED",
    ]);
  });

  it("does not allow EXTRACT_FAILED to clear unanalyzed Jobs", () => {
    expect(canMarkExtractFailed([], "SCHEMA_VALIDATION_FAILED")).toBe(false);
    expect(canMarkExtractFailed(failures(2), "SCHEMA_VALIDATION_FAILED")).toBe(
      false,
    );
    expect(canMarkExtractFailed(failures(3), "EXTRACT_FAILED")).toBe(false);
    expect(canMarkExtractFailed(failures(3), "SCHEMA_VALIDATION_FAILED")).toBe(
      true,
    );
    expect(() =>
      legalCollectSkipOutcome({
        currentJobId: "current",
        requestedJobId: "current",
        errorCode: "EXTRACT_FAILED",
        causeCode: "SCHEMA_VALIDATION_FAILED",
        failures: [],
      }),
    ).toThrow("连续三次");
    expect(() =>
      legalCollectSkipOutcome({
        currentJobId: "current",
        requestedJobId: "other",
        errorCode: "EXTRACT_FAILED",
        causeCode: "SCHEMA_VALIDATION_FAILED",
        failures: failures(3),
      }),
    ).toThrow("匹配当前 Job");
  });

  it("repairs immutable fields from output requirements before validation", () => {
    const expected = immutableContributionFromRequirements({
      ...expectedContribution,
      title: "模板标题",
      summary: "模板摘要",
      contributions: [],
    });
    const repaired = repairImmutableResult(
      {
        schemaVersion: "1.0",
        decision: "include",
        contribution: {
          ...expectedContribution,
          periodKey: "wrong-period",
          sessionKey: "d".repeat(64),
          production: { producer: "data-platform" },
          title: "完成采集状态机修改",
          summary: "增加延后处理与安全失败审计。",
          contributions: [
            {
              kind: "outcome",
              text: "完成采集状态机修改。",
              confidence: "high",
            },
          ],
        },
      },
      expected,
    );
    expect(repaired.repaired).toBe(true);
    expect(
      sessionExtractionResultSchema.safeParse(repaired.result).success,
    ).toBe(true);
    expect((repaired.result as any).contribution).toMatchObject(expected);
  });

  it("keeps deferred and failed extraction outcomes separate", () => {
    const outcomes: JobOutcome[] = [
      {
        jobId: "one",
        status: "deferred",
        failureCount: 0,
        failureCodes: [],
      },
      {
        jobId: "two",
        status: "failedExtract",
        errorCode: "EXTRACT_FAILED",
        causeCode: "CHINESE_OUTPUT_REQUIRED",
        failureCount: 3,
        failureCodes: [
          "SCHEMA_VALIDATION_FAILED",
          "CHINESE_OUTPUT_REQUIRED",
          "CHINESE_OUTPUT_REQUIRED",
        ],
      },
    ];
    expect(countJobOutcomes(outcomes)).toEqual({
      uploaded: 0,
      ignored: 0,
      skipped: 0,
      failedExtract: 1,
      deferred: 1,
    });
    expect(outcomes.every(failedExtractOutcomeIsExplained)).toBe(true);
    expect(outcomes.every(jobOutcomeFailureAuditIsValid)).toBe(true);
  });

  it("rejects an unexplained extraction failure during review", () => {
    expect(
      failedExtractOutcomeIsExplained({
        jobId: "one",
        status: "failedExtract",
        errorCode: "EXTRACT_FAILED",
        failureCount: 1,
        failureCodes: ["SCHEMA_VALIDATION_FAILED"],
      }),
    ).toBe(false);
  });
});
