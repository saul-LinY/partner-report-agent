import { afterEach, describe, expect, it, vi } from "vitest";
import {
  feishuBindingState,
  feishuConnectionState,
  feishuDeliveryState,
  pluginConnectivityStatus,
  pluginRunStatus,
} from "./admin.js";

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
  it("keeps binding state independent from delivery state", () => {
    expect(
      feishuBindingState({
        enabled: false,
        status: "active",
        openIdPresent: true,
      }),
    ).toBe("disabled");
    expect(
      feishuBindingState({
        enabled: true,
        status: null,
        openIdPresent: false,
      }),
    ).toBe("not_connected");
    expect(
      feishuBindingState({
        enabled: true,
        status: "pending",
        openIdPresent: false,
      }),
    ).toBe("pending");
    expect(
      feishuBindingState({
        enabled: true,
        status: "active",
        openIdPresent: true,
      }),
    ).toBe("connected");
    expect(
      feishuBindingState({
        enabled: true,
        status: "active",
        openIdPresent: false,
      }),
    ).toBe("invalid");
  });

  it("projects successful, in-flight and failed deliveries", () => {
    expect(feishuDeliveryState(null)).toBe("idle");
    expect(feishuDeliveryState("sent")).toBe("healthy");
    expect(feishuDeliveryState("confirmed")).toBe("healthy");
    expect(feishuDeliveryState("sending")).toBe("sending");
    expect(feishuDeliveryState("deferred")).toBe("deferred");
    expect(feishuDeliveryState("retry_wait")).toBe("retrying");
    expect(feishuDeliveryState("failed")).toBe("failed");
    expect(feishuDeliveryState("unexpected")).toBe("unknown");
  });

  it("surfaces delivery problems before and after the Partner is bound", () => {
    expect(feishuConnectionState("pending", "retrying")).toBe("delivery_error");
    expect(feishuConnectionState("connected", "sending")).toBe(
      "delivery_pending",
    );
    expect(feishuConnectionState("connected", "retrying")).toBe(
      "delivery_error",
    );
    expect(feishuConnectionState("connected", "healthy")).toBe("connected");
    expect(feishuConnectionState("connected", "unknown")).toBe(
      "delivery_error",
    );
    expect(feishuConnectionState("disabled", "healthy")).toBe("disabled");
  });
});
