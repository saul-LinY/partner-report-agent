import { describe, expect, it } from "vitest";
import { projectSystemComponents } from "./monitoring.js";

const now = new Date("2026-08-24T09:30:00.000Z");

describe("system monitoring components", () => {
  it("detects an absent worker even with an empty queue, and missing model credentials", () => {
    const base = {
      queue: {
        pending: 0,
        leased: 0,
        retryWait: 0,
        expiredLeases: 0,
        oldestActiveAt: null,
      },
      generation: { failed: 0, retryWait: 0, completed24h: 0 },
      notifications: { pending: 0, stalePending: 0, delivered24h: 0 },
      reports: { aggregating: 0, staleAggregating: 0, drafts: 0, locked24h: 0 },
    };
    expect(
      projectSystemComponents({ ...base, worker: null }, now).find(
        (c) => c.key === "queue",
      ),
    ).toMatchObject({ severity: "critical", summary: "后台任务进程离线" });
    expect(
      projectSystemComponents(
        {
          ...base,
          worker: {
            heartbeat_at: now,
            status: "idle",
            capabilities: { modelConfigured: false },
          },
        },
        now,
      ).find((c) => c.key === "generation"),
    ).toMatchObject({ severity: "critical", summary: "模型未配置" });
  });
  it("raises actionable severities for blocked jobs and message failures", () => {
    const components = projectSystemComponents(
      {
        queue: {
          pending: 2,
          leased: 1,
          retryWait: 1,
          expiredLeases: 1,
          oldestActiveAt: "2026-08-24T08:00:00.000Z",
        },
        generation: { failed: 2, retryWait: 1, completed24h: 6 },
        notifications: { pending: 1, stalePending: 1, delivered24h: 12 },
        reports: {
          aggregating: 1,
          staleAggregating: 0,
          drafts: 2,
          locked24h: 1,
        },
      },
      now,
    );
    expect(components.find((item) => item.key === "queue")?.severity).toBe(
      "critical",
    );
    expect(components.find((item) => item.key === "generation")?.severity).toBe(
      "critical",
    );
    expect(
      components.find((item) => item.key === "notifications")?.severity,
    ).toBe("warning");
    expect(components.find((item) => item.key === "reports")?.severity).toBe(
      "warning",
    );
  });
});
