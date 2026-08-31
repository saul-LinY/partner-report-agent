export const CODEX_HOST_THREAD_LIST_LIMIT = 50;
export const CODEX_HOST_PINNED_THREAD_LIMIT = 200;
export const CODEX_HOST_THREAD_ID_MAX_LENGTH = 256;
export const CODEX_HOST_ID_MAX_LENGTH = 512;
export const CODEX_HOST_CWD_MAX_LENGTH = 8_192;
export const CODEX_HOST_TIMESTAMP_MAX_LENGTH = 80;
export const CODEX_HOST_THREAD_SOURCE_MAX_LENGTH = 120;
export const CODEX_HOST_KIND_MAX_LENGTH = 40;
export const CODEX_HOST_PROJECT_ID_MAX_LENGTH = 512;

export type HostTimestamp = string | number;

export type HostThreadMetadata = {
  id: string;
  hostId: string;
  kind: string;
  projectId?: string | null;
  cwd: string | null;
  createdAt?: HostTimestamp | null;
  updatedAt: HostTimestamp | null;
  archived: boolean;
  ephemeral: boolean;
  threadSource?: string | null;
  systemGenerated: boolean;
};

export type HostProjectDiscoveryInput = {
  threads: HostThreadMetadata[];
  pinnedThreads: HostThreadMetadata[];
};

export type HostCollectionDiscoveryInput = HostProjectDiscoveryInput & {
  unavailableHosts: unknown[];
  unavailableSources: unknown[];
};

export const LOCAL_HOST_ID = "local";

