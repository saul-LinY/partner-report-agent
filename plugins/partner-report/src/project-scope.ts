import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  environmentKind?: "configured" | "git" | "unknown";
  lastSyncedStatus?: RemoteProjectScopeEntry["status"];
};

export type LocalProjectScope = Omit<RemoteProjectScopePolicy, "entries"> & {
  schemaVersion: "1.0";
  scopeSalt: string;
  entries: LocalProjectScopeEntry[];
};

export type ScopeThreadSummary = {
  id: string;
  cwd: string | null;
  systemGenerated?: boolean;
};

export type DiscoveredScope = {
  scopeKey: string;
  displayName: string;
  localRoot: string;
  sessionCount: number;
  environmentKind: "configured" | "git" | "unknown";
};

export type ProjectEnvironment = {
  kind: "configured" | "git" | "unknown" | "temporary";
  localRoot: string | null;
};

export type ProjectDiscoveryOptions = {
  configuredRoots?: string[];
  temporaryRoots?: string[];
};

function scopePath(directory = dataDirectory()) {
  return resolve(directory, "project-scope.json");
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

function linkedWorktreeCommonRoot(markerPath: string) {
  try {
    if (!lstatSync(markerPath).isFile()) return null;
    const match = /^gitdir:\s*(.+)\s*$/im.exec(
      readFileSync(markerPath, "utf8"),
    );
    if (!match?.[1]) return null;
    const gitDirectory = canonicalPath(resolve(dirname(markerPath), match[1]));
    const worktreesDirectory = dirname(dirname(gitDirectory));
    if (basename(worktreesDirectory) !== ".git") return null;
    return dirname(worktreesDirectory);
  } catch {
    return null;
  }
}

function outermostGitRoot(cwd: string) {
  let current = canonicalPath(cwd);
  let outermost: string | null = null;
  for (;;) {
    const marker = resolve(current, ".git");
    if (existsSync(marker))
      outermost = linkedWorktreeCommonRoot(marker) ?? current;
    const parent = dirname(current);
    if (parent === current) return outermost;
    current = parent;
  }
}

function defaultTemporaryRoots() {
  const codexHomes = new Set(
    [process.env.CODEX_HOME, resolve(homedir(), ".codex")].filter(
      (value): value is string => Boolean(value),
    ),
  );
  return [
    tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    resolve(homedir(), "Documents", "Codex"),
    ...[...codexHomes].flatMap((root) => [
      resolve(root, "tmp"),
      resolve(root, ".tmp"),
      resolve(root, "worktrees"),
    ]),
  ].map(canonicalPath);
}

function longestContainingRoot(cwd: string, roots: string[]) {
  return roots
    .map(canonicalPath)
    .filter((root) => withinPath(cwd, root))
    .sort((left, right) => right.length - left.length)[0];
}

export function classifyProjectEnvironment(
  summary: ScopeThreadSummary,
  options: ProjectDiscoveryOptions = {},
): ProjectEnvironment {
  if (summary.systemGenerated) return { kind: "temporary", localRoot: null };
  if (!summary.cwd) return { kind: "unknown", localRoot: null };
  const cwd = canonicalPath(summary.cwd);
  if (
    longestContainingRoot(
      cwd,
      options.temporaryRoots ?? defaultTemporaryRoots(),
    )
  )
    return { kind: "temporary", localRoot: null };
  const configured = longestContainingRoot(cwd, options.configuredRoots ?? []);
  if (configured) return { kind: "configured", localRoot: configured };
  const gitRoot = outermostGitRoot(cwd);
  if (gitRoot) return { kind: "git", localRoot: gitRoot };
  return { kind: "unknown", localRoot: cwd };
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

export type LocalProjectScopeFileState = "valid" | "missing" | "invalid";

export type LocalProjectScopeInspection = {
  state: LocalProjectScopeFileState;
  scope: LocalProjectScope;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalProjectScope(
  value: unknown,
  pluginInstanceId: string,
): value is LocalProjectScope {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== "1.0" ||
    value.pluginInstanceId !== pluginInstanceId ||
    typeof value.scopeSalt !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.scopeSalt) ||
    typeof value.identityConfirmed !== "boolean" ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.initialized !== "boolean" ||
    (value.initializedAt !== null && typeof value.initializedAt !== "string") ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }
  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.scopeKey === "string" &&
      /^[a-f0-9]{64}$/.test(entry.scopeKey) &&
      typeof entry.displayName === "string" &&
      ["pending", "allowed", "denied"].includes(String(entry.status)) &&
      (entry.effectiveFrom === null ||
        typeof entry.effectiveFrom === "string") &&
      typeof entry.firstSeenPeriodKey === "string" &&
      typeof entry.firstSeenAt === "string" &&
      typeof entry.lastSeenAt === "string" &&
      Number.isInteger(entry.sessionCount) &&
      (entry.sessionCount as number) >= 0 &&
      (entry.localRoot === null || typeof entry.localRoot === "string") &&
      (entry.environmentKind === undefined ||
        ["configured", "git", "unknown"].includes(
          String(entry.environmentKind),
        )) &&
      (entry.lastSyncedStatus === undefined ||
        ["pending", "allowed", "denied"].includes(
          String(entry.lastSyncedStatus),
        )),
  );
}

