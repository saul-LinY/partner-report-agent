import { describe, expect, it } from "vitest";
import {
  buildKnownSessionIndex,
  matchingKnownDecision,
} from "./collection-dedup.js";
import { countJobOutcomes, type JobOutcome } from "./collection-run.js";
import {
  canAdvanceCollectionCheckpoint,
  reviewCollectionCompletion,
} from "./collection-state.js";

describe("partial collection retry integration", () => {
  it("keeps a deferred Job non-terminal so the next run can retry it", () => {
    const sessionKey = "a".repeat(64);
    const contentHash = "b".repeat(64);
    const firstRunOutcomes: JobOutcome[] = [
      {
        jobId: "uploaded",
        status: "uploaded",
        failureCount: 0,
        failureCodes: [],
      },
      {
        jobId: "ignored",
        status: "ignored",
        failureCount: 0,
        failureCodes: [],
      },
      {
        jobId: "deferred",
        status: "deferred",
        errorCode: "TIME_BUDGET_EXHAUSTED",
        failureCount: 0,
        failureCodes: [],
      },
    ];
    const terminalCounts = countJobOutcomes(firstRunOutcomes);
    const counts = {
      ...terminalCounts,
      failedRead: 0,
      notProcessed: 2,
    };
    const review = reviewCollectionCompletion({
      cursor: 3,
      queueLength: 5,
      hasCurrentJob: false,
      claimedJobs: 3,
      terminalJobs: 3,
      stopped: true,
      outcomeCountsMatch: true,
      counts,
    });
    expect(review).toMatchObject({
      readyToFinalize: false,
      checkpointEligible: false,
    });
    expect(canAdvanceCollectionCheckpoint(counts)).toBe(false);

    const nextRunKnown = buildKnownSessionIndex({
      remoteAccepted: [],
      localAccepted: {},
      localIgnored: {},
    });
    expect(
      matchingKnownDecision(nextRunKnown[sessionKey], new Set([contentHash])),
    ).toBeNull();
    expect(terminalCounts).toEqual({
      uploaded: 1,
      ignored: 1,
      skipped: 0,
      failedExtract: 0,
      deferred: 1,
    });
  });
});
