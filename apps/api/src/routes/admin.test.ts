import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginHealth } from "./admin.js";

const now = new Date("2026-08-02T09:00:00.000Z");
const base = {
  status: "active",
  version: "0.2.0",
  minimumPluginVersion: "0.2.0",
  lastCollectionCompletedAt: now,
  retryCount: 0,
  lastErrorCode: null
};

describe("Plugin Fleet health projection", () => {
  afterEach(() => vi.useRealTimers());

  it("projects healthy, delayed, offline and blocked states", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(pluginHealth(base)).toBe("healthy");
    expect(pluginHealth({ ...base, lastCollectionCompletedAt: new Date(now.getTime() - 7.5 * 86_400_000) })).toBe("delayed");
    expect(pluginHealth({ ...base, retryCount: 1 })).toBe("delayed");
    expect(pluginHealth({ ...base, runnerState: "error" })).toBe("delayed");
    expect(pluginHealth({ ...base, lastCollectionCompletedAt: new Date(now.getTime() - 9 * 86_400_000) })).toBe("offline");
    expect(pluginHealth({ ...base, status: "revoked" })).toBe("blocked");
    expect(pluginHealth({ ...base, version: "0.0.9" })).toBe("blocked");
  });
});