export function inspectLocalProjectScope(
  pluginInstanceId: string,
  directory = dataDirectory(),
): LocalProjectScopeInspection {
  const path = scopePath(directory);
  if (!existsSync(path))
    return { state: "missing", scope: newLocalScope(pluginInstanceId) };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isLocalProjectScope(parsed, pluginInstanceId))
      return { state: "valid", scope: parsed };
  } catch {
    // A malformed permission file must trigger a fresh approval, not collection.
  }
  return { state: "invalid", scope: newLocalScope(pluginInstanceId) };
}

export function loadLocalProjectScope(
  pluginInstanceId: string,
  directory = dataDirectory(),
): LocalProjectScope {
  return inspectLocalProjectScope(pluginInstanceId, directory).scope;
}

export function saveLocalProjectScope(
  scope: LocalProjectScope,
  directory = dataDirectory(),
) {
  const path = scopePath(directory);
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
  const localMetadata = new Map(
    local.entries.map((entry) => [
      entry.scopeKey,
      {
        localRoot: entry.localRoot,
        environmentKind: entry.environmentKind,
      },
    ]),
  );
  return {
    schemaVersion: "1.0",
    scopeSalt: local.scopeSalt,
    ...remote,
    entries: remote.entries.map((entry) => ({
      ...entry,
      localRoot: localMetadata.get(entry.scopeKey)?.localRoot ?? null,
      lastSyncedStatus: entry.status,
      ...(localMetadata.get(entry.scopeKey)?.environmentKind
        ? {
            environmentKind: localMetadata.get(entry.scopeKey)!.environmentKind,
          }
        : {}),
    })),
  };
}

export type LocalProjectScopeDecision = {
  scopeKey: string;
  decision: "allow" | "deny";
};

export type LocalProjectScopeChangeCheck =
  | { kind: "none"; decisions: [] }
  | { kind: "changes"; decisions: LocalProjectScopeDecision[] }
  | { kind: "conflict"; reason: string };

/**
 * Local edits are limited to changing the status of projects already known by
 * the central policy. The central version remains the concurrency boundary.
 */
