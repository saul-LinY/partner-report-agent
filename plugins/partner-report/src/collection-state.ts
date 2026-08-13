import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { dataDirectory } from "./config.js";

export const INITIAL_LOOKBACK_DAYS = 1;
export const INITIAL_PROJECT_SCOPE_LOOKBACK_DAYS = 7;
export const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1_000;
export const COLLECTION_LEASE_MS = 5 * 60 * 1_000;

type ProcessedSessionState = {
  contentHash: string;
  processedAt: string;
};

export type CollectionState = {
  schemaVersion: "1.0";
  pluginInstanceId: string;
  collectionFloorAt: string | null;
  lastSuccessfulRunStartedAt: string | null;
  acceptedSessions: Record<string, ProcessedSessionState>;
  ignoredSessions: Record<string, ProcessedSessionState>;
};

type CollectionLease = {
  schemaVersion: "1.0";
  pluginInstanceId: string;
  runId: string;
  acquiredAt: string;
  heartbeatAt: string;
};

function statePath(directory: string) {
  return resolve(directory, "collection-state.json");
}

function leasePath(directory: string) {
  return resolve(directory, "collection.lock");
}

function emptyState(pluginInstanceId: string): CollectionState {
  return {
    schemaVersion: "1.0",
    pluginInstanceId,
    collectionFloorAt: null,
    lastSuccessfulRunStartedAt: null,
    acceptedSessions: {},
    ignoredSessions: {},
  };
}

function validIso(value: unknown): value is string {
  return (
    typeof value === "string" && Number.isFinite(new Date(value).getTime())
  );
}

function validateState(
  value: unknown,
  pluginInstanceId: string,
): CollectionState {
  if (!value || typeof value !== "object")
    throw Object.assign(new Error("本地采集状态格式无效。"), {
      code: "COLLECTION_STATE_INVALID",
    });
  const state = value as Partial<CollectionState>;
  if (state.pluginInstanceId !== pluginInstanceId)
    return emptyState(pluginInstanceId);
  const acceptedSessions = state.acceptedSessions ?? {};
  if (
    state.schemaVersion !== "1.0" ||
    (state.collectionFloorAt !== null && !validIso(state.collectionFloorAt)) ||
    (state.lastSuccessfulRunStartedAt !== null &&
      !validIso(state.lastSuccessfulRunStartedAt)) ||
    !acceptedSessions ||
    typeof acceptedSessions !== "object" ||
    !state.ignoredSessions ||
    typeof state.ignoredSessions !== "object"
  ) {
    throw Object.assign(new Error("本地采集状态格式无效。"), {
      code: "COLLECTION_STATE_INVALID",
    });
  }
  for (const records of [acceptedSessions, state.ignoredSessions]) {
    for (const [sessionKey, processed] of Object.entries(records)) {
      if (
        !/^[a-f0-9]{64}$/.test(sessionKey) ||
        !processed ||
        typeof processed !== "object" ||
        !/^[a-f0-9]{64}$/.test(processed.contentHash) ||
        !validIso(processed.processedAt)
      ) {
        throw Object.assign(new Error("本地采集状态包含无效的处理记录。"), {
          code: "COLLECTION_STATE_INVALID",
        });
      }
    }
  }
  return { ...state, acceptedSessions } as CollectionState;
}

