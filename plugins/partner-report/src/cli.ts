import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sessionExtractionResultSchema } from "@partner-report/contracts";
import {
  PLUGIN_VERSION,
  loadConfig,
  normalizeServerUrl,
  removeSecrets,
  saveConfig,
  saveSecret,
  type PluginConfig,
} from "./config.js";
import { authenticatedRequest, HttpError, publicRequest } from "./http.js";
import { SCHEDULED_COLLECTION_TASK } from "./collection-config.js";
import {
  buildKnownSessionIndex,
  matchingKnownDecision,
  type KnownSession,
} from "./collection-dedup.js";
import {
  acquireCollectionLease,
  canAdvanceCollectionCheckpoint,
  collectionWindow,
  initializeCollectionFloor,
  loadCollectionState,
  recordAcceptedSession,
  recordIgnoredSession,
  refreshCollectionLease,
  releaseCollectionLease,
  reviewCollectionCompletion,
  saveCollectionState,
  threadIsInScanWindow,
} from "./collection-state.js";
import { CodexAppServer } from "./app-server.js";
import {
  buildSessionJob,
  containsSensitive,
  firstNonChineseContributionField,
  isPluginSystemThread,
  pathIsExcluded,
  type CollectionPeriod,
  type ProjectPolicy,
} from "./scan.js";

type Policy = {
  pluginInstanceId: string;
  partnerId: string;
  team: { minimum_plugin_version?: string };
  projects: ProjectPolicy[];
  currentPeriod: (CollectionPeriod & { id: string }) | null;
};

type ConnectivityChallenge = {
  challenge: string;
  challengeExpiresAt: string;
  capabilityVersion: "1.0";
};

type ClaimResponse = ConnectivityChallenge & {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  pluginInstanceId: string;
  partnerId: string;
};

type ThreadSummary = {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: string | number | null;
};

type RunCounts = {
  discovered: number;
  read: number;
  eligible: number;
  uploaded: number;
  ignored: number;
  unchanged: number;
  cachedIgnored: number;
  outsideWindow: number;
  excluded: number;
  failedRead: number;
  failedExtract: number;
};

type CurrentJob = {
  jobId: string;
  inputPath: string;
  resultPath: string;
  expected: any;
};

type RunManifest = {
  schemaVersion: "1.0";
  runId: string;
  pluginInstanceId: string;
  createdAt: string;
  force: boolean;
  period: CollectionPeriod;
  projects: ProjectPolicy[];
  queue: ThreadSummary[];
  cursor: number;
  knownSessions: Record<string, KnownSession>;
  counts: RunCounts;
  current: CurrentJob | null;
};

const RUN_PREFIX = "partner-report-run-";

