import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  statSync,
  realpathSync,
  renameSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { dataDirectory } from "./config.js";
import { hostThreadKey, LOCAL_HOST_ID } from "./host-project-discovery.js";

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
  bindingStatus?: string;
  bindingCompleted?: boolean;
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
  hostId?: string;
  localRoot: string | null;
  localIdentity?: string;
  environmentKind?: "configured" | "git" | "unknown";
  lastSyncedStatus?: RemoteProjectScopeEntry["status"];
  backfilledPeriodKey?: string | null;
};

export type LocalProjectScope = Omit<RemoteProjectScopePolicy, "entries"> & {
  schemaVersion: "1.0";
  scopeSalt: string;
  entries: LocalProjectScopeEntry[];
};

export type ScopeThreadSummary = {
  id: string;
  hostId?: string;
  projectId?: string | null;
  cwd: string | null;
  systemGenerated?: boolean;
};

export type DiscoveredScope = {
  scopeKey: string;
  displayName: string;
  localRoot: string;
  hostId?: string;
  localIdentity?: string;
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
    let existingParent = absolute;
    const missingSegments: string[] = [];
    while (!existsSync(existingParent)) {
      const parent = dirname(existingParent);
      if (parent === existingParent) return absolute;
      missingSegments.unshift(basename(existingParent));
      existingParent = parent;
    }
    try {
      return resolve(realpathSync.native(existingParent), ...missingSegments);
    } catch {
      return absolute;
    }
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
    if (existsSync(marker)) {
      const linkedRoot = linkedWorktreeCommonRoot(marker);
      const validDirectory =
        lstatSync(marker).isDirectory() &&
        (existsSync(resolve(marker, "HEAD")) ||
          existsSync(resolve(marker, "config")));
      if (linkedRoot || validDirectory) outermost = linkedRoot ?? current;
    }
    const parent = dirname(current);
    if (parent === current) return outermost;
    current = parent;
  }
}

function normalizedGitRemote(value: string) {
  const remote = value.trim();
  if (!remote || remote.startsWith("/") || remote.startsWith("file:"))
    return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
  if (scp?.[1] && scp[2])
    return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")}`;
  try {
    const url = new URL(remote);
    if (!url.hostname) return null;
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")}`;
  } catch {
    return null;
  }
}

function gitRemoteIdentity(root: string) {
  try {
    const config = readFileSync(resolve(root, ".git", "config"), "utf8");
    let remoteName: string | null = null;
    const remotes = new Map<string, string>();
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)]\s*$/.exec(line);
      if (section) {
        remoteName =
          /^remote\s+"([^"]+)"$/i.exec(section[1] ?? "")?.[1] ?? null;
        continue;
      }
      if (!remoteName) continue;
      const match = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      const normalized = match?.[1] ? normalizedGitRemote(match[1]) : null;
      if (normalized) remotes.set(remoteName.toLowerCase(), normalized);
    }
    const stableRemote =
      remotes.get("origin") ?? [...remotes.values()].sort()[0];
    return stableRemote ? `git-remote:${stableRemote}` : null;
  } catch {
    return null;
  }
}

