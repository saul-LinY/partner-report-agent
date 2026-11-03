import { describe, expect, it } from "vitest";
import {
  systemProbeKeys,
  probeFailureDetail,
  SystemProbeError,
} from "./system-probes.js";

describe("system probe diagnostics", () => {
  it("returns specific safe messages for known failures", () => {
    expect(probeFailureDetail("MODEL_NOT_CONFIGURED")).toContain("尚未配置");
    expect(probeFailureDetail("WORKER_PROBE_TIMEOUT")).toContain("Worker");
  });

  it("does not expose unknown provider errors", () => {
    expect(probeFailureDetail("provider-secret-response")).toBe(
      "模块测试没有正常完成。",
    );
  });

  it("keeps machine-readable error codes", () => {
    expect(new SystemProbeError("QUEUE_WORKER_UNHEALTHY").code).toBe(
      "QUEUE_WORKER_UNHEALTHY",
    );
  });

  it("probes the App notification queue", () => {
    expect(systemProbeKeys).toContain("notifications");
  });
});
