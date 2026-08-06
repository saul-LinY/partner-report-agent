import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { dataDirectory } from "./config.js";

export type RemoteProjectScopeEntry = {
  scopeKey: string;
  displayName: string;
  status: "pending" | "allowed" | "denied";
  effectiveFrom: string | null;
  firstSeenPeriodKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionCount: number;
};

export type RemoteProjectScopePolicy = {
  pluginInstanceId: string;
  identityConfirmed: boolean;
  version: number;
  initialized: boolean;
  initializedAt: string | null;
  currentPeriod: {
    periodKey: string;
    startsAt: string;
    endsAt: string;
  } | null;
  entries: RemoteProjectScopeEntry[];
};

export type LocalProjectScopeEntry = RemoteProjectScopeEntry & {
  localRoot: string | null;
};

export type LocalProjectScope = Omit<RemoteProjectScopePolicy, "entries"> & {
  schemaVersion: "1.0";
  scopeSalt: string;
  entries: LocalProjectScopeEntry[];
};

export type ScopeThreadSummary = {
  id: string;
  cwd: string | null;
};

export type DiscoveredScope = {
  scopeKey: string;
  displayName: string;
  localRoot: string;
  sessionCount: number;
};

function scopePath() {
  return resolve(dataDirectory(), "project-scope.json");
}

function canonicalPath(path: string) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function withinPath(candidate: string, root: string) {
  const nested = relative(root, candidate);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function outermostGitRoot(cwd: string) {
  let current = canonicalPath(cwd);
  let outermost: string | null = null;
  for (;;) {
    if (existsSync(resolve(current, ".git"))) outermost = current;
    const parent = dirname(current);
    if (parent === current) return outermost;
    current = parent;
  }
}

function newLocalScope(pluginInstanceId: string): LocalProjectScope {
  return {
    schemaVersion: "1.0",
    scopeSalt: randomBytes(32).toString("hex"),
    pluginInstanceId,
    identityConfirmed: false,
    version: 0,
    initialized: false,
    initializedAt: null,
    currentPeriod: null,
    entries: [],
  };
}

export function loadLocalProjectScope(
  pluginInstanceId: string,
): LocalProjectScope {
  const path = scopePath();
  if (!existsSync(path)) return newLocalScope(pluginInstanceId);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LocalProjectScope;
  if (
    parsed.schemaVersion !== "1.0" ||
    parsed.pluginInstanceId !== pluginInstanceId ||
    !/^[a-f0-9]{64}$/.test(parsed.scopeSalt)
  ) {
    return newLocalScope(pluginInstanceId);
  }
  return parsed;
}

export function saveLocalProjectScope(scope: LocalProjectScope) {
  const path = scopePath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(scope, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function mergeRemoteProjectScope(
  local: LocalProjectScope,
  remote: RemoteProjectScopePolicy,
): LocalProjectScope {
  if (local.pluginInstanceId !== remote.pluginInstanceId)
    throw new Error("项目权限不属于当前 Plugin Instance。");
  const localRoots = new Map(
    local.entries.map((entry) => [entry.scopeKey, entry.localRoot]),
  );
  return {
    schemaVersion: "1.0",
    scopeSalt: local.scopeSalt,
    ...remote,
    entries: remote.entries.map((entry) => ({
      ...entry,
      localRoot: localRoots.get(entry.scopeKey) ?? null,
    })),
  };
}

export function anonymousProjectScopeKey(
  pluginInstanceId: string,
  scopeSalt: string,
  localRoot: string,
) {
  return createHmac("sha256", scopeSalt)
    .update(`partner-report/project-scope/v1:${pluginInstanceId}:${localRoot}`)
    .digest("hex");
}

export function discoverProjectScopes(
  pluginInstanceId: string,
  local: LocalProjectScope,
  summaries: ScopeThreadSummary[],
) {
  const knownRoots = local.entries
    .filter((entry): entry is LocalProjectScopeEntry & { localRoot: string } =>
      Boolean(entry.localRoot),
    )
    .map((entry) => ({ ...entry, localRoot: canonicalPath(entry.localRoot) }))
    .sort((left, right) => right.localRoot.length - left.localRoot.length);
  const discovered = new Map<string, DiscoveredScope>();
  const threadScopes = new Map<string, string>();

  for (const summary of summaries) {
    if (!summary.cwd) continue;
    const cwd = canonicalPath(summary.cwd);
    const inherited = knownRoots.find((entry) =>
      withinPath(cwd, entry.localRoot),
    );
    const localRoot = inherited?.localRoot ?? outermostGitRoot(cwd) ?? cwd;
    const scopeKey =
      inherited?.scopeKey ??
      anonymousProjectScopeKey(pluginInstanceId, local.scopeSalt, localRoot);
    const current = discovered.get(scopeKey);
    discovered.set(scopeKey, {
      scopeKey,
      displayName:
        inherited?.displayName ?? (basename(localRoot) || "未命名项目"),
      localRoot,
      sessionCount: (current?.sessionCount ?? 0) + 1,
    });
    threadScopes.set(summary.id, scopeKey);
  }
  return { candidates: [...discovered.values()], threadScopes };
}

export function mergeDiscoveredRoots(
  local: LocalProjectScope,
  candidates: DiscoveredScope[],
) {
  const roots = new Map(
    candidates.map((candidate) => [candidate.scopeKey, candidate.localRoot]),
  );
  return {
    ...local,
    entries: local.entries.map((entry) => ({
      ...entry,
      localRoot: roots.get(entry.scopeKey) ?? entry.localRoot,
    })),
  };
}

export function scopeIsActive(
  entry: RemoteProjectScopeEntry | undefined,
  now = new Date(),
) {
  return Boolean(
    entry?.status === "allowed" &&
    entry.effectiveFrom &&
    new Date(entry.effectiveFrom).getTime() <= now.getTime(),
  );
}

export function authorizedProjectThreads<T extends { id: string }>(
  summaries: T[],
  threadScopes: Map<string, string>,
  entries: RemoteProjectScopeEntry[],
  now = new Date(),
) {
  const policies = new Map(entries.map((entry) => [entry.scopeKey, entry]));
  return summaries.flatMap((summary): Array<T & { scopeKey: string }> => {
    const scopeKey = threadScopes.get(summary.id);
    if (!scopeKey || !scopeIsActive(policies.get(scopeKey), now)) return [];
    return [{ ...summary, scopeKey }];
  });
}
