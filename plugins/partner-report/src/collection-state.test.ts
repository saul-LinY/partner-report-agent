import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCollectionLease,
  canAdvanceCollectionCheckpoint,
  collectionWindow,
  currentMonthStartAt,
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
  it("limits the first collection to the latest day", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    initializeCollectionFloor(
      state,
      "2026-07-29T02:00:00.000Z",
      "2026-08-05T02:00:00.000Z",
    );
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
      extractionStartsAt: "2026-08-04T02:00:00.000Z",
      scanStartsAt: "2026-08-04T02:00:00.000Z",
    });
  });

  it("uses a one-day overlap after a successful run", () => {
    const state = loadCollectionState(pluginInstanceId, temporaryDirectory());
    state.collectionFloorAt = "2026-08-02T02:00:00.000Z";
    state.lastSuccessfulRunStartedAt = "2026-08-04T02:00:00.000Z";
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
      acceptedSessions: {},
      ignoredSessions: {},
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

  it("limits first project discovery to the current local calendar month", () => {
    expect(currentMonthStartAt("2026-08-07T11:46:00+08:00")).toBe(
      new Date(2026, 7, 1).toISOString(),
    );
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
      canAdvanceCollectionCheckpoint({ failedRead: 0, failedExtract: 1 }),
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
      readyToFinalize: true,
      checkpointEligible: true,
    });
  });

  it("allows partial runs to finalize without advancing the checkpoint", () => {
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
      readyToFinalize: true,
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
        new Date("2026-08-05T01:31:00.000Z"),
        directory,
      ),
    ).not.toThrow();
  });
});
