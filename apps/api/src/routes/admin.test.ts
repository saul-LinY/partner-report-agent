import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginConnectivityStatus, pluginRunStatus } from "./admin.js";

const now = new Date("2026-08-02T09:00:00.000Z");
const base = {
  status: "active",
  version: "0.2.0",
  minimumPluginVersion: "0.2.0",
  lastCollectionCompletedAt: now,
  retryCount: 0,
  lastErrorCode: null,
};

describe("Plugin Fleet status projection", () => {
  afterEach(() => vi.useRealTimers());

  it("projects healthy, delayed, offline and blocked states", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(pluginRunStatus(base)).toBe("healthy");
    expect(
      pluginRunStatus({
        ...base,
        lastCollectionCompletedAt: new Date(now.getTime() - 7.5 * 86_400_000),
      }),
    ).toBe("abnormal");
    expect(pluginRunStatus({ ...base, retryCount: 1 })).toBe("abnormal");
    expect(pluginRunStatus({ ...base, runnerState: "error" })).toBe("abnormal");
    expect(
      pluginRunStatus({
        ...base,
        lastCollectionCompletedAt: new Date(now.getTime() - 9 * 86_400_000),
      }),
    ).toBe("offline");
    expect(pluginRunStatus({ ...base, status: "revoked" })).toBe("blocked");
    expect(pluginRunStatus({ ...base, version: "0.0.9" })).toBe("blocked");
  });

  it("keeps a newly connected plugin in waiting-first-run state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(pluginRunStatus({ ...base, lastCollectionCompletedAt: null })).toBe(
      "waiting_first_run",
    );
    expect(
      pluginRunStatus({
        ...base,
        lastCollectionCompletedAt: null,
        runnerState: "error",
      }),
    ).toBe("abnormal");
  });

  it("projects connectivity independently from collection health", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(
      pluginConnectivityStatus({
        status: "active",
        connectivityStatus: "verified",
        connectivityChallengeExpiresAt: new Date(now.getTime() - 60_000),
      }),
    ).toBe("verified");
    expect(
      pluginConnectivityStatus({
        status: "active",
        connectivityStatus: "pending",
        connectivityChallengeExpiresAt: new Date(now.getTime() - 60_000),
      }),
    ).toBe("expired");
    expect(
      pluginConnectivityStatus({
        status: "active",
        connectivityStatus: "failed",
        connectivityChallengeExpiresAt: new Date(now.getTime() + 60_000),
      }),
    ).toBe("failed");
  });
});