export function inspectLocalProjectScopeChanges(
  local: LocalProjectScope,
  remote: RemoteProjectScopePolicy,
): LocalProjectScopeChangeCheck {
  if (local.pluginInstanceId !== remote.pluginInstanceId)
    return { kind: "conflict", reason: "项目权限不属于当前 Plugin Instance。" };
  if (local.version > remote.version)
    return { kind: "conflict", reason: "本地权限版本高于中台版本。" };

  const localEntries = new Map(
    local.entries.map((entry) => [entry.scopeKey, entry]),
  );
  const remoteEntries = new Map(
    remote.entries.map((entry) => [entry.scopeKey, entry]),
  );
  if ([...localEntries.keys()].some((scopeKey) => !remoteEntries.has(scopeKey)))
    return {
      kind: "conflict",
      reason: "本地权限文件不能新增、删除或伪造项目。",
    };

  const decisions: LocalProjectScopeDecision[] = [];
  for (const remoteEntry of remote.entries) {
    const localEntry = localEntries.get(remoteEntry.scopeKey);
    if (!localEntry) continue;
    if (localEntry.status === remoteEntry.status) continue;
    const locallyEdited =
      localEntry.lastSyncedStatus !== undefined &&
      localEntry.status !== localEntry.lastSyncedStatus;
    const legacyLocalEdit =
      localEntry.lastSyncedStatus === undefined &&
      local.version === remote.version;
    if (!locallyEdited && !legacyLocalEdit) continue;
    if (local.version !== remote.version)
      return { kind: "conflict", reason: "中台权限已更新，请先同步最新版本。" };
    if (!["allowed", "denied"].includes(localEntry.status))
      return { kind: "conflict", reason: "本地项目权限状态无效。" };
    decisions.push({
      scopeKey: remoteEntry.scopeKey,
      decision: localEntry.status === "allowed" ? "allow" : "deny",
    });
  }
  return decisions.length > 0
    ? { kind: "changes", decisions }
    : { kind: "none", decisions: [] };
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
  options: ProjectDiscoveryOptions = {},
) {
  const knownRoots = local.entries
    .filter((entry): entry is LocalProjectScopeEntry & { localRoot: string } =>
      Boolean(entry.localRoot),
    )
    .map((entry) => {
      const localRoot = canonicalPath(entry.localRoot);
      const environment = classifyProjectEnvironment(
        { id: entry.scopeKey, cwd: localRoot },
        options,
      );
      return {
        ...entry,
        localRoot,
        logicalRoot: environment.localRoot ?? localRoot,
      };
    })
    .sort((left, right) => right.localRoot.length - left.localRoot.length);
  const discovered = new Map<string, DiscoveredScope>();
  const threadScopes = new Map<string, string>();

  for (const summary of summaries) {
    const environment = classifyProjectEnvironment(summary, options);
    if (
      !summary.cwd ||
      !environment.localRoot ||
      environment.kind === "temporary"
    )
      continue;
    const cwd = canonicalPath(summary.cwd);
    const pathInherited = knownRoots.find((entry) =>
      withinPath(cwd, entry.localRoot),
    );
    const logicalMatches = knownRoots.filter(
      (entry) => entry.logicalRoot === environment.localRoot,
    );
    const inherited =
      pathInherited ??
      (logicalMatches.length === 1 ? logicalMatches[0] : undefined);
    const localRoot =
      inherited && environment.kind === "unknown"
        ? inherited.localRoot
        : environment.localRoot;
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
      environmentKind: environment.kind,
    });
    threadScopes.set(summary.id, scopeKey);
  }
  return { candidates: [...discovered.values()], threadScopes };
}

export function threadMayBeRead(
  summary: ScopeThreadSummary & { scopeKey: string },
  local: LocalProjectScope,
  options: ProjectDiscoveryOptions = {},
  now = new Date(),
) {
  if (
    !scopeIsActive(
      local.entries.find((entry) => entry.scopeKey === summary.scopeKey),
      now,
    )
  )
    return false;
  const discovery = discoverProjectScopes(
    local.pluginInstanceId,
    local,
    [summary],
    options,
  );
  return discovery.threadScopes.get(summary.id) === summary.scopeKey;
}

export function mergeDiscoveredRoots(
  local: LocalProjectScope,
  candidates: DiscoveredScope[],
) {
  const roots = new Map(
    candidates.map((candidate) => [
      candidate.scopeKey,
      {
        localRoot: candidate.localRoot,
        environmentKind: candidate.environmentKind,
      },
    ]),
  );
  return {
    ...local,
    entries: local.entries.map((entry) => {
      const discovered = roots.get(entry.scopeKey);
      const environmentKind =
        discovered?.environmentKind ?? entry.environmentKind;
      return {
        ...entry,
        localRoot: discovered?.localRoot ?? entry.localRoot,
        ...(environmentKind ? { environmentKind } : {}),
      };
    }),
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
