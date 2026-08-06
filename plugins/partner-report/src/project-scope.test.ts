import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anonymousProjectScopeKey,
  authorizedProjectThreads,
  discoverProjectScopes,
  mergeRemoteProjectScope,
  scopeIsActive,
  type LocalProjectScope,
} from "./project-scope.js";

const pluginInstanceId = "11111111-1111-4111-8111-111111111111";

function localScope(
  entries: LocalProjectScope["entries"] = [],
): LocalProjectScope {
  return {
    schemaVersion: "1.0",
    scopeSalt: "a".repeat(64),
    pluginInstanceId,
    identityConfirmed: true,
    version: 1,
    initialized: false,
    initializedAt: null,
    currentPeriod: null,
    entries,
  };
}

describe("project scope privacy boundary", () => {
  it("creates stable, installation-scoped anonymous project keys", () => {
    const root = "/private/work/customer-project";
    const first = anonymousProjectScopeKey(
      pluginInstanceId,
      "a".repeat(64),
      root,
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      anonymousProjectScopeKey(pluginInstanceId, "a".repeat(64), root),
    ).toBe(first);
    expect(
      anonymousProjectScopeKey(pluginInstanceId, "b".repeat(64), root),
    ).not.toBe(first);
  });

  it("uses the outer project as the single permission level for nested repos", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-scope-test-"));
    const nested = resolve(root, "packages", "nested");
    mkdirSync(resolve(root, ".git"));
    mkdirSync(resolve(nested, ".git"), { recursive: true });
    try {
      const discovery = discoverProjectScopes(pluginInstanceId, localScope(), [
        { id: "thread-a", cwd: resolve(nested, "src") },
        { id: "thread-b", cwd: resolve(root, "docs") },
      ]);
      expect(discovery.candidates).toHaveLength(1);
      expect(discovery.candidates[0]).toMatchObject({
        localRoot: root,
        sessionCount: 2,
      });
      expect(discovery.threadScopes.get("thread-a")).toBe(
        discovery.threadScopes.get("thread-b"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves local roots while applying central status and effective time", () => {
    const scopeKey = "c".repeat(64);
    const merged = mergeRemoteProjectScope(
      localScope([
        {
          scopeKey,
          displayName: "old",
          status: "pending",
          effectiveFrom: null,
          firstSeenPeriodKey: "2026-W31",
          firstSeenAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-01T00:00:00.000Z",
          sessionCount: 1,
          localRoot: "/private/work/project",
        },
      ]),
      {
        pluginInstanceId,
        identityConfirmed: true,
        version: 2,
        initialized: true,
        initializedAt: "2026-08-02T00:00:00.000Z",
        currentPeriod: null,
        entries: [
          {
            scopeKey,
            displayName: "project",
            status: "allowed",
            effectiveFrom: "2026-08-08T00:00:00.000Z",
            firstSeenPeriodKey: "2026-W31",
            firstSeenAt: "2026-08-01T00:00:00.000Z",
            lastSeenAt: "2026-08-02T00:00:00.000Z",
            sessionCount: 2,
          },
        ],
      },
    );
    expect(merged.entries[0]?.localRoot).toBe("/private/work/project");
    expect(scopeIsActive(merged.entries[0], new Date("2026-08-07"))).toBe(
      false,
    );
    expect(scopeIsActive(merged.entries[0], new Date("2026-08-09"))).toBe(true);
  });

  it("queues only active allowed projects before thread content is read", () => {
    const activeKey = "1".repeat(64);
    const pendingKey = "2".repeat(64);
    const futureKey = "3".repeat(64);
    const entries = [
      {
        scopeKey: activeKey,
        displayName: "active",
        status: "allowed" as const,
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        firstSeenPeriodKey: "2026-W31",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        sessionCount: 1,
      },
      {
        scopeKey: pendingKey,
        displayName: "pending",
        status: "pending" as const,
        effectiveFrom: null,
        firstSeenPeriodKey: "2026-W31",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        sessionCount: 1,
      },
      {
        scopeKey: futureKey,
        displayName: "future",
        status: "allowed" as const,
        effectiveFrom: "2026-08-10T00:00:00.000Z",
        firstSeenPeriodKey: "2026-W31",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        sessionCount: 1,
      },
    ];
    const summaries = [
      { id: "active-thread" },
      { id: "pending-thread" },
      { id: "future-thread" },
    ];
    expect(
      authorizedProjectThreads(
        summaries,
        new Map([
          ["active-thread", activeKey],
          ["pending-thread", pendingKey],
          ["future-thread", futureKey],
        ]),
        entries,
        new Date("2026-08-06T00:00:00.000Z"),
      ),
    ).toEqual([{ id: "active-thread", scopeKey: activeKey }]);
  });
});
