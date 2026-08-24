import { describe, expect, it } from "vitest";
import {
  projectScopeBootstrapSchema,
  projectScopeCandidateBatchSchema,
  projectScopeDecisionSchema,
  projectScopeEffectiveFrom,
} from "./project-scope.js";

describe("project scope policy", () => {
  it("requires a versioned local bootstrap reason", () => {
    expect(
      projectScopeBootstrapSchema.parse({
        baseVersion: 1,
        reason: "local_scope_missing",
      }),
    ).toEqual({ baseVersion: 1, reason: "local_scope_missing" });
    expect(
      projectScopeBootstrapSchema.parse({
        baseVersion: 2,
        reason: "local_scope_identity_conflict",
      }),
    ).toEqual({ baseVersion: 2, reason: "local_scope_identity_conflict" });
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

  it("accepts single-Session metadata as a permission candidate", () => {
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

  it("accepts the legacy discovery marker for client compatibility", () => {
    expect(
      projectScopeCandidateBatchSchema.parse({
        periodKey: "2026-W32",
        initialDiscovery: true,
        candidates: [
          {
            scopeKey: "a".repeat(64),
            displayName: "known-project",
            sessionCount: 1,
          },
        ],
      }).initialDiscovery,
    ).toBe(true);
  });

  it("requires optimistic concurrency for decisions", () => {
    expect(() =>
      projectScopeDecisionSchema.parse({
        decisions: [{ scopeKey: "a".repeat(64), decision: "allow" }],
      }),
    ).toThrow();
  });

  it("applies every project scope decision immediately", () => {
    const now = new Date("2026-08-06T11:00:00.000Z");
    expect(projectScopeEffectiveFrom({ now })).toEqual(now);
  });
});
