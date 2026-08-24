import { describe, expect, it } from "vitest";
import {
  projectPluginMonitoringStatus,
  projectSystemComponents,
} from "./monitoring.js";

const now = new Date("2026-08-24T09:30:00.000Z"); // 17:30 in Asia/Shanghai
const pluginBase = {
  createdAt: "2026-08-01T00:00:00.000Z",
  lastCollectionStartedAt: "2026-08-23T08:00:00.000Z",
  lastCollectionCompletedAt: "2026-08-23T08:10:00.000Z",
  lastHeartbeatAt: "2026-08-23T08:10:00.000Z",
  latestEventAt: "2026-08-23T08:10:00.000Z",
  latestEventCode: "command.completed",
  latestErrorAt: null,
  lastErrorCode: null,
  runnerState: "idle",
  retryCount: 0,
  pendingLocalJobs: 0,
};

describe("plugin monitoring status", () => {
  it("marks a missing daily run after the grace period", () => {
    expect(projectPluginMonitoringStatus(pluginBase, now)).toMatchObject({
      severity: "critical",
      code: "missed",
      label: "今日未运行",
    });
  });

  it("marks an open run without progress as interrupted", () => {
    expect(
      projectPluginMonitoringStatus(
        {
          ...pluginBase,
          lastCollectionStartedAt: "2026-08-24T08:00:00.000Z",
          lastCollectionCompletedAt: "2026-08-23T08:10:00.000Z",
          lastHeartbeatAt: "2026-08-24T08:01:00.000Z",
          latestEventAt: "2026-08-24T08:01:00.000Z",
          latestEventCode: "command.started",
        },
        now,
      ),
    ).toMatchObject({ severity: "critical", code: "interrupted" });
  });

  it("keeps an explicit approval wait out of the failure state", () => {
    expect(
      projectPluginMonitoringStatus(
        {
          ...pluginBase,
          lastCollectionStartedAt: "2026-08-24T08:00:00.000Z",
          lastCollectionCompletedAt: "2026-08-23T08:10:00.000Z",
          latestEventAt: "2026-08-24T08:01:00.000Z",
          latestEventCode: "project_scope_approval_waiting",
        },
        now,
      ),
    ).toMatchObject({ severity: "warning", code: "waiting" });
  });

  it("marks today's completed run as healthy", () => {
    expect(
      projectPluginMonitoringStatus(
        {
          ...pluginBase,
          lastCollectionStartedAt: "2026-08-24T08:00:00.000Z",
          lastCollectionCompletedAt: "2026-08-24T08:10:00.000Z",
          lastHeartbeatAt: "2026-08-24T08:10:00.000Z",
          latestEventAt: "2026-08-24T08:10:00.000Z",
        },
        now,
      ),
    ).toMatchObject({ severity: "normal", code: "healthy" });
  });
});

describe("system monitoring components", () => {
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
        feishu: {
          failed: 1,
          retryWait: 0,
          deferred: 0,
          stuckSending: 0,
          stalePending: 0,
          sent24h: 12,
        },
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
    expect(components.find((item) => item.key === "feishu")?.severity).toBe(
      "critical",
    );
    expect(components.find((item) => item.key === "reports")?.severity).toBe(
      "warning",
    );
  });
});
