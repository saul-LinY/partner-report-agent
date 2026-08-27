export const CODEX_HOST_THREAD_LIST_LIMIT = 50;
export const CODEX_HOST_PINNED_THREAD_LIMIT = 200;
export const CODEX_HOST_THREAD_ID_MAX_LENGTH = 256;
export const CODEX_HOST_CWD_MAX_LENGTH = 8_192;
export const CODEX_HOST_TIMESTAMP_MAX_LENGTH = 80;
export const CODEX_HOST_THREAD_SOURCE_MAX_LENGTH = 120;

export type HostTimestamp = string | number;

export type HostThreadMetadata = {
  id: string;
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

export function uniqueHostProjectDiscoveryThreads(
  input: HostProjectDiscoveryInput,
) {
  const byId = new Map<string, HostThreadMetadata>();
  for (const thread of [...input.threads, ...input.pinnedThreads]) {
    if (!byId.has(thread.id)) byId.set(thread.id, thread);
  }
  return [...byId.values()];
}

export function hostProjectDiscoveryMayBePartial(
  input: HostProjectDiscoveryInput,
) {
  return input.threads.length === CODEX_HOST_THREAD_LIST_LIMIT;
}