function projectLocalIdentity(
  scopeSalt: string,
  localRoot: string,
  hostId = LOCAL_HOST_ID,
  projectId?: string | null,
) {
  if (hostId !== LOCAL_HOST_ID)
    return createHmac("sha256", scopeSalt)
      .update(
        `partner-report/project-local-identity/v2:${JSON.stringify([hostId, projectId ? `project:${projectId}` : `path:${localRoot}`])}`,
      )
      .digest("hex");
  const gitRoot = outermostGitRoot(localRoot);
  const remote = gitRoot ? gitRemoteIdentity(gitRoot) : null;
  let material = remote;
  if (!material) {
    try {
      const stat = statSync(gitRoot ?? localRoot, { bigint: true });
      const birthtime =
        (stat as unknown as { birthtimeNs?: bigint }).birthtimeNs ??
        stat.birthtimeMs;
      material = `filesystem:${stat.dev}:${stat.ino}:${birthtime}`;
    } catch {
      return undefined;
    }
  }
  return createHmac("sha256", scopeSalt)
    .update(`partner-report/project-local-identity/v1:${material}`)
    .digest("hex");
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
  if (summary.hostId && summary.hostId !== LOCAL_HOST_ID)
    return { kind: "unknown", localRoot: resolve(summary.cwd) };
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

export function localProjectScopeRequiresBootstrap(
  state: LocalProjectScopeFileState,
  remote: { initialized: boolean; entries: readonly unknown[] },
) {
  return state !== "valid" && (remote.initialized || remote.entries.length > 0);
}

export function localProjectScopeHasIdentityCollisions(
  scope: LocalProjectScope,
) {
  const owners = new Map<string, string>();
  const names = new Map<
    string,
    { hasMappedRoot: boolean; hasOrphanedEntry: boolean }
  >();
  for (const entry of scope.entries) {
    const normalizedName = entry.displayName.trim().toLocaleLowerCase("zh-CN");
    const nameState = names.get(normalizedName) ?? {
      hasMappedRoot: false,
      hasOrphanedEntry: false,
    };
    nameState.hasMappedRoot ||= Boolean(entry.localRoot);
    nameState.hasOrphanedEntry ||= !entry.localRoot && !entry.localIdentity;
    names.set(normalizedName, nameState);

    const identities = [
      entry.localIdentity ? `identity:${entry.localIdentity}` : null,
      entry.localRoot
        ? `root:${entry.hostId ?? LOCAL_HOST_ID}:${canonicalPath(entry.localRoot)}`
        : null,
    ].filter((value): value is string => Boolean(value));
    for (const identity of identities) {
      const owner = owners.get(identity);
      if (owner && owner !== entry.scopeKey) return true;
      owners.set(identity, entry.scopeKey);
    }
  }
  return [...names.values()].some(
    (state) => state.hasMappedRoot && state.hasOrphanedEntry,
  );
}

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
      (entry.hostId === undefined || typeof entry.hostId === "string") &&
      (entry.localIdentity === undefined ||
        (typeof entry.localIdentity === "string" &&
          /^[a-f0-9]{64}$/.test(entry.localIdentity))) &&
      (entry.environmentKind === undefined ||
        ["configured", "git", "unknown"].includes(
          String(entry.environmentKind),
        )) &&
      (entry.lastSyncedStatus === undefined ||
        ["pending", "allowed", "denied"].includes(
          String(entry.lastSyncedStatus),
        )) &&
      (entry.backfilledPeriodKey === undefined ||
        entry.backfilledPeriodKey === null ||
        typeof entry.backfilledPeriodKey === "string"),
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
        hostId: entry.hostId,
        localIdentity: entry.localIdentity,
        environmentKind: entry.environmentKind,
        backfilledPeriodKey: entry.backfilledPeriodKey,
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
      ...(localMetadata.get(entry.scopeKey)?.hostId
        ? { hostId: localMetadata.get(entry.scopeKey)!.hostId }
        : {}),
      ...(localMetadata.get(entry.scopeKey)?.localIdentity
        ? { localIdentity: localMetadata.get(entry.scopeKey)!.localIdentity }
        : {}),
      lastSyncedStatus: entry.status,
      ...(localMetadata.get(entry.scopeKey)?.backfilledPeriodKey !== undefined
        ? {
            backfilledPeriodKey: localMetadata.get(entry.scopeKey)!
              .backfilledPeriodKey,
          }
        : {}),
      ...(localMetadata.get(entry.scopeKey)?.environmentKind
        ? {
            environmentKind: localMetadata.get(entry.scopeKey)!.environmentKind,
          }
        : {}),
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
  options: ProjectDiscoveryOptions = {},
) {
  const knownRoots = local.entries
    .filter((entry): entry is LocalProjectScopeEntry & { localRoot: string } =>
      Boolean(entry.localRoot),
    )
    .map((entry) => {
      const hostId = entry.hostId ?? LOCAL_HOST_ID;
      const localRoot =
        hostId === LOCAL_HOST_ID
          ? canonicalPath(entry.localRoot)
          : resolve(entry.localRoot);
      const environment = classifyProjectEnvironment(
        { id: entry.scopeKey, hostId, cwd: localRoot },
        options,
      );
      return {
        ...entry,
        hostId,
        localRoot,
        logicalRoot: environment.localRoot ?? localRoot,
        localIdentity:
          entry.localIdentity ??
          projectLocalIdentity(local.scopeSalt, localRoot, hostId),
      };
    })
    .sort((left, right) => right.localRoot.length - left.localRoot.length);
  const discovered = new Map<string, DiscoveredScope>();
  const threadScopes = new Map<string, string>();

  for (const summary of summaries) {
    const hostId = summary.hostId ?? LOCAL_HOST_ID;
    const environment = classifyProjectEnvironment(summary, options);
    if (
      !summary.cwd ||
      !environment.localRoot ||
      environment.kind === "temporary"
    )
      continue;
    const cwd =
      hostId === LOCAL_HOST_ID
        ? canonicalPath(summary.cwd)
        : resolve(summary.cwd);
    const pathMatch = knownRoots.find(
      (entry) => entry.hostId === hostId && withinPath(cwd, entry.localRoot),
    );
    const environmentIdentity = projectLocalIdentity(
      local.scopeSalt,
      environment.localRoot,
      hostId,
      summary.projectId,
    );
    const pathIdentity = pathMatch
      ? projectLocalIdentity(local.scopeSalt, pathMatch.localRoot, hostId)
      : undefined;
    const pathInherited =
      pathMatch &&
      (!pathMatch.localIdentity ||
        !pathIdentity ||
        pathMatch.localIdentity === pathIdentity)
        ? pathMatch
        : undefined;
    const logicalMatches = knownRoots.filter(
      (entry) =>
        entry.hostId === hostId &&
        entry.logicalRoot === environment.localRoot &&
        (!entry.localIdentity || entry.localIdentity === environmentIdentity),
    );
    const identityMatches = environmentIdentity
      ? knownRoots.filter(
          (entry) =>
            entry.hostId === hostId &&
            entry.localIdentity === environmentIdentity,
        )
      : [];
    const inherited =
      pathInherited ??
      (logicalMatches.length === 1 ? logicalMatches[0] : undefined) ??
      (identityMatches.length === 1 ? identityMatches[0] : undefined);
    const localRoot =
      pathInherited && environment.kind === "unknown"
        ? pathInherited.localRoot
        : environment.localRoot;
    const localIdentity =
      localRoot === environment.localRoot
        ? environmentIdentity
        : projectLocalIdentity(
            local.scopeSalt,
            localRoot,
            hostId,
            summary.projectId,
          );
    const scopeKey =
      inherited?.scopeKey ??
      anonymousProjectScopeKey(
        pluginInstanceId,
        local.scopeSalt,
        localIdentity ?? `path:${localRoot}`,
      );
    const current = discovered.get(scopeKey);
    const preferredLocalRoot =
      current?.localIdentity && !localIdentity ? current.localRoot : localRoot;
    const preferredLocalIdentity =
      localIdentity ?? inherited?.localIdentity ?? current?.localIdentity;
    discovered.set(scopeKey, {
      scopeKey,
      displayName:
        basename(preferredLocalRoot) ||
        inherited?.displayName ||
        current?.displayName ||
        "未命名项目",
      localRoot: preferredLocalRoot,
      ...(hostId === LOCAL_HOST_ID ? {} : { hostId }),
      ...(preferredLocalIdentity
        ? { localIdentity: preferredLocalIdentity }
        : {}),
      sessionCount: (current?.sessionCount ?? 0) + 1,
      environmentKind: environment.kind,
    });
    threadScopes.set(hostThreadKey(summary), scopeKey);
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
  return (
    discovery.threadScopes.get(hostThreadKey(summary)) === summary.scopeKey
  );
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
        hostId: candidate.hostId,
        localIdentity: candidate.localIdentity,
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
        ...(discovered?.hostId
          ? { hostId: discovered.hostId }
          : entry.hostId
            ? { hostId: entry.hostId }
            : {}),
        ...(discovered?.localIdentity
          ? { localIdentity: discovered.localIdentity }
          : entry.localIdentity
            ? { localIdentity: entry.localIdentity }
            : {}),
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

export function authorizedProjectThreads<
  T extends { id: string; hostId?: string },
>(
  summaries: T[],
  threadScopes: Map<string, string>,
  entries: RemoteProjectScopeEntry[],
  now = new Date(),
  collectionStartsAt?: string,
) {
  const policies = new Map(entries.map((entry) => [entry.scopeKey, entry]));
  return summaries.flatMap(
    (summary): Array<T & { scopeKey: string; collectionStartsAt: string }> => {
      const scopeKey = threadScopes.get(hostThreadKey(summary));
      const policy = scopeKey ? policies.get(scopeKey) : undefined;
      if (!scopeKey || !scopeIsActive(policy, now) || !policy?.effectiveFrom)
        return [];
      return [
        {
          ...summary,
          scopeKey,
          collectionStartsAt: collectionStartsAt ?? policy.effectiveFrom,
        },
      ];
    },
  );
}
