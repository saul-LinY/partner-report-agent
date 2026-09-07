import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyScopeResolution,
  discoverProjectScopes,
  mergeDiscoveredRoots,
  threadMayBeRead,
  type LocalProjectScope,
} from "./project-scope.js";

const roots: string[] = [];
const instance = "11111111-1111-4111-8111-111111111111";
function scope(): LocalProjectScope {
  return {
    schemaVersion: "1.0",
    pluginInstanceId: instance,
    scopeSalt: "a".repeat(64),
    identitySalt: "b".repeat(64),
    resolutionVersion: 1,
    identityConfirmed: true,
    initialized: true,
    initializedAt: "2026-09-01T00:00:00Z",
    version: 1,
    currentPeriod: null,
    entries: [],
  };
}
function repo(remote = "git@github.com:example/project.git") {
  const root = mkdtempSync(resolve(tmpdir(), "scope-resolution-"));
  roots.push(root);
  mkdirSync(resolve(root, ".git"));
  writeFileSync(
    resolve(root, ".git", "config"),
    `[remote "origin"]\nurl = ${remote}\n`,
  );
  return root;
}
function discover(local: LocalProjectScope, root: string) {
  return discoverProjectScopes(instance, local, [{ id: "thread", cwd: root }], {
    temporaryRoots: [],
  });
}
function enroll(
  local: LocalProjectScope,
  root: string,
  status: "allowed" | "denied" = "allowed",
) {
  const discovery = discover(local, root);
  const candidate = discovery.candidates[0]!;
  return mergeDiscoveredRoots(
    {
      ...local,
      entries: [
        {
          ...candidate,
          status,
          effectiveFrom: "2026-09-01T00:00:00Z",
          firstSeenPeriodKey: "2026-W36",
          firstSeenAt: "2026-09-01T00:00:00Z",
          lastSeenAt: "2026-09-01T00:00:00Z",
        },
      ],
    },
    discovery.candidates,
  );
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("central project scope resolution", () => {
  it("blocks a resumed read when central reviewer identity is no longer confirmed", () => {
    const root = repo();
    const local = { ...enroll(scope(), root), identityConfirmed: false };
    expect(
      threadMayBeRead(
        { id: "thread", cwd: root, scopeKey: local.entries[0]!.scopeKey },
        local,
        { temporaryRoots: [] },
      ),
    ).toBe(false);
  });
  it("keeps a canonical identity across SSH and HTTPS without changing the legacy key algorithm", () => {
    const root = repo();
    const first = discover(scope(), root).candidates[0]!;
    writeFileSync(
      resolve(root, ".git/config"),
      '[remote "origin"]\nurl = https://github.com/example/project.git\n',
    );
    const next = discover(scope(), root).candidates[0]!;
    expect(next.identityKey).toBe(first.identityKey);
    expect(next.localIdentity).not.toBe(first.localIdentity);
  });

  it("recovers a lost local salt through the central identity namespace", () => {
    const root = repo();
    const before = enroll(scope(), root);
    const clean = { ...scope(), scopeSalt: "c".repeat(64) };
    const discovery = discover(clean, root);
    expect(discovery.candidates[0]!.scopeKey).not.toBe(
      before.entries[0]!.scopeKey,
    );
    expect(discovery.candidates[0]!.identityKey).toBe(
      discover(before, root).candidates[0]!.identityKey,
    );
    const restored = applyScopeResolution(
      clean,
      {
        ...before,
        bindings: [
          {
            requestedScopeKey: discovery.candidates[0]!.scopeKey,
            scopeKey: before.entries[0]!.scopeKey,
          },
        ],
      },
      discovery,
    );
    expect(
      threadMayBeRead(
        { id: "thread", cwd: root, scopeKey: before.entries[0]!.scopeKey },
        restored,
        { temporaryRoots: [] },
      ),
    ).toBe(true);
  });

  it("does not reuse an allow grant when a different repository occupies the old path", () => {
    const root = repo();
    const before = enroll(scope(), root);
    writeFileSync(
      resolve(root, ".git/config"),
      '[remote "origin"]\nurl = git@github.com:example/other.git\n',
    );
    const discovery = discover(before, root);
    expect(discovery.candidates[0]!.scopeKey).not.toBe(
      before.entries[0]!.scopeKey,
    );
    expect(discovery.candidates[0]!.recoveryKeys).not.toContain(
      before.entries[0]!.scopeKey,
    );
    expect(
      threadMayBeRead(
        { id: "thread", cwd: root, scopeKey: before.entries[0]!.scopeKey },
        before,
        { temporaryRoots: [] },
      ),
    ).toBe(false);
  });

  it("retires a stale duplicate mapping and remains stable on subsequent runs", () => {
    const root = repo();
    const before = enroll(scope(), root, "denied");
    const oldKey = before.entries[0]!.scopeKey;
    const canonical = "f".repeat(64);
    before.entries.push({ ...before.entries[0]!, scopeKey: canonical });
    const discovery = discover(before, root);
    const restored = applyScopeResolution(
      before,
      {
        ...before,
        bindings: [
          {
            requestedScopeKey: discovery.candidates[0]!.scopeKey,
            scopeKey: canonical,
          },
        ],
      },
      discovery,
    );
    expect(
      restored.entries.find((entry) => entry.scopeKey === oldKey)!.localRoot,
    ).toBeNull();
    expect(discover(restored, root).candidates[0]!.scopeKey).toBe(canonical);
    expect(
      threadMayBeRead(
        { id: "thread", cwd: root, scopeKey: canonical },
        restored,
        { temporaryRoots: [] },
      ),
    ).toBe(false);
  });

  it("never treats a missing filesystem identity as proof of an old project", () => {
    const root = repo();
    const before = enroll(scope(), root);
    rmSync(root, { recursive: true });
    const discovery = discover(before, root);
    expect(discovery.candidates[0]!.identityKey).toBeUndefined();
    expect(discovery.candidates[0]!.recoveryKeys).toEqual([]);
    const pendingKey = "e".repeat(64);
    const pending = applyScopeResolution(
      before,
      {
        ...before,
        entries: [
          {
            ...before.entries[0]!,
            scopeKey: pendingKey,
            status: "pending",
            effectiveFrom: null,
          },
        ],
        bindings: [
          {
            requestedScopeKey: discovery.candidates[0]!.scopeKey,
            scopeKey: pendingKey,
          },
        ],
      },
      discovery,
    );
    expect(discover(pending, root).candidates[0]!.scopeKey).toBe(
      discovery.candidates[0]!.scopeKey,
    );
    expect(
      threadMayBeRead(
        { id: "thread", cwd: root, scopeKey: before.entries[0]!.scopeKey },
        before,
        { temporaryRoots: [] },
      ),
    ).toBe(false);
  });
});