export function loadCollectionState(
  pluginInstanceId: string,
  directory = dataDirectory(),
) {
  const path = statePath(directory);
  if (!existsSync(path)) return emptyState(pluginInstanceId);
  try {
    return validateState(
      JSON.parse(readFileSync(path, "utf8")),
      pluginInstanceId,
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw Object.assign(new Error("无法读取本地采集状态。"), {
      code: "COLLECTION_STATE_INVALID",
    });
  }
}

export function saveCollectionState(
  state: CollectionState,
  directory = dataDirectory(),
) {
  const path = statePath(directory);
  const temporary = resolve(
    directory,
    `.collection-state.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function initializeCollectionFloor(
  state: CollectionState,
  periodStartsAt: string,
  runStartedAt: string,
) {
  if (state.collectionFloorAt) return state.collectionFloorAt;
  const floor = Math.max(
    new Date(periodStartsAt).getTime(),
    new Date(runStartedAt).getTime() -
      INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000,
  );
  state.collectionFloorAt = new Date(floor).toISOString();
  return state.collectionFloorAt;
}

export function collectionWindow(
  state: CollectionState,
  period: { starts_at: string; ends_at: string },
  runStartedAt: string,
) {
  const periodStart = new Date(period.starts_at).getTime();
  const runStart = new Date(runStartedAt).getTime();
  const floor = Math.max(
    periodStart,
    new Date(state.collectionFloorAt ?? period.starts_at).getTime(),
  );
  const scanStart = state.lastSuccessfulRunStartedAt
    ? Math.max(
        floor,
        new Date(state.lastSuccessfulRunStartedAt).getTime() -
          INCREMENTAL_OVERLAP_MS,
      )
    : floor;
  return {
    extractionStartsAt: new Date(floor).toISOString(),
    extractionEndsAt: new Date(
      Math.min(new Date(period.ends_at).getTime(), runStart),
    ).toISOString(),
    scanStartsAt: new Date(scanStart).toISOString(),
    scanEndsAt: new Date(runStart).toISOString(),
  };
}

export function threadIsInScanWindow(
  updatedAt: string | number | null,
  scanStartsAt: string,
  scanEndsAt: string,
) {
  if (updatedAt == null) return true;
  const timestamp =
    typeof updatedAt === "number" && updatedAt < 10_000_000_000
      ? updatedAt * 1_000
      : new Date(updatedAt).getTime();
  return (
    Number.isFinite(timestamp) &&
    timestamp >= new Date(scanStartsAt).getTime() &&
    timestamp <= new Date(scanEndsAt).getTime()
  );
}

export function initialProjectScopeStartAt(runStartedAt: string) {
  const runStart = new Date(runStartedAt);
  if (!Number.isFinite(runStart.getTime()))
    throw new Error("项目审核开始时间无效，无法计算最近一周。");
  return new Date(
    runStart.getTime() -
      INITIAL_PROJECT_SCOPE_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

export function threadIsInKnownScanWindow(
  updatedAt: string | number | null,
  scanStartsAt: string,
  scanEndsAt: string,
) {
  return (
    updatedAt !== null &&
    threadIsInScanWindow(updatedAt, scanStartsAt, scanEndsAt)
  );
}

export function recordIgnoredSession(
  state: CollectionState,
  sessionKey: string,
  contentHash: string,
  processedAt = new Date().toISOString(),
) {
  const existing = state.ignoredSessions[sessionKey];
  state.ignoredSessions[sessionKey] = {
    contentHash,
    processedAt:
      existing?.contentHash === contentHash
        ? existing.processedAt
        : processedAt,
  };
  delete state.acceptedSessions[sessionKey];
}

export function recordAcceptedSession(
  state: CollectionState,
  sessionKey: string,
  contentHash: string,
  processedAt = new Date().toISOString(),
) {
  const existing = state.acceptedSessions[sessionKey];
  state.acceptedSessions[sessionKey] = {
    contentHash,
    processedAt:
      existing?.contentHash === contentHash
        ? existing.processedAt
        : processedAt,
  };
  delete state.ignoredSessions[sessionKey];
}

export function canAdvanceCollectionCheckpoint(counts: {
  failedRead: number;
  failedExtract: number;
  deferred?: number;
  skipped?: number;
  notProcessed?: number;
}) {
  return (
    counts.failedRead === 0 &&
    counts.failedExtract === 0 &&
    (counts.deferred ?? 0) === 0 &&
    (counts.skipped ?? 0) === 0 &&
    (counts.notProcessed ?? 0) === 0
  );
}

export function reviewCollectionCompletion(input: {
  cursor: number;
  queueLength: number;
  hasCurrentJob: boolean;
  claimedJobs?: number;
  terminalJobs?: number;
  uniqueTerminalJobs?: boolean;
  validFailureAudits?: boolean;
  unexplainedFailedExtract?: number;
  outcomeCountsMatch?: boolean;
  stopped?: boolean;
  counts: {
    failedRead: number;
    failedExtract: number;
    deferred?: number;
    skipped?: number;
    notProcessed?: number;
  };
}) {
  const queueExhausted = input.cursor === input.queueLength;
  const noCurrentJob = !input.hasCurrentJob;
  const allClaimedJobsTerminal =
    (input.claimedJobs ?? 0) === (input.terminalJobs ?? 0);
  const uniqueTerminalJobs = input.uniqueTerminalJobs ?? true;
  const validFailureAudits = input.validFailureAudits ?? true;
  const noUnexplainedFailedExtract =
    (input.unexplainedFailedExtract ?? 0) === 0;
  const outcomeCountsMatch = input.outcomeCountsMatch ?? true;
  const notProcessed = input.counts.notProcessed ?? 0;
  const remainingQueue = Math.max(0, input.queueLength - input.cursor);
  const remainingQueueExplained = queueExhausted
    ? notProcessed === 0
    : input.stopped === true && notProcessed === remainingQueue;
  const readyToFinalize =
    noCurrentJob &&
    allClaimedJobsTerminal &&
    uniqueTerminalJobs &&
    validFailureAudits &&
    noUnexplainedFailedExtract &&
    outcomeCountsMatch &&
    remainingQueueExplained;
  return {
    queueExhausted,
    noCurrentJob,
    allClaimedJobsTerminal,
    uniqueTerminalJobs,
    validFailureAudits,
    noUnexplainedFailedExtract,
    outcomeCountsMatch,
    remainingQueueExplained,
    readyToFinalize,
    checkpointEligible:
      readyToFinalize &&
      queueExhausted &&
      input.stopped !== true &&
      canAdvanceCollectionCheckpoint(input.counts),
  };
}

function writeLease(path: string, lease: CollectionLease, exclusive = false) {
  writeFileSync(path, `${JSON.stringify(lease)}\n`, {
    mode: 0o600,
    ...(exclusive ? { flag: "wx" } : {}),
  });
  chmodSync(path, 0o600);
}

function readLease(path: string): CollectionLease | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CollectionLease;
  } catch {
    return null;
  }
}

export function acquireCollectionLease(
  pluginInstanceId: string,
  runId: string,
  now = new Date(),
  directory = dataDirectory(),
) {
  const path = leasePath(directory);
  const existing = readLease(path);
  if (existing) {
    const heartbeat = new Date(existing.heartbeatAt).getTime();
    if (
      existing.pluginInstanceId === pluginInstanceId &&
      Number.isFinite(heartbeat) &&
      now.getTime() - heartbeat <= COLLECTION_LEASE_MS
    ) {
      throw Object.assign(
        new Error("已有采集任务正在运行，请等待其完成后再试。"),
        { code: "COLLECTION_ALREADY_RUNNING" },
      );
    }
    unlinkSync(path);
  } else if (existsSync(path)) {
    const age = now.getTime() - statSync(path).mtimeMs;
    if (age <= COLLECTION_LEASE_MS) {
      throw Object.assign(new Error("采集租约状态无效且尚未过期。"), {
        code: "COLLECTION_ALREADY_RUNNING",
      });
    }
    unlinkSync(path);
  }
  const timestamp = now.toISOString();
  try {
    writeLease(
      path,
      {
        schemaVersion: "1.0",
        pluginInstanceId,
        runId,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
      },
      true,
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw Object.assign(new Error("已有采集任务正在运行。"), {
        code: "COLLECTION_ALREADY_RUNNING",
      });
    }
    throw error;
  }
}

export function refreshCollectionLease(
  pluginInstanceId: string,
  runId: string,
  now = new Date(),
  directory = dataDirectory(),
) {
  const path = leasePath(directory);
  const lease = readLease(path);
  if (
    !lease ||
    lease.pluginInstanceId !== pluginInstanceId ||
    lease.runId !== runId
  ) {
    throw Object.assign(new Error("当前采集任务已失去运行租约。"), {
      code: "COLLECTION_LEASE_LOST",
    });
  }
  writeLease(path, { ...lease, heartbeatAt: now.toISOString() });
}

export function releaseCollectionLease(
  pluginInstanceId: string,
  runId: string,
  directory = dataDirectory(),
) {
  const path = leasePath(directory);
  const lease = readLease(path);
  if (lease?.pluginInstanceId === pluginInstanceId && lease.runId === runId) {
    unlinkSync(path);
  }
}
