import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCollectionLease,
  canAdvanceCollectionCheckpoint,
  collectionWindow,
  initializeCollectionFloor,
  loadCollectionState,
  recordIgnoredSession,
  refreshCollectionLease,
  releaseCollectionLease,
  saveCollectionState,
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
