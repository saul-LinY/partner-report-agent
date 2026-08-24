import { afterEach, describe, expect, it, vi } from "vitest";
import {
  feishuConnectionStatus,
  nextManualRetryMaxAttempts,
  partnerReviewProgress,
  pluginConnectivityStatus,
  pluginRunStatus,
} from "./admin.js";

describe("Admin agent job retry", () => {
  it("preserves the attempt history and grants a fresh retry window", () => {
    expect(nextManualRetryMaxAttempts(3, 3)).toBe(6);
    expect(nextManualRetryMaxAttempts(2, 10)).toBe(10);
    expect(nextManualRetryMaxAttempts(11, 10)).toBe(14);
  });
});

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

describe("Feishu connection status projection", () => {
  const base = {
    configured: true,
    hasPlugin: true,
    bindingStatus: null,
    openId: null,
    deliveryStatus: null,
    lastSuccessfulAt: null,
    lastAttemptAt: null,
  };

  it("keeps Feishu identity separate from plugin connectivity", () => {
    expect(feishuConnectionStatus({ ...base, configured: false })).toBe(
      "unavailable",
    );
    expect(feishuConnectionStatus({ ...base, hasPlugin: false })).toBe(
      "not_started",
    );
    expect(feishuConnectionStatus(base)).toBe("not_connected");
    expect(
      feishuConnectionStatus({
        ...base,
        bindingStatus: "pending",
        deliveryStatus: "sending",
        lastAttemptAt: now,
      }),
    ).toBe("connecting");
    expect(
      feishuConnectionStatus({
        ...base,
        bindingStatus: "pending",
        deliveryStatus: "sent",
        lastSuccessfulAt: now,
        lastAttemptAt: now,
      }),
    ).toBe("connected");
    expect(
      feishuConnectionStatus({
        ...base,
        bindingStatus: "pending",
        deliveryStatus: "retry_wait",
        lastAttemptAt: now,
      }),
    ).toBe("failed");
    expect(
      feishuConnectionStatus({
        ...base,
        bindingStatus: "active",
        openId: "ou_partner",
        deliveryStatus: "confirmed",
        lastSuccessfulAt: now,
        lastAttemptAt: now,
      }),
    ).toBe("connected");
  });
});

describe("Partner review progress projection", () => {
  it("keeps card counts visible throughout Work Card review", () => {
    const base = {
      reviewId: "review-1",
      periodKey: "2026-W31",
      reviewState: "IN_PROGRESS",
      pendingCount: 1,
      approvedCount: 2,
      excludedCount: 1,
    };
    expect(partnerReviewProgress(base)).toEqual({
      periodKey: "2026-W31",
      stage: "reviewing_cards",
      reviewed: 3,
      total: 4,
      pending: 1,
      approved: 2,
      excluded: 1,
    });
    expect(
      partnerReviewProgress({
        ...base,
        pendingCount: 0,
        reviewState: "ITEMS_APPROVED",
      }),
    ).toMatchObject({ stage: "completed", reviewed: 3, total: 3 });
  });

  it("marks a person without review cards as not started", () => {
    expect(
      partnerReviewProgress({
        reviewId: null,
        periodKey: null,
        reviewState: null,
        pendingCount: null,
        approvedCount: null,
        excludedCount: null,
      }),
    ).toEqual({
      periodKey: null,
      stage: "not_started",
      reviewed: 0,
      total: 0,
      pending: 0,
      approved: 0,
      excluded: 0,
    });
  });
});
