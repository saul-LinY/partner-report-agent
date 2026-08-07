import { describe, expect, it } from "vitest";
import {
  projectScopeBootstrapSchema,
  projectScopeCardStatusSchema,
  projectScopeCandidateBatchSchema,
  projectScopeDecisionSchema,
  projectScopeEffectiveFrom,
} from "./project-scope.js";

describe("project scope policy", () => {
  it("requires a period and policy version for card delivery checks", () => {
    expect(
      projectScopeCardStatusSchema.parse({
        periodKey: "2026-W32",
        version: "2",
      }),
    ).toEqual({ periodKey: "2026-W32", version: 2 });
  });

  it("requires a versioned local bootstrap reason", () => {
    expect(
      projectScopeBootstrapSchema.parse({
        baseVersion: 1,
        reason: "local_scope_missing",
      }),
    ).toEqual({ baseVersion: 1, reason: "local_scope_missing" });
    expect(() =>
      projectScopeBootstrapSchema.parse({
        baseVersion: 0,
        reason: "plugin_updated",
      }),
    ).toThrow();
  });

  it("accepts only anonymous keys and minimal candidate metadata", () => {
    expect(
      projectScopeCandidateBatchSchema.parse({
        periodKey: "2026-W32",
        candidates: [
          {
            scopeKey: "a".repeat(64),
            displayName: "partner-report",
            sessionCount: 3,
          },
        ],
      }),
    ).not.toHaveProperty("candidates.0.localRoot");
    expect(() =>
      projectScopeCandidateBatchSchema.parse({
        periodKey: "2026-W32",
        candidates: [
          {
            scopeKey: "a".repeat(64),
            displayName: "partner-report",
            sessionCount: 3,
            localRoot: "/Users/example/project",
            environmentKind: "git",
            gitCommonDirectory: "/Users/example/project/.git",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts single-Session metadata for server-side filtering", () => {
    expect(
      projectScopeCandidateBatchSchema.parse({
        periodKey: "2026-W32",
        candidates: [
          {
            scopeKey: "a".repeat(64),
            displayName: "temporary-candidate",
            sessionCount: 1,
          },
        ],
      }).candidates,
    ).toHaveLength(1);
  });

  it("requires optimistic concurrency for decisions", () => {
    expect(() =>
      projectScopeDecisionSchema.parse({
        decisions: [{ scopeKey: "a".repeat(64), decision: "allow" }],
      }),
    ).toThrow();
  });

  it("keeps the complete first batch immediate and delays later additions", () => {
    const initializedAt = new Date("2026-08-06T10:00:00.000Z");
    const now = new Date("2026-08-06T11:00:00.000Z");
    const nextPeriodStart = new Date("2026-08-10T00:00:00.000Z");
    expect(
      projectScopeEffectiveFrom({
        decision: "allow",
        policyInitializedAt: initializedAt,
        entryFirstSeenAt: new Date("2026-08-06T09:00:00.000Z"),
        wasPending: true,
        nextPeriodStart,
        now,
      }),
    ).toEqual(now);
    expect(
      projectScopeEffectiveFrom({
        decision: "allow",
        policyInitializedAt: initializedAt,
        entryFirstSeenAt: new Date("2026-08-07T09:00:00.000Z"),
        wasPending: true,
        nextPeriodStart,
        now,
      }),
    ).toEqual(nextPeriodStart);
    expect(
      projectScopeEffectiveFrom({
        decision: "deny",
        policyInitializedAt: initializedAt,
        entryFirstSeenAt: new Date("2026-08-07T09:00:00.000Z"),
        wasPending: true,
        nextPeriodStart,
        now,
      }),
    ).toEqual(now);
  });
});