function option(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function compareVersions(left: string, right: string) {
  const parse = (value: string) =>
    value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function fetchPolicy() {
  const policy = await authenticatedRequest<Policy>("/v1/plugin-bindings/me");
  if (
    policy.team.minimum_plugin_version &&
    compareVersions(PLUGIN_VERSION, policy.team.minimum_plugin_version) < 0
  ) {
    throw Object.assign(
      new Error(
        `Plugin v${PLUGIN_VERSION} 低于 Team 最低版本 v${policy.team.minimum_plugin_version}。`,
      ),
      { code: "PLUGIN_VERSION_BLOCKED" },
    );
  }
  return policy;
}

function scheduledTaskConfig() {
  output({
    status: "scheduled_task_config",
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    setupMode: "create_if_missing_or_repair_prompt_only",
  });
}

async function performConnectivityTest(
  supplied?: ConnectivityChallenge,
): Promise<Record<string, unknown>> {
  let config = loadConfig()!;
  try {
    let connectivity = supplied;
    if (
      !connectivity ||
      new Date(connectivity.challengeExpiresAt).getTime() <= Date.now()
    ) {
      connectivity = await authenticatedRequest<ConnectivityChallenge>(
        "/v1/plugin-instances/me/connectivity-challenge",
        { method: "POST", body: "{}" },
      );
      saveConfig({
        ...config,
        connectivityStatus: "pending",
        pendingConnectivityChallenge: {
          value: connectivity.challenge,
          expiresAt: connectivity.challengeExpiresAt,
        },
      });
    }
    const response = await authenticatedRequest<Record<string, unknown>>(
      "/v1/plugin-instances/me/connectivity-test",
      {
        method: "POST",
        body: JSON.stringify({
          challenge: connectivity.challenge,
          pluginVersion: PLUGIN_VERSION,
          clientTime: new Date().toISOString(),
          capabilityVersion: "1.0",
        }),
      },
    );
    config = loadConfig()!;
    const { pendingConnectivityChallenge: _pending, ...stableConfig } = config;
    saveConfig({
      ...stableConfig,
      connectivityStatus: "verified",
      connectivityVerifiedAt:
        typeof response.verifiedAt === "string"
          ? response.verifiedAt
          : new Date().toISOString(),
    });
    return response;
  } catch (error) {
    config = loadConfig()!;
    saveConfig({ ...config, connectivityStatus: "failed" });
    throw error;
  }
}

function connectedOutput(
  partnerId: string,
  deviceName: string,
  connectivity: Record<string, unknown>,
) {
  const config = loadConfig()!;
  output({
    status: "connected",
    pluginInstanceId: config.pluginInstanceId,
    partnerId,
    deviceName,
    connectivity,
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    nextStep: "使用 $partner-report-sync 创建或修复同名 Codex Scheduled Task。",
  });
}

async function connect() {
  const requestedServerUrl =
    option("server") ?? process.env.PARTNER_REPORT_SERVER_URL;
  if (!requestedServerUrl)
    throw new Error(
      "connect 需要 --server <url>，也可以设置 PARTNER_REPORT_SERVER_URL。",
    );
  const bindingCode =
    option("binding-code") ?? process.env.PARTNER_REPORT_BINDING_CODE;
  if (!bindingCode)
    throw new Error("connect 需要 Admin 生成的 --binding-code <code>。");
  const serverUrl = normalizeServerUrl(
    requestedServerUrl,
    flag("allow-insecure-http"),
  );
  const deviceName = option("device-name", hostname())!;
  const tokens = await publicRequest<ClaimResponse>(
    serverUrl,
    "/v1/plugin-bindings/claim",
    {
      method: "POST",
      body: JSON.stringify({
        bindingCode,
        deviceName,
        pluginVersion: PLUGIN_VERSION,
      }),
    },
  );
  const existing = loadConfig(false);
  if (existing && existing.pluginInstanceId !== tokens.pluginInstanceId)
    removeSecrets(existing.pluginInstanceId);
  saveSecret(tokens.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(tokens.pluginInstanceId, "refresh", tokens.refreshToken);
  saveConfig({
    serverUrl,
    pluginInstanceId: tokens.pluginInstanceId,
    deviceName,
    accessExpiresAt: tokens.expiresAt,
    connectivityStatus: "pending",
    pendingConnectivityChallenge: {
      value: tokens.challenge,
      expiresAt: tokens.challengeExpiresAt,
    },
    excludedSessionIds: existing?.excludedSessionIds ?? [],
    excludedPaths: existing?.excludedPaths ?? [],
  });
  const connectivity = await performConnectivityTest(tokens);
  connectedOutput(tokens.partnerId, deviceName, connectivity);
}

async function connectivityTest() {
  const config = loadConfig()!;
  const pending = config.pendingConnectivityChallenge;
  const connectivity = await performConnectivityTest(
    pending
      ? {
          challenge: pending.value,
          challengeExpiresAt: pending.expiresAt,
          capabilityVersion: "1.0",
        }
      : undefined,
  );
  const policy = await fetchPolicy();
  connectedOutput(policy.partnerId, config.deviceName, connectivity);
}

function summaryFromThread(value: any): ThreadSummary | null {
  if (!value?.id) return null;
  const title =
    typeof value.name === "string"
      ? value.name
      : typeof value.title === "string"
        ? value.title
        : null;
  return {
    id: String(value.id),
    title,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    updatedAt: value.updatedAt ?? value.updated_at ?? value.createdAt ?? null,
  };
}

function createRun(manifest: RunManifest) {
  const runDirectory = mkdtempSync(resolve(tmpdir(), RUN_PREFIX));
  chmodSync(runDirectory, 0o700);
  const runPath = resolve(runDirectory, "run.json");
  writeFileSync(runPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(runPath, 0o600);
  return runPath;
}

function assertRunPath(runPath: string) {
  const absolute = resolve(runPath);
  const runDirectory = dirname(absolute);
  const outsideTemp = relative(resolve(tmpdir()), runDirectory).startsWith(
    "..",
  );
  if (
    outsideTemp ||
    !basename(runDirectory).startsWith(RUN_PREFIX) ||
    basename(absolute) !== "run.json"
  ) {
    throw new Error("Run 路径不属于 Partner Report 临时目录。");
  }
  return absolute;
}

function readRun(runPath: string) {
  const absolute = assertRunPath(runPath);
  const manifest = JSON.parse(readFileSync(absolute, "utf8")) as RunManifest;
  const config = loadConfig()!;
  if (
    manifest.schemaVersion !== "1.0" ||
    manifest.pluginInstanceId !== config.pluginInstanceId
  ) {
    throw new Error("Run 清单无效或不属于当前 Plugin Instance。");
  }
  refreshCollectionLease(manifest.pluginInstanceId, manifest.runId);
  return { absolute, manifest };
}

function saveRun(runPath: string, manifest: RunManifest) {
  writeFileSync(runPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(runPath, 0o600);
}

function removeJobFiles(runPath: string, current: CurrentJob) {
  const runDirectory = dirname(runPath);
  for (const path of [current.inputPath, current.resultPath]) {
    if (dirname(resolve(path)) !== runDirectory)
      throw new Error("Job 文件不属于当前 Run。");
    if (existsSync(path)) unlinkSync(path);
  }
}

function writeJob(runPath: string, jobId: string, modelInput: unknown) {
  const runDirectory = dirname(runPath);
  const inputPath = resolve(runDirectory, `${jobId}-input.json`);
  const resultPath = resolve(runDirectory, `${jobId}-result.json`);
  writeFileSync(inputPath, `${JSON.stringify(modelInput, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(inputPath, 0o600);
  return { inputPath, resultPath };
}

async function postCollectionStatus(
  config: PluginConfig,
  manifest: RunManifest,
  phase: "started" | "completed",
) {
  const { counts } = manifest;
  const lastSyncAt = counts.uploaded > 0 ? new Date().toISOString() : undefined;
  const coverage = {
    discovered: counts.discovered,
    eligible: counts.eligible,
    readable: counts.read,
    extracted: counts.uploaded + counts.unchanged,
    deferred: counts.outsideWindow,
    failedRead: counts.failedRead,
    failedExtract: counts.failedExtract,
    excluded: counts.excluded + counts.ignored + counts.cachedIgnored,
    pendingSync: phase === "completed" ? 0 : manifest.queue.length,
    activeAtCutoff: 0,
    hookMissed: 0,
    warnings: canAdvanceCollectionCheckpoint(counts)
      ? []
      : ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
    ...(lastSyncAt ? { lastSyncAt } : {}),
  };
  await authenticatedRequest("/v1/plugin-instances/me/collection-status", {
    method: "POST",
    body: JSON.stringify({
      pluginVersion: PLUGIN_VERSION,
      deviceName: config.deviceName,
      phase,
      periodKey: manifest.period.period_key,
      sessionCount: counts.uploaded + counts.unchanged,
      factCount: counts.uploaded + counts.unchanged,
      pendingLocalJobs: phase === "completed" ? 0 : manifest.queue.length,
      discoveredCount: counts.discovered,
      eligibleCount: counts.eligible,
      excludedCount: counts.excluded + counts.ignored + counts.cachedIgnored,
      lastScanAt: manifest.createdAt,
      ...(lastSyncAt ? { lastSyncAt } : {}),
      coverage,
    }),
  });
}

async function collectStart() {
  const config = loadConfig()!;
  const policy = await fetchPolicy();
  if (!policy.currentPeriod)
    throw Object.assign(new Error("当前 Team 没有开放的 Report Period。"), {
      code: "REPORT_PERIOD_MISSING",
    });
  const runId = randomUUID();
  const runStartedAt = new Date().toISOString();
  acquireCollectionLease(config.pluginInstanceId, runId);
  let localState: ReturnType<typeof loadCollectionState>;
  let window: ReturnType<typeof collectionWindow>;
  try {
    localState = loadCollectionState(config.pluginInstanceId);
    initializeCollectionFloor(
      localState,
      policy.currentPeriod.starts_at,
      runStartedAt,
    );
    saveCollectionState(localState);
    window = collectionWindow(localState, policy.currentPeriod, runStartedAt);
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  const effectivePeriod: CollectionPeriod = {
    period_key: policy.currentPeriod.period_key,
    starts_at: window.extractionStartsAt,
    ends_at: window.extractionEndsAt,
  };
  const server = new CodexAppServer();
  let listed: any[];
  try {
    await server.connect();
    listed = await server.listThreads();
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  } finally {
    server.close();
  }
  const summaries = listed
    .map(summaryFromThread)
    .filter((value): value is ThreadSummary => Boolean(value));
  const excludedSessionIds = new Set(config.excludedSessionIds ?? []);
  const currentSessionId = process.env.CODEX_THREAD_ID;
  const allowed = summaries.filter(
    (summary) =>
      summary.id !== currentSessionId &&
      !excludedSessionIds.has(summary.id) &&
      !pathIsExcluded(summary.cwd, config.excludedPaths ?? []) &&
      !isPluginSystemThread(summary as unknown as Record<string, unknown>),
  );
  const queue = flag("force")
    ? allowed
    : allowed.filter((summary) =>
        threadIsInScanWindow(
          summary.updatedAt,
          window.scanStartsAt,
          window.scanEndsAt,
        ),
      );
  let state: {
    sessions: Array<{ sessionKey: string; contentHash: string }>;
  };
  try {
    state = await authenticatedRequest(
      `/v1/session-contributions/state?periodKey=${encodeURIComponent(policy.currentPeriod.period_key)}`,
    );
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  const knownSessions = buildKnownSessionIndex({
    remoteAccepted: state.sessions,
    localAccepted: localState.acceptedSessions,
    localIgnored: localState.ignoredSessions,
  });
  const manifest: RunManifest = {
    schemaVersion: "1.0",
    runId,
    pluginInstanceId: config.pluginInstanceId,
    createdAt: runStartedAt,
    force: flag("force"),
    period: effectivePeriod,
    projects: policy.projects,
    queue,
    cursor: 0,
    knownSessions,
    counts: {
      discovered: summaries.length,
      read: 0,
      eligible: 0,
      uploaded: 0,
      ignored: 0,
      unchanged: 0,
      cachedIgnored: 0,
      outsideWindow: allowed.length - queue.length,
      excluded: summaries.length - allowed.length,
      failedRead: 0,
      failedExtract: 0,
    },
    current: null,
  };
  let runPath: string | null = null;
  try {
    runPath = createRun(manifest);
    await postCollectionStatus(config, manifest, "started");
  } catch (error) {
    if (runPath) rmSync(dirname(runPath), { recursive: true, force: true });
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  output({
    status: "started",
    runPath,
    periodKey: manifest.period.period_key,
    collectionStartsAt: manifest.period.starts_at,
    collectionEndsAt: manifest.period.ends_at,
    scanStartsAt: window.scanStartsAt,
    scanEndsAt: window.scanEndsAt,
    discovered: manifest.counts.discovered,
    queued: manifest.queue.length,
    outsideWindow: manifest.counts.outsideWindow,
    excluded: manifest.counts.excluded,
    nextCommand: `collect-next --run ${runPath}`,
  });
}

function currentJobOutput(runPath: string, current: CurrentJob) {
  output({
    status: "job",
    runPath,
    jobId: current.jobId,
    inputPath: current.inputPath,
    resultPath: current.resultPath,
    resultSchema: resolve(
      import.meta.dirname,
      "../schemas/session-extraction-result-v1.json",
    ),
    nextCommand: `collect-submit --run ${runPath} --result ${current.resultPath}`,
  });
}

async function finishRun(
  runPath: string,
  manifest: RunManifest,
  config: PluginConfig,
) {
  await postCollectionStatus(config, manifest, "completed");
  const checkpointAdvanced = canAdvanceCollectionCheckpoint(manifest.counts);
  if (checkpointAdvanced) {
    const state = loadCollectionState(manifest.pluginInstanceId);
    state.lastSuccessfulRunStartedAt = manifest.createdAt;
    saveCollectionState(state);
  }
  const summary = {
    status: "completed",
    reviewed: true,
    periodKey: manifest.period.period_key,
    collectionStartsAt: manifest.period.starts_at,
    collectionEndsAt: manifest.period.ends_at,
    checkpointAdvanced,
    warnings: checkpointAdvanced ? [] : ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
    ...manifest.counts,
  };
  releaseCollectionLease(manifest.pluginInstanceId, manifest.runId);
  rmSync(dirname(runPath), { recursive: true, force: true });
  output(summary);
}

function completionReview(manifest: RunManifest) {
  return reviewCollectionCompletion({
    cursor: manifest.cursor,
    queueLength: manifest.queue.length,
    hasCurrentJob: manifest.current !== null,
    counts: manifest.counts,
  });
}

async function collectNext() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-next 需要 --run <path>。");
  const { absolute, manifest } = readRun(runPath);
  if (manifest.current) return currentJobOutput(absolute, manifest.current);
  const server = new CodexAppServer();
  try {
    await server.connect();
    while (manifest.cursor < manifest.queue.length) {
      const summary = manifest.queue[manifest.cursor++]!;
      let thread: any;
      try {
        thread = await server.readThread(summary.id);
        manifest.counts.read += 1;
      } catch {
        manifest.counts.failedRead += 1;
        saveRun(absolute, manifest);
        continue;
      }
      const job = buildSessionJob({
        pluginInstanceId: manifest.pluginInstanceId,
        sessionId: summary.id,
        title: thread.name ?? summary.title,
        cwd: thread.cwd ?? summary.cwd,
        updatedAt: thread.updatedAt ?? summary.updatedAt,
        turns: Array.isArray(thread.turns) ? thread.turns : [],
        projects: manifest.projects,
        period: manifest.period,
      });
      if (!job) {
        manifest.counts.excluded += 1;
        saveRun(absolute, manifest);
        continue;
      }
      manifest.counts.eligible += 1;
      const known = manifest.knownSessions[job.sessionKey];
      const compatibleContentHashes = new Set([
        job.contentHash,
        ...job.compatibleContentHashes,
      ]);
      const knownDecision = manifest.force
        ? null
        : matchingKnownDecision(known, compatibleContentHashes);
      if (knownDecision) {
        const state = loadCollectionState(manifest.pluginInstanceId);
        if (knownDecision === "accepted")
          recordAcceptedSession(state, job.sessionKey, job.contentHash);
        else recordIgnoredSession(state, job.sessionKey, job.contentHash);
        saveCollectionState(state);
        if (knownDecision === "accepted") manifest.counts.unchanged += 1;
        else manifest.counts.cachedIgnored += 1;
        saveRun(absolute, manifest);
        continue;
      }
      const jobId = randomUUID();
      const paths = writeJob(absolute, jobId, job.modelInput);
      manifest.current = { jobId, ...paths, expected: job.expected };
      saveRun(absolute, manifest);
      return currentJobOutput(absolute, manifest.current);
    }
  } finally {
    server.close();
  }
  output({
    status: "review_required",
    runPath: absolute,
    review: completionReview(manifest),
    nextCommand: `collect-review --run ${absolute}`,
  });
}

async function collectReview() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-review 需要 --run <path>。");
  const { absolute, manifest } = readRun(runPath);
  const review = completionReview(manifest);
  if (!review.readyToFinalize) {
    return output({
      status: "review_failed",
      runPath: absolute,
      review,
      nextCommand: `collect-next --run ${absolute}`,
    });
  }
  await finishRun(absolute, manifest, loadConfig()!);
}

function assertImmutableContribution(contribution: any, expected: any) {
  for (const key of [
    "schemaVersion",
    "periodKey",
    "sessionKey",
    "contentHash",
    "project",
    "activity",
    "observedAt",
  ]) {
    if (!isDeepStrictEqual(contribution[key], expected[key]))
      throw new Error(`模型修改了不可变字段 contribution.${key}。`);
  }
  const { modelVersion: _actualModel, ...actualProduction } =
    contribution.production;
  if (!isDeepStrictEqual(actualProduction, expected.production))
    throw new Error("模型修改了不可变字段 contribution.production。");
  if (contribution.contributions.length === 0)
    throw new Error("include 结果必须至少包含一条有价值的项目贡献。");
}

function assertChineseContribution(contribution: any) {
  const invalid = firstNonChineseContributionField(contribution);
  if (invalid) {
    throw Object.assign(new Error(`上传字段 ${invalid} 必须使用中文。`), {
      code: "CHINESE_OUTPUT_REQUIRED",
    });
  }
}

async function collectSubmit() {
  const runPath = option("run");
  const resultPath = option("result");
  if (!runPath || !resultPath)
    throw new Error("collect-submit 需要 --run <path> --result <path>。");
  const { absolute, manifest } = readRun(runPath);
  const current = manifest.current;
  if (!current) throw new Error("当前 Run 没有待提交 Job。");
  if (resolve(resultPath) !== resolve(current.resultPath))
    throw new Error("Result 路径与当前 Job 不匹配。");
  const result = sessionExtractionResultSchema.parse(
    JSON.parse(readFileSync(current.resultPath, "utf8")),
  ) as any;

  if (result.decision === "ignore") {
    const state = loadCollectionState(manifest.pluginInstanceId);
    recordIgnoredSession(
      state,
      current.expected.sessionKey,
      current.expected.contentHash,
    );
    saveCollectionState(state);
    removeJobFiles(absolute, current);
    manifest.counts.ignored += 1;
    manifest.knownSessions[current.expected.sessionKey] = {
      contentHashes: [current.expected.contentHash],
      decision: "ignored",
    };
    manifest.current = null;
    saveRun(absolute, manifest);
    return output({
      status: "ignored",
      reason: result.reason,
      nextCommand: `collect-next --run ${absolute}`,
    });
  }

  assertImmutableContribution(result.contribution, current.expected);
  assertChineseContribution(result.contribution);
  if (containsSensitive(result.contribution))
    throw Object.assign(new Error("贡献结果包含疑似敏感值，已阻止上传。"), {
      code: "SENSITIVE_EGRESS_REJECTED",
    });
  const idempotencyKey = sha256(
    `${result.contribution.sessionKey}:${result.contribution.periodKey}:${result.contribution.contentHash}`,
  );
  const response = await authenticatedRequest<Record<string, unknown>>(
    "/v1/session-contributions",
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(result.contribution),
    },
  );
  const state = loadCollectionState(manifest.pluginInstanceId);
  recordAcceptedSession(
    state,
    result.contribution.sessionKey,
    result.contribution.contentHash,
  );
  saveCollectionState(state);
  removeJobFiles(absolute, current);
  manifest.counts.uploaded += 1;
  manifest.knownSessions[result.contribution.sessionKey] = {
    contentHashes: [result.contribution.contentHash],
    decision: "accepted",
  };
  manifest.current = null;
  saveRun(absolute, manifest);
  output({
    status: "uploaded",
    response,
    nextCommand: `collect-next --run ${absolute}`,
  });
}

function collectSkip() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-skip 需要 --run <path>。");
  const { absolute, manifest } = readRun(runPath);
  const current = manifest.current;
  if (!current) throw new Error("当前 Run 没有待跳过 Job。");
  removeJobFiles(absolute, current);
  manifest.counts.failedExtract += 1;
  manifest.current = null;
  saveRun(absolute, manifest);
  output({
    status: "skipped",
    errorCode: option("error-code", "EXTRACT_FAILED"),
    nextCommand: `collect-next --run ${absolute}`,
  });
}

async function status() {
  const config = loadConfig(false);
  if (!config) return output({ status: "not_connected" });
  const policy = await fetchPolicy();
  const localState = loadCollectionState(config.pluginInstanceId);
  const state = policy.currentPeriod
    ? await authenticatedRequest<{ sessions: unknown[] }>(
        `/v1/session-contributions/state?periodKey=${encodeURIComponent(policy.currentPeriod.period_key)}`,
      )
    : { sessions: [] };
  output({
    status: "connected",
    pluginVersion: PLUGIN_VERSION,
    deviceName: config.deviceName,
    connectivityStatus: config.connectivityStatus ?? "pending",
    periodKey: policy.currentPeriod?.period_key ?? null,
    acceptedSessionCount: state.sessions.length,
    localAcceptedSessionCount: Object.keys(localState.acceptedSessions).length,
    ignoredSessionCount: Object.keys(localState.ignoredSessions).length,
    collectionFloorAt: localState.collectionFloorAt,
    lastSuccessfulRunStartedAt: localState.lastSuccessfulRunStartedAt,
    excludedSessionCount: config.excludedSessionIds.length,
    excludedPathCount: config.excludedPaths.length,
  });
}

function configureExclusion(kind: "session" | "path", remove = false) {
  const config = loadConfig()!;
  const raw = option(kind === "session" ? "session-id" : "path");
  if (!raw)
    throw new Error(
      kind === "session"
        ? "需要 --session-id <id>。"
        : "需要 --path <absolute-path>。",
    );
  const value = kind === "path" ? resolve(raw) : raw.trim();
  const key = kind === "session" ? "excludedSessionIds" : "excludedPaths";
  const current = new Set(config[key] ?? []);
  if (remove) current.delete(value);
  else current.add(value);
  saveConfig({ ...config, [key]: [...current].sort() });
  output({
    status: remove ? "exclusion_removed" : "excluded",
    kind,
    value,
  });
}

function help() {
  output({
    commands: [
      "connect --server <url> --binding-code <code> [--device-name <name>] [--allow-insecure-http]",
      "connectivity-test",
      "scheduled-task-config",
      "collect-start [--force]",
      "collect-next --run <path>",
      "collect-review --run <path>",
      "collect-submit --run <path> --result <path>",
      "collect-skip --run <path> [--error-code <code>]",
      "status",
      "exclude-session --session-id <id>",
      "include-session --session-id <id>",
      "exclude-path --path <absolute-path>",
      "include-path --path <absolute-path>",
    ],
  });
}

const command = process.argv[2] ?? "help";
try {
  if (command === "connect") await connect();
  else if (command === "connectivity-test") await connectivityTest();
  else if (command === "scheduled-task-config") scheduledTaskConfig();
  else if (command === "collect-start" || command === "daily-collect")
    await collectStart();
  else if (command === "collect-next") await collectNext();
  else if (command === "collect-review") await collectReview();
  else if (command === "collect-submit") await collectSubmit();
  else if (command === "collect-skip") collectSkip();
  else if (command === "status") await status();
  else if (command === "exclude-session") configureExclusion("session");
  else if (command === "include-session") configureExclusion("session", true);
  else if (command === "exclude-path") configureExclusion("path");
  else if (command === "include-path") configureExclusion("path", true);
  else help();
} catch (error) {
  const code =
    error instanceof HttpError
      ? error.code
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "PLUGIN_COMMAND_FAILED";
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      code,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