export function hostThreadKey(thread: { id: string; hostId?: string | null }) {
  const hostId = thread.hostId?.trim() || LOCAL_HOST_ID;
  return hostId === LOCAL_HOST_ID
    ? thread.id
    : `host:${hostId.length}:${hostId}:${thread.id}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex 宿主任务元数据格式无效。");
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Codex 宿主任务元数据包含未允许字段。");
}

function timestamp(
  value: unknown,
  optional = false,
): HostTimestamp | null | undefined {
  if (value === undefined && optional) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= CODEX_HOST_TIMESTAMP_MAX_LENGTH
  )
    return value.trim();
  throw new Error("Codex 宿主任务时间格式无效。");
}

function optionalBoolean(value: unknown) {
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw new Error("Codex 宿主任务布尔字段格式无效。");
  return value;
}

function parseHostThreadMetadata(value: unknown): HostThreadMetadata {
  const item = record(value);
  onlyKeys(
    item,
    new Set([
      "id",
      "hostId",
      "kind",
      "projectId",
      "cwd",
      "createdAt",
      "updatedAt",
      "archived",
      "ephemeral",
      "threadSource",
      "systemGenerated",
    ]),
  );
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id || id.length > CODEX_HOST_THREAD_ID_MAX_LENGTH)
    throw new Error("Codex 宿主任务 ID 格式无效。");
  const hostId =
    typeof item.hostId === "string" && item.hostId.trim()
      ? item.hostId.trim()
      : LOCAL_HOST_ID;
  if (hostId.length > CODEX_HOST_ID_MAX_LENGTH)
    throw new Error("Codex 宿主 Host ID 格式无效。");
  const kind =
    typeof item.kind === "string" && item.kind.trim()
      ? item.kind.trim().toLowerCase()
      : "codex";
  if (kind.length > CODEX_HOST_KIND_MAX_LENGTH)
    throw new Error("Codex 宿主任务类型格式无效。");
  const projectId = item.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" ||
      projectId.trim().length > CODEX_HOST_PROJECT_ID_MAX_LENGTH)
  )
    throw new Error("Codex 宿主项目 ID 格式无效。");
  const cwd = item.cwd;
  if (
    cwd !== null &&
    (typeof cwd !== "string" || cwd.length > CODEX_HOST_CWD_MAX_LENGTH)
  )
    throw new Error("Codex 宿主任务目录格式无效。");
  const threadSource = item.threadSource;
  if (
    threadSource !== undefined &&
    threadSource !== null &&
    (typeof threadSource !== "string" ||
      threadSource.trim().length > CODEX_HOST_THREAD_SOURCE_MAX_LENGTH)
  )
    throw new Error("Codex 宿主任务来源格式无效。");
  const createdAt = timestamp(item.createdAt, true);
  return {
    id,
    hostId,
    kind,
    ...(projectId === undefined
      ? {}
      : {
          projectId:
            typeof projectId === "string" ? projectId.trim() || null : null,
        }),
    cwd,
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt: timestamp(item.updatedAt) ?? null,
    archived: optionalBoolean(item.archived),
    ephemeral: optionalBoolean(item.ephemeral),
    ...(threadSource === undefined
      ? {}
      : {
          threadSource:
            typeof threadSource === "string"
              ? threadSource.trim()
              : threadSource,
        }),
    systemGenerated: optionalBoolean(item.systemGenerated),
  };
}

function threadList(value: unknown, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error("Codex 宿主任务列表数量无效。");
  return value.map(parseHostThreadMetadata);
}

export function parseHostProjectDiscoveryInput(value: unknown) {
  const input = record(value);
  onlyKeys(input, new Set(["threads", "pinnedThreads"]));
  return {
    threads: threadList(input.threads, CODEX_HOST_THREAD_LIST_LIMIT),
    pinnedThreads: threadList(
      input.pinnedThreads ?? [],
      CODEX_HOST_PINNED_THREAD_LIMIT,
    ),
  };
}

export function parseHostCollectionDiscoveryInput(value: unknown) {
  const input = record(value);
  onlyKeys(
    input,
    new Set([
      "threads",
      "pinnedThreads",
      "unavailableHosts",
      "unavailableSources",
    ]),
  );
  if (
    !Array.isArray(input.unavailableHosts) ||
    !Array.isArray(input.unavailableSources) ||
    input.unavailableHosts.length > 200 ||
    input.unavailableSources.length > 200
  )
    throw new Error("Codex 宿主可用性元数据格式无效。");
  return {
    threads: threadList(input.threads, CODEX_HOST_THREAD_LIST_LIMIT),
    pinnedThreads: threadList(
      input.pinnedThreads ?? [],
      CODEX_HOST_PINNED_THREAD_LIMIT,
    ),
    unavailableHosts: input.unavailableHosts,
    unavailableSources: input.unavailableSources,
  } satisfies HostCollectionDiscoveryInput;
}

export function uniqueHostProjectDiscoveryThreads(
  input: HostProjectDiscoveryInput,
) {
  const byId = new Map<string, HostThreadMetadata>();
  for (const thread of [...input.threads, ...input.pinnedThreads]) {
    const key = hostThreadKey(thread);
    if (!byId.has(key)) byId.set(key, thread);
  }
  return [...byId.values()];
}

function timestampMs(value: HostTimestamp | null | undefined) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function assertHostCollectionDiscoveryComplete(
  input: HostCollectionDiscoveryInput,
  scanStartsAt: string,
) {
  if (input.unavailableHosts.length || input.unavailableSources.length)
    throw Object.assign(
      new Error("Codex 有不可用的 Host 或任务来源，本轮不会推进采集游标。"),
      { code: "HOST_THREAD_DISCOVERY_INCOMPLETE" },
    );
  if (input.threads.length < CODEX_HOST_THREAD_LIST_LIMIT) return;
  const oldest = Math.min(
    ...input.threads
      .map((thread) => timestampMs(thread.updatedAt))
      .filter((value): value is number => value !== null),
  );
  const startsAt = new Date(scanStartsAt).getTime();
  if (
    !Number.isFinite(oldest) ||
    !Number.isFinite(startsAt) ||
    oldest >= startsAt
  )
    throw Object.assign(
      new Error(
        "Codex 宿主任务列表没有覆盖完整采集时间窗，本轮不会推进采集游标。",
      ),
      { code: "HOST_THREAD_DISCOVERY_INCOMPLETE" },
    );
}

export function hostProjectDiscoveryMayBePartial(
  input: HostProjectDiscoveryInput,
) {
  return input.threads.length === CODEX_HOST_THREAD_LIST_LIMIT;
}
