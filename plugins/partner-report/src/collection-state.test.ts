import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCollectionLease,
  advanceHostCollectionCheckpoint,
  canAdvanceCollectionCheckpoint,
  collectionWindow,
  hostCollectionWindow,
  initialProjectDiscoveryNeedsResume,
  initialProjectScopeStartAt,
  initializeCollectionFloor,
  loadCollectionState,
  recordAcceptedSession,
  recordIgnoredSession,
  refreshCollectionLease,
  releaseCollectionLease,
  reviewCollectionCompletion,
  saveCollectionState,
  threadIsInKnownScanWindow,
  threadIsInScanWindow,
  threadCouldContainWindowAnswer,
} from "./collection-state.js";

const pluginInstanceId = "33333333-3333-4333-8333-333333333333";
const sessionKey = "a".repeat(64);
const contentHash = "b".repeat(64);
const directories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(
    resolve(tmpdir(), "partner-report-state-test-"),
  );
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0)
    rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("collection state", () => {
  it("resumes only incomplete initial project discovery", () => {
    expect(initialProjectDiscoveryNeedsResume(true, true, true)).toBe(true);
    expect(initialProjectDiscoveryNeedsResume(false, false, true)).toBe(true);
    expect(initialProjectDiscoveryNeedsResume(false, true, false)).toBe(true);
    expect(initialProjectDiscoveryNeedsResume(false, true, true)).toBe(false);
  });

  it("starts the first collection at Monday 00:00 Beijing time", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    initializeCollectionFloor(state, "2026-08-05T02:00:00.000Z");
    expect(state.collectionFloorAt).toBe("2026-08-02T16:00:00.000Z");
    expect(
      collectionWindow(
        state,
        {
          starts_at: "2026-07-29T02:00:00.000Z",
          ends_at: "2026-08-05T02:00:00.000Z",
        },
        "2026-08-05T02:00:00.000Z",
      ),
    ).toMatchObject({
      extractionStartsAt: "2026-08-02T16:00:00.000Z",
      scanStartsAt: "2026-08-02T16:00:00.000Z",
    });
  });

  it("does not reset an existing collection floor during reconnect", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    state.collectionFloorAt = "2026-08-01T02:00:00.000Z";

    expect(initializeCollectionFloor(state, "2026-08-05T02:00:00.000Z")).toBe(
      "2026-08-01T02:00:00.000Z",
    );
  });

  it("uses a one-day overlap after a successful run", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    state.collectionFloorAt = "2026-08-02T02:00:00.000Z";
    state.lastSuccessfulRunStartedAt = "2026-08-04T02:00:00.000Z";
    state.weekBackfillCompletedFor = "2026-08-02T16:00:00.000Z";
    expect(
      collectionWindow(
        state,
        {
          starts_at: "2026-07-29T02:00:00.000Z",
          ends_at: "2026-08-06T02:00:00.000Z",
        },
        "2026-08-05T02:00:00.000Z",
      ).scanStartsAt,
    ).toBe("2026-08-03T02:00:00.000Z");
  });

  it("keeps the successful cursor across a report-period cutoff", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    state.collectionFloorAt = "2026-08-01T00:00:00.000Z";
    state.lastSuccessfulRunStartedAt = "2026-08-07T08:00:00.000Z";
    expect(
      collectionWindow(
        state,
        {
          starts_at: "2026-08-07T09:00:00.000Z",
          ends_at: "2026-08-14T09:00:00.000Z",
        },
        "2026-08-08T08:00:00.000Z",
      ),
    ).toMatchObject({
      extractionStartsAt: "2026-08-02T16:00:00.000Z",
      scanStartsAt: "2026-08-02T16:00:00.000Z",
    });
  });

  it("backfills a period once after upgrading an existing successful state", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    state.collectionFloorAt = "2026-08-04T02:00:00.000Z";
    state.lastSuccessfulRunStartedAt = "2026-08-05T02:00:00.000Z";

    expect(
      collectionWindow(
        state,
        {
          starts_at: "2026-08-03T16:00:00.000Z",
          ends_at: "2026-08-10T16:00:00.000Z",
        },
        "2026-08-06T02:00:00.000Z",
      ),
    ).toMatchObject({
      extractionStartsAt: "2026-08-02T16:00:00.000Z",
      scanStartsAt: "2026-08-02T16:00:00.000Z",
    });
  });

  it("reopens the current week once after upgrading the coverage semantics", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      resolve(directory, "collection-state.json"),
      JSON.stringify({
        schemaVersion: "3.0",
        pluginInstanceId,
        collectionFloorAt: "2026-08-23T16:00:00.000Z",
        lastSuccessfulRunStartedAt: "2026-08-25T04:10:52.000Z",
        weekBackfillCompletedFor: "2026-08-23T16:00:00.000Z",
        acceptedSessions: {},
        ignoredSessions: {},
        processedTurns: {},
      }),
    );

    const state = loadCollectionState(pluginInstanceId, directory);
    expect(state).toMatchObject({
      schemaVersion: "6.0",
      lastSuccessfulRunStartedAt: "2026-08-25T04:10:52.000Z",
      weekBackfillCompletedFor: null,
    });
    expect(
      collectionWindow(
        state,
        {
          starts_at: "2026-08-23T16:00:00.000Z",
          ends_at: "2026-08-30T16:00:00.000Z",
        },
        "2026-08-25T06:00:00.000Z",
      ),
    ).toMatchObject({
      extractionStartsAt: "2026-08-23T16:00:00.000Z",
      scanStartsAt: "2026-08-23T16:00:00.000Z",
    });
  });

  it("persists ignored content hashes without raw Session data", () => {
    const directory = temporaryDirectory();
    const state = loadCollectionState(pluginInstanceId, directory);
    recordIgnoredSession(
      state,
      sessionKey,
      contentHash,
      "2026-08-05T02:00:00.000Z",
    );
    saveCollectionState(state, directory);
    expect(
      loadCollectionState(pluginInstanceId, directory).ignoredSessions,
    ).toEqual({
      [sessionKey]: {
        contentHash,
        processedAt: "2026-08-05T02:00:00.000Z",
      },
    });
  });

  it("persists accepted hashes and keeps only the latest local decision", () => {
    const directory = temporaryDirectory();
    const state = loadCollectionState(pluginInstanceId, directory);
    recordAcceptedSession(
      state,
      sessionKey,
      contentHash,
      "2026-08-05T02:00:00.000Z",
    );
    expect(state.acceptedSessions[sessionKey]).toEqual({
      contentHash,
      processedAt: "2026-08-05T02:00:00.000Z",
    });
    recordIgnoredSession(
      state,
      sessionKey,
      "c".repeat(64),
      "2026-08-05T03:00:00.000Z",
    );
    expect(state.acceptedSessions[sessionKey]).toBeUndefined();
    expect(state.ignoredSessions[sessionKey]?.contentHash).toBe("c".repeat(64));
  });

  it("drops obsolete turn checkpoints when migrating to whole-Session versions", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      resolve(directory, "collection-state.json"),
      JSON.stringify({
        schemaVersion: "4.0",
        pluginInstanceId,
        collectionFloorAt: "2026-08-03T00:00:00.000Z",
        lastSuccessfulRunStartedAt: "2026-08-05T02:00:00.000Z",
        weekBackfillCompletedFor: "2026-08-02T16:00:00.000Z",
        acceptedSessions: {},
        ignoredSessions: {},
        processedTurns: { [sessionKey]: { ["d".repeat(64)]: {} } },
      }),
    );
    const state = loadCollectionState(pluginInstanceId, directory);
    expect(state.schemaVersion).toBe("6.0");
    expect(state.weekBackfillCompletedFor).toBeNull();
    expect(state).not.toHaveProperty("processedTurns");
  });

  it("migrates state written before accepted hashes existed", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      resolve(directory, "collection-state.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        pluginInstanceId,
        collectionFloorAt: null,
        lastSuccessfulRunStartedAt: null,
        ignoredSessions: {},
      }),
    );
    expect(loadCollectionState(pluginInstanceId, directory)).toMatchObject({
      schemaVersion: "6.0",
      hostCheckpoints: {},
      acceptedSessions: {},
      ignoredSessions: {},
    });
  });

  it("keeps local and remote Host collection checkpoints independent", () => {
    const directory = temporaryDirectory();
    const state = loadCollectionState(pluginInstanceId, directory);
    initializeCollectionFloor(state, "2026-08-24T02:00:00.000Z");
    state.lastSuccessfulRunStartedAt = "2026-08-29T02:00:00.000Z";
    state.weekBackfillCompletedFor = "2026-08-23T16:00:00.000Z";
    advanceHostCollectionCheckpoint(
      state,
      "host-a",
      "2026-08-27T02:00:00.000Z",
    );
    saveCollectionState(state, directory);
    const persisted = loadCollectionState(pluginInstanceId, directory);
    const period = {
      starts_at: "2026-08-23T16:00:00.000Z",
      ends_at: "2026-08-30T16:00:00.000Z",
    };

    expect(
      collectionWindow(persisted, period, "2026-08-30T02:00:00.000Z")
        .extractionStartsAt,
    ).toBe("2026-08-29T02:00:00.000Z");
    expect(
      hostCollectionWindow(
        persisted,
        "host-a",
        period,
        "2026-08-30T02:00:00.000Z",
      ).extractionStartsAt,
    ).toBe("2026-08-27T02:00:00.000Z");
    expect(
      hostCollectionWindow(
        persisted,
        "host-b",
        period,
        "2026-08-30T02:00:00.000Z",
      ).extractionStartsAt,
    ).toBe("2026-08-23T16:00:00.000Z");
  });

  it("stores a Host checkpoint without treating its id as an object key directive", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    advanceHostCollectionCheckpoint(
      state,
      "__proto__",
      "2026-08-27T02:00:00.000Z",
    );
    expect(Object.hasOwn(state.hostCheckpoints, "__proto__")).toBe(true);
    expect(state.hostCheckpoints.__proto__).toMatchObject({
      lastSuccessfulRunStartedAt: "2026-08-27T02:00:00.000Z",
    });
  });

  it("filters candidates by their updated time and keeps unknown times", () => {
    expect(
      threadIsInScanWindow(
        "2026-08-04T02:00:00.000Z",
        "2026-08-03T02:00:00.000Z",
        "2026-08-05T02:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      threadIsInScanWindow(
        "2026-08-02T02:00:00.000Z",
        "2026-08-03T02:00:00.000Z",
        "2026-08-05T02:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      threadIsInScanWindow(
        null,
        "2026-08-03T02:00:00.000Z",
        "2026-08-05T02:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("requires timestamps for known scan candidates", () => {
    expect(
      threadIsInKnownScanWindow(
        "2026-07-31T23:59:59.000Z",
        "2026-08-01T00:00:00.000Z",
        "2026-08-07T04:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      threadIsInKnownScanWindow(
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "2026-08-07T04:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      threadIsInKnownScanWindow(
        null,
        "2026-08-01T00:00:00.000Z",
        "2026-08-07T04:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("keeps metadata updated after the cutoff for complete-Q&A inspection", () => {
    expect(
      threadCouldContainWindowAnswer(
        "2026-08-06T02:00:00.000Z",
        "2026-08-03T02:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      threadCouldContainWindowAnswer(
        "2026-08-02T23:59:59.000Z",
        "2026-08-03T02:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      threadCouldContainWindowAnswer(null, "2026-08-03T02:00:00.000Z"),
    ).toBe(true);
  });

  it("limits first project discovery to the previous seven days", () => {
    expect(initialProjectScopeStartAt("2026-08-07T11:46:00+08:00")).toBe(
      "2026-07-31T03:46:00.000Z",
    );
  });

  it("advances the checkpoint only when every candidate was handled", () => {
    expect(
      canAdvanceCollectionCheckpoint({ failedRead: 0, failedExtract: 0 }),
    ).toBe(true);
    expect(
      canAdvanceCollectionCheckpoint({ failedRead: 1, failedExtract: 0 }),
    ).toBe(false);
    expect(
      canAdvanceCollectionCheckpoint({
        failedRead: 1,
        invalidThreadHistory: 1,
        failedExtract: 0,
      }),
    ).toBe(false);
    expect(
      canAdvanceCollectionCheckpoint({
        failedRead: 2,
        invalidThreadHistory: 1,
        failedExtract: 0,
      }),
    ).toBe(false);
    expect(
      canAdvanceCollectionCheckpoint({
        failedRead: 0,
        invalidThreadHistory: 1,
        failedExtract: 0,
      }),
    ).toBe(false);
    expect(
      canAdvanceCollectionCheckpoint({ failedRead: 0, failedExtract: 1 }),
    ).toBe(false);
    expect(
      canAdvanceCollectionCheckpoint({
        failedRead: 0,
        failedExtract: 0,
        deferred: 1,
      }),
    ).toBe(false);
    expect(
      canAdvanceCollectionCheckpoint({
        failedRead: 0,
        failedExtract: 0,
        notProcessed: 1,
      }),
    ).toBe(false);
  });

  it("requires an exhausted queue and no active job before final review", () => {
    expect(
      reviewCollectionCompletion({
        cursor: 2,
        queueLength: 3,
        hasCurrentJob: false,
        counts: { failedRead: 0, failedExtract: 0 },
      }),
    ).toMatchObject({ readyToFinalize: false, queueExhausted: false });
    expect(
      reviewCollectionCompletion({
        cursor: 3,
        queueLength: 3,
        hasCurrentJob: true,
        counts: { failedRead: 0, failedExtract: 0 },
      }),
    ).toMatchObject({ readyToFinalize: false, noCurrentJob: false });
    expect(
      reviewCollectionCompletion({
        cursor: 3,
        queueLength: 3,
        hasCurrentJob: false,
        counts: { failedRead: 0, failedExtract: 0 },
      }),
    ).toEqual({
      queueExhausted: true,
      noCurrentJob: true,
      allClaimedJobsTerminal: true,
      uniqueTerminalJobs: true,
      validFailureAudits: true,
      noUnexplainedFailedExtract: true,
      outcomeCountsMatch: true,
      coverageComplete: true,
      remainingQueueExplained: true,
      readyToFinalize: true,
      checkpointEligible: true,
    });
  });

  it("refuses to finalize partial runs", () => {
    expect(
      reviewCollectionCompletion({
        cursor: 3,
        queueLength: 3,
        hasCurrentJob: false,
        counts: { failedRead: 1, failedExtract: 0 },
      }),
    ).toEqual({
      queueExhausted: true,
      noCurrentJob: true,
      allClaimedJobsTerminal: true,
      uniqueTerminalJobs: true,
      validFailureAudits: true,
      noUnexplainedFailedExtract: true,
      outcomeCountsMatch: true,
      coverageComplete: true,
      remainingQueueExplained: true,
      readyToFinalize: false,
      checkpointEligible: false,
    });
  });

  it("does not advance after invalid thread history failures", () => {
    expect(
      reviewCollectionCompletion({
        cursor: 3,
        queueLength: 3,
        hasCurrentJob: false,
        counts: {
          failedRead: 2,
          invalidThreadHistory: 2,
          failedExtract: 0,
        },
      }),
    ).toMatchObject({
      readyToFinalize: false,
      checkpointEligible: false,
    });
  });

  it("requires the fixed-window coverage audit to complete", () => {
    expect(
      reviewCollectionCompletion({
        cursor: 3,
        queueLength: 3,
        hasCurrentJob: false,
        coverageComplete: false,
        counts: { failedRead: 0, failedExtract: 0 },
      }),
    ).toMatchObject({
      coverageComplete: false,
      readyToFinalize: false,
      checkpointEligible: false,
    });
  });
});

describe("collection lease", () => {
  it("blocks a concurrent run and releases the owner lease", () => {
    const directory = temporaryDirectory();
    const now = new Date("2026-08-05T02:00:00.000Z");
    acquireCollectionLease(pluginInstanceId, "run-one", now, directory);
    expect(() =>
      acquireCollectionLease(pluginInstanceId, "run-two", now, directory),
    ).toThrow("正在运行");
    refreshCollectionLease(pluginInstanceId, "run-one", now, directory);
    releaseCollectionLease(pluginInstanceId, "run-one", directory);
    expect(() =>
      acquireCollectionLease(pluginInstanceId, "run-two", now, directory),
    ).not.toThrow();
  });

  it("allows takeover after a stale lease", () => {
    const directory = temporaryDirectory();
    acquireCollectionLease(
      pluginInstanceId,
      "run-one",
      new Date("2026-08-05T01:00:00.000Z"),
      directory,
    );
    expect(() =>
      acquireCollectionLease(
        pluginInstanceId,
        "run-two",
        new Date("2026-08-05T01:06:00.000Z"),
        directory,
      ),
    ).not.toThrow();
  });
});
