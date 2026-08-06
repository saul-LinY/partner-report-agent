import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anonymousProjectScopeKey,
  authorizedProjectThreads,
  classifyProjectEnvironment,
  discoverProjectScopes,
  inspectLocalProjectScope,
  mergeRemoteProjectScope,
  saveLocalProjectScope,
  scopeIsActive,
  threadMayBeRead,
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
  it("distinguishes valid, missing, and invalid local permission files", () => {
    const directory = mkdtempSync(
      resolve(tmpdir(), "partner-report-scope-file-test-"),
    );
    try {
      expect(inspectLocalProjectScope(pluginInstanceId, directory).state).toBe(
        "missing",
      );
      saveLocalProjectScope(localScope(), directory);
      expect(
        inspectLocalProjectScope(pluginInstanceId, directory),
      ).toMatchObject({ state: "valid", scope: { pluginInstanceId } });

      writeFileSync(resolve(directory, "project-scope.json"), "not-json\n");
      expect(inspectLocalProjectScope(pluginInstanceId, directory).state).toBe(
        "invalid",
      );
      saveLocalProjectScope(localScope(), directory);
      expect(
        inspectLocalProjectScope(
          "22222222-2222-4222-8222-222222222222",
          directory,
        ).state,
      ).toBe("invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      const discovery = discoverProjectScopes(
        pluginInstanceId,
        localScope(),
        [
          { id: "thread-a", cwd: resolve(nested, "src") },
          { id: "thread-b", cwd: resolve(root, "docs") },
        ],
        { temporaryRoots: [] },
      );
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

  it("filters explicit temporary environments but not a directory name alone", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-filter-test-"));
    const temporary = resolve(root, "system-temp");
    const namedTmp = resolve(root, "workspace", "tmp");
    mkdirSync(resolve(temporary, ".git"), { recursive: true });
    mkdirSync(resolve(namedTmp, ".git"), { recursive: true });
    try {
      const discovery = discoverProjectScopes(
        pluginInstanceId,
        localScope(),
        [
          { id: "temporary", cwd: temporary },
          { id: "named-tmp", cwd: namedTmp },
          { id: "automation", cwd: namedTmp, systemGenerated: true },
        ],
        { temporaryRoots: [temporary] },
      );
      expect(discovery.threadScopes.has("temporary")).toBe(false);
      expect(discovery.threadScopes.has("automation")).toBe(false);
      expect(discovery.threadScopes.has("named-tmp")).toBe(true);
      expect(discovery.candidates).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a legitimate single-Session Git project for approval", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-single-test-"));
    mkdirSync(resolve(root, ".git"));
    try {
      const discovery = discoverProjectScopes(
        pluginInstanceId,
        localScope(),
        [{ id: "only-session", cwd: root }],
        { temporaryRoots: [] },
      );
      expect(discovery.candidates).toHaveLength(1);
      expect(discovery.candidates[0]?.sessionCount).toBe(1);
      expect(discovery.threadScopes.has("only-session")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a configured non-Git project with one Session for approval", () => {
    const root = "/workspace/configured-project";
    const discovery = discoverProjectScopes(
      pluginInstanceId,
      localScope(),
      [{ id: "configured-session", cwd: resolve(root, "src") }],
      { configuredRoots: [root], temporaryRoots: [] },
    );
    expect(discovery.candidates).toEqual([
      expect.objectContaining({
        localRoot: root,
        environmentKind: "configured",
        sessionCount: 1,
      }),
    ]);
  });

  it("merges linked worktrees into one logical Git project", () => {
    const base = mkdtempSync(
      resolve(tmpdir(), "partner-report-worktree-test-"),
    );
    const main = resolve(base, "main-project");
    const linked = resolve(base, "linked-project");
    const gitDirectory = resolve(main, ".git");
    const linkedGitDirectory = resolve(gitDirectory, "worktrees", "feature");
    mkdirSync(linkedGitDirectory, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(resolve(linked, ".git"), `gitdir: ${linkedGitDirectory}\n`);
    try {
      const discovery = discoverProjectScopes(
        pluginInstanceId,
        localScope(),
        [
          { id: "main", cwd: main },
          { id: "linked", cwd: linked },
        ],
        { temporaryRoots: [] },
      );
      expect(discovery.candidates).toHaveLength(1);
      expect(discovery.candidates[0]).toMatchObject({
        localRoot: realpathSync.native(main),
        displayName: "main-project",
        sessionCount: 2,
      });
      expect(discovery.threadScopes.get("main")).toBe(
        discovery.threadScopes.get("linked"),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not merge same-named directories from different repositories", () => {
    const base = mkdtempSync(resolve(tmpdir(), "partner-report-name-test-"));
    const first = resolve(base, "one", "project");
    const second = resolve(base, "two", "project");
    mkdirSync(resolve(first, ".git"), { recursive: true });
    mkdirSync(resolve(second, ".git"), { recursive: true });
    try {
      const discovery = discoverProjectScopes(
        pluginInstanceId,
        localScope(),
        [
          { id: "first", cwd: first },
          { id: "second", cwd: second },
        ],
        { temporaryRoots: [] },
      );
      expect(discovery.candidates).toHaveLength(2);
      expect(
        new Set(discovery.candidates.map((item) => item.scopeKey)).size,
      ).toBe(2);
      expect(discovery.candidates.map((item) => item.displayName)).toEqual([
        "project",
        "project",
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks unclassified directories unknown and blocks reads until approval", () => {
    const root = "/workspace/unclassified-project";
    expect(
      classifyProjectEnvironment(
        { id: "unknown", cwd: root },
        { temporaryRoots: [] },
      ),
    ).toEqual({ kind: "unknown", localRoot: root });
    const discovery = discoverProjectScopes(
      pluginInstanceId,
      localScope(),
      [{ id: "unknown", cwd: root }],
      { temporaryRoots: [] },
    );
    const candidate = discovery.candidates[0]!;
    const pendingScope = localScope([
      {
        ...candidate,
        status: "pending",
        effectiveFrom: null,
        firstSeenPeriodKey: "2026-W31",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(
      threadMayBeRead(
        { id: "unknown", cwd: root, scopeKey: candidate.scopeKey },
        pendingScope,
        { temporaryRoots: [] },
      ),
    ).toBe(false);
    pendingScope.entries[0]!.status = "allowed";
    pendingScope.entries[0]!.effectiveFrom = "2026-08-01T00:00:00.000Z";
    expect(
      threadMayBeRead(
        { id: "unknown", cwd: root, scopeKey: candidate.scopeKey },
        pendingScope,
        { temporaryRoots: [] },
        new Date("2026-08-06T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("does not expand a legacy local permission to a different root", () => {
    const scopeKey = "f".repeat(64);
    const legacy = localScope([
      {
        scopeKey,
        displayName: "legacy",
        status: "allowed",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        firstSeenPeriodKey: "2026-W31",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        sessionCount: 1,
        localRoot: "/workspace/legacy",
      },
    ]);
    expect(
      threadMayBeRead(
        {
          id: "other",
          cwd: "/workspace/other",
          scopeKey,
        },
        legacy,
        { temporaryRoots: [] },
        new Date("2026-08-06T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("migrates one legacy worktree mapping without changing its permission key", () => {
    const base = mkdtempSync(
      resolve(tmpdir(), "partner-report-legacy-worktree-"),
    );
    const main = resolve(base, "main");
    const linked = resolve(base, "linked");
    const linkedGitDirectory = resolve(main, ".git", "worktrees", "legacy");
    mkdirSync(linkedGitDirectory, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(resolve(linked, ".git"), `gitdir: ${linkedGitDirectory}\n`);
    const legacyKey = anonymousProjectScopeKey(
      pluginInstanceId,
      "a".repeat(64),
      realpathSync.native(linked),
    );
    const legacy = localScope([
      {
        scopeKey: legacyKey,
        displayName: "linked",
        status: "allowed",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        firstSeenPeriodKey: "2026-W31",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        sessionCount: 1,
        localRoot: linked,
      },
    ]);
    try {
      const discovery = discoverProjectScopes(
        pluginInstanceId,
        legacy,
        [
          { id: "legacy", cwd: linked },
          { id: "main", cwd: main },
        ],
        { temporaryRoots: [] },
      );
      expect(discovery.candidates).toEqual([
        expect.objectContaining({
          scopeKey: legacyKey,
          localRoot: realpathSync.native(main),
          sessionCount: 2,
        }),
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
