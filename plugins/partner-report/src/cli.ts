import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  projectDescriptionResultSchema,
  sessionExtractionResultSchema,
} from "@partner-report/contracts";
import {
  PLUGIN_VERSION,
  loadConfig,
  loadSecret,
  migrateLegacyInstallation,
  normalizeServerUrl,
  removeSecret,
  removeSecrets,
  saveConfig,
  saveSecret,
  type PluginConfig,
} from "./config.js";
import { authenticatedRequest, HttpError, publicRequest } from "./http.js";
import {
  SCHEDULED_COLLECTION_TASK,
  SCHEDULED_COLLECTION_TASK_POLICY,
} from "./collection-config.js";
import {
  buildKnownSessionIndex,
  matchingKnownDecision,
  type KnownSession,
} from "./collection-dedup.js";
import {
  acquireCollectionLease,
  canAdvanceCollectionCheckpoint,
  collectionWindow,
  initialProjectDiscoveryNeedsResume,
  initialProjectScopeStartAt,
  initializeCollectionFloor,
  loadCollectionState,
  recordAcceptedSession,
  recordIgnoredSession,
  refreshCollectionLease,
  releaseCollectionLease,
  reviewCollectionCompletion,
  saveCollectionState,
  threadIsInKnownScanWindow,
  threadIsInScanWindow,
} from "./collection-state.js";
import {
  MAX_EXTRACTION_FAILURES,
  appendExtractionFailure,
  collectionDeadline,
  countJobOutcomes,
  failedExtractOutcomeIsExplained,
  immutableContributionFromRequirements,
  jobOutcomeFailureAuditIsValid,
  legalCollectSkipOutcome,
  newlyPendingProjectScopeKeys,
  projectScopeApprovalDeadline,
  repairImmutableResult,
  resolveProjectScopeApprovals,
  shouldStopBeforeClaim,
  type ExtractionFailure,
  type ExtractionFailureCode,
  type JobOutcome,
} from "./collection-run.js";
import { CodexAppServer } from "./app-server.js";
import {
  buildSessionJob,
  containsSensitive,
  firstNonChineseContributionField,
  isOfficialAutomationThread,
  isPluginSystemThread,
  mappedProject,
  pathIsExcluded,
  type CollectionPeriod,
  type ProjectPolicy,
} from "./scan.js";
import {
  authorizedProjectThreads,
  discoverProjectScopes,
  inspectLocalProjectScope,
  inspectLocalProjectScopeChanges,
  mergeDiscoveredRoots,
  mergeRemoteProjectScope,
  saveLocalProjectScope,
  scopeIsActive,
  scopeNeedsCurrentPeriodBackfill,
  threadMayBeRead,
  type LocalProjectScope,
  type RemoteProjectScopePolicy,
} from "./project-scope.js";
import {
  decodeWaitPeriod,
  waitForCondition,
  waitForConditionAndContinue,
} from "./poll-wait.js";
import {
  buildProjectDescriptionSource,
  projectDescriptionIsChinese,
} from "./project-description.js";

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

type RecoveryTokenResponse = ConnectivityChallenge & {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  pluginInstanceId: string;
};

type ProjectScopeCardStatus = {
  status: "pending" | "sent";
  policyVersion: number;
  retryAfterSeconds: number;
};

type ThreadSummary = {
  id: string;
  title: string | null;
  cwd: string | null;
  createdAt: string | number | null;
  updatedAt: string | number | null;
  archived: boolean;
  ephemeral?: boolean;
  threadSource?: string | null;
  systemGenerated?: boolean;
};

type ScopedThreadSummary = ThreadSummary & {
  scopeKey: string;
  collectionStartsAt?: string;
  collectionEndsAt?: string;
  countedAsExcluded?: boolean;
  initialCountBucket?: "excluded" | "outsideWindow";
};

type ScopeApprovalWait = {
  scopeKeys: string[];
  deadlineAt: number;
  attempt: number;
  deferredQueue: ScopedThreadSummary[];
};

type EndOfRunScopeScan = {
  completed: boolean;
  cardPolicyVersion: number | null;
  cardDeliveryDeadlineAt: number | null;
  cardDeliveryAttempt: number;
};

type ProjectDescriptionQueueItem = {
  scopeKey: string;
  projectName: string;
  rootFingerprint: string;
  sourceFingerprint: string;
  modelInput: Record<string, unknown>;
};

type ProjectDescriptionCurrent = ProjectDescriptionQueueItem & {
  jobId?: string;
  inputPath: string;
  resultPath: string;
  failures: number;
};

type ProjectDescriptionScan = {
  initialized: boolean;
  queue: ProjectDescriptionQueueItem[];
  cursor: number;
  current: ProjectDescriptionCurrent | null;
  generated: number;
  unchanged: number;
  failed: number;
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
  skipped: number;
  deferred: number;
  notProcessed: number;
};

type CurrentJob = {
  jobId: string;
  inputPath: string;
  resultPath: string;
  expected: any;
  failures: ExtractionFailure[];
};

type RunManifest = {
  schemaVersion: "1.0" | "1.1" | "1.2" | "1.3";
  runId: string;
  pluginInstanceId: string;
  createdAt: string;
  deadlineAt: string;
  force: boolean;
  period: CollectionPeriod;
  reportPeriodStartsAt?: string;
  reportPeriodEndsAt?: string;
  scanStartsAt?: string;
  scanEndsAt?: string;
  initialThreadIds?: string[];
  projects: ProjectPolicy[];
  queue: ScopedThreadSummary[];
  cursor: number;
  knownSessions: Record<string, KnownSession>;
  counts: RunCounts;
  current: CurrentJob | null;
  claimedJobs: number;
  outcomes: JobOutcome[];
  stopReason?:
    "TIME_BUDGET_EXHAUSTED" | "RUN_INTERRUPTED" | "TEMPORARILY_UNAVAILABLE";
  approvalWait?: ScopeApprovalWait | null;
  endOfRunScopeScan?: EndOfRunScopeScan;
  projectDescriptionScan?: ProjectDescriptionScan;
  scopeBackfillKeys?: string[];
};

const RUN_PREFIX = "partner-report-run-";
const POLL_TOTAL_MS = 10 * 60_000;
const POLL_SEGMENT_MS = 45_000;

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

async function fetchProjectScope(init: RequestInit = {}) {
  return authenticatedRequest<RemoteProjectScopePolicy>(
    "/v1/project-scope",
    init,
  );
}

function cacheRemoteProjectScope(remote: RemoteProjectScopePolicy) {
  const inspection = inspectLocalProjectScope(remote.pluginInstanceId);
  const scope = mergeRemoteProjectScope(inspection.scope, remote);
  if (inspection.state !== "valid") saveLocalProjectScope(scope);
  return { ...inspection, scope };
}

async function synchronizeLocalProjectScope(
  remote: RemoteProjectScopePolicy,
  inspection = inspectLocalProjectScope(remote.pluginInstanceId),
) {
  let synchronizedRemote = remote;
  let changedCount = 0;
  if (inspection.state === "valid") {
    const changes = inspectLocalProjectScopeChanges(inspection.scope, remote);
    if (changes.kind === "conflict")
      throw Object.assign(new Error(changes.reason), {
        code: "PROJECT_SCOPE_LOCAL_CONFLICT",
        currentVersion: remote.version,
      });
    if (changes.kind === "changes") {
      synchronizedRemote = await fetchProjectScope({
        method: "PATCH",
        body: JSON.stringify({
          baseVersion: remote.version,
          decisions: changes.decisions,
        }),
      });
      changedCount = changes.decisions.length;
    }
  }
  const scope = mergeRemoteProjectScope(inspection.scope, synchronizedRemote);
  saveLocalProjectScope(scope);
  return { inspection, remote: synchronizedRemote, scope, changedCount };
}

function scheduledTaskConfig() {
  output({
    status: "scheduled_task_config",
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    taskPolicy: SCHEDULED_COLLECTION_TASK_POLICY,
    setupMode:
      "create_if_missing_or_update_prompt_or_reset_task_on_explicit_request",
  });
}

async function performConnectivityTest(
  supplied?: ConnectivityChallenge,
): Promise<Record<string, unknown>> {
  let config = loadConfig()!;
  try {
    const issueChallenge = async () => {
      const connectivity = await authenticatedRequest<ConnectivityChallenge>(
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
      return connectivity;
    };
    let connectivity =
      supplied && new Date(supplied.challengeExpiresAt).getTime() > Date.now()
        ? supplied
        : await issueChallenge();
    const submitChallenge = () =>
      authenticatedRequest<Record<string, unknown>>(
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
    let response: Record<string, unknown>;
    try {
      response = await submitChallenge();
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        !["CHALLENGE_INVALID", "CHALLENGE_EXPIRED"].includes(error.code)
      ) {
        throw error;
      }
      connectivity = await issueChallenge();
      response = await submitChallenge();
    }
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

async function setServerUrl() {
  const requestedServerUrl =
    option("server") ?? process.env.PARTNER_REPORT_SERVER_URL;
  if (!requestedServerUrl)
    throw new Error(
      "server-url-set 需要 --server <url>，也可以设置 PARTNER_REPORT_SERVER_URL。",
    );
  const config = loadConfig()!;
  const serverUrl = normalizeServerUrl(
    requestedServerUrl,
    flag("allow-insecure-http"),
  );
  saveConfig({ ...config, serverUrl });
  const connectivity = await performConnectivityTest();
  output({
    status: "server_url_updated",
    serverUrl,
    pluginInstanceId: config.pluginInstanceId,
    connectivity,
  });
}

function authRecoveryOutput(expiresAt: string) {
  output({
    status: "auth_recovery_required",
    message: "连接恢复确认卡已发送到飞书。确认后，下次运行会自动继续。",
    expiresAt,
    checkpointAdvanced: false,
    counts: {
      discovered: 0,
      read: 0,
      uploaded: 0,
      ignored: 0,
      skipped: 0,
      failedExtract: 0,
      deferred: 0,
      notProcessed: 0,
    },
  });
}

function clearAuthRecovery(config: PluginConfig) {
  const { pendingAuthRecovery: _pending, ...stableConfig } = config;
  removeSecret(config.pluginInstanceId, "recovery");
  saveConfig(stableConfig);
}

async function startAuthRecovery() {
  const config = loadConfig()!;
  if (config.pendingAuthRecovery) {
    authRecoveryOutput(config.pendingAuthRecovery.expiresAt);
    return;
  }
  const deviceCode = randomBytes(32).toString("base64url");
  const recovery = await publicRequest<{
    status: "pending" | "approved";
    expiresAt: string;
  }>(config.serverUrl, "/v1/plugin-bindings/recovery-authorizations", {
    method: "POST",
    body: JSON.stringify({
      pluginInstanceId: config.pluginInstanceId,
      deviceName: config.deviceName,
      pluginVersion: PLUGIN_VERSION,
      deviceCode,
    }),
  });
  saveSecret(config.pluginInstanceId, "recovery", deviceCode);
  saveConfig({
    ...config,
    pendingAuthRecovery: {
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(recovery.expiresAt).toISOString(),
    },
  });
  authRecoveryOutput(new Date(recovery.expiresAt).toISOString());
}

async function resumeAuthRecovery(): Promise<"continue" | "waiting"> {
  let config = loadConfig()!;
  const pending = config.pendingAuthRecovery;
  if (!pending) return "continue";
  if (new Date(pending.expiresAt).getTime() <= Date.now()) {
    clearAuthRecovery(config);
    return "continue";
  }
  let deviceCode: string;
  try {
    deviceCode = loadSecret(config.pluginInstanceId, "recovery");
  } catch {
    clearAuthRecovery(config);
    return "continue";
  }
  let tokens: RecoveryTokenResponse;
  try {
    tokens = await publicRequest<RecoveryTokenResponse>(
      config.serverUrl,
      "/v1/plugin-bindings/device-authorizations/token",
      {
        method: "POST",
        body: JSON.stringify({ deviceCode }),
      },
    );
  } catch (error) {
    if (error instanceof HttpError && error.code === "AUTHORIZATION_PENDING") {
      authRecoveryOutput(pending.expiresAt);
      return "waiting";
    }
    if (
      error instanceof HttpError &&
      ["DEVICE_CODE_EXPIRED", "DEVICE_CODE_CONSUMED"].includes(error.code)
    ) {
      clearAuthRecovery(config);
      return "continue";
    }
    throw error;
  }
  if (tokens.pluginInstanceId !== config.pluginInstanceId)
    throw new Error("恢复响应的 Plugin Instance 不匹配。");
  saveSecret(config.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(config.pluginInstanceId, "refresh", tokens.refreshToken);
  removeSecret(config.pluginInstanceId, "recovery");
  const { pendingAuthRecovery: _pending, ...stableConfig } = config;
  saveConfig({
    ...stableConfig,
    accessExpiresAt: tokens.expiresAt,
    connectivityStatus: "pending",
    pendingConnectivityChallenge: {
      value: tokens.challenge,
      expiresAt: tokens.challengeExpiresAt,
    },
  });
  await performConnectivityTest(tokens);
  return "continue";
}

function connectedOutput(
  partnerId: string,
  deviceName: string,
  connectivity: Record<string, unknown>,
  projectScope?: Record<string, unknown>,
) {
  const config = loadConfig()!;
  output({
    status: projectScope?.status ?? "connected",
    pluginInstanceId: config.pluginInstanceId,
    partnerId,
    deviceName,
    connectivity,
    ...(projectScope ?? {}),
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    taskPolicy: SCHEDULED_COLLECTION_TASK_POLICY,
    nextStep:
      "首次连接时创建缺失的同名 Codex Scheduled Task；已有任务保持不变。",
  });
}

async function discoverProjectScopeAfterBinding() {
  const config = loadConfig()!;
  const [policy, remoteScope] = await Promise.all([
    fetchPolicy(),
    fetchProjectScope(),
  ]);
  if (!policy.currentPeriod)
    throw Object.assign(new Error("当前 Team 没有开放的 Report Period。"), {
      code: "REPORT_PERIOD_MISSING",
    });
  const localInspection = inspectLocalProjectScope(config.pluginInstanceId);
  if (
    remoteScope.initialized ||
    remoteScope.entries.some((entry) => entry.status === "pending")
  ) {
    const localScope = mergeRemoteProjectScope(
      localInspection.scope,
      remoteScope,
    );
    saveLocalProjectScope(localScope);
    return projectScopePendingStatus(
      policy.currentPeriod.period_key,
      localScope,
    );
  }

  const runStartedAt = new Date().toISOString();
  const scanStartsAt = initialProjectScopeStartAt(runStartedAt);
  const server = new CodexAppServer();
  let listed: any[];
  try {
    await server.connect();
    listed = await server.listThreads({ updatedSince: scanStartsAt });
  } finally {
    server.close();
  }
  const summaries = listed
    .map(summaryFromThread)
    .filter((value): value is ThreadSummary => Boolean(value));
  const excludedSessionIds = new Set(config.excludedSessionIds ?? []);
  const currentSessionId = process.env.CODEX_THREAD_ID;
  const metadataEligible = summaries.filter(
    (summary) =>
      summary.id !== currentSessionId &&
      !summary.archived &&
      !excludedSessionIds.has(summary.id) &&
      !pathIsExcluded(summary.cwd, config.excludedPaths ?? []) &&
      !isPluginSystemThread(summary as unknown as Record<string, unknown>),
  );
  const permissionDiscoverySummaries = metadataEligible.filter((summary) =>
    threadIsInKnownScanWindow(summary.updatedAt, scanStartsAt, runStartedAt),
  );
  const discovery = discoverProjectScopes(
    config.pluginInstanceId,
    localInspection.scope,
    permissionDiscoverySummaries,
    {
      configuredRoots: configuredProjectRoots(policy.projects),
    },
  );
  const registeredScope = await authenticatedRequest<RemoteProjectScopePolicy>(
    "/v1/project-scope/candidates",
    {
      method: "POST",
      body: JSON.stringify({
        periodKey: policy.currentPeriod.period_key,
        initialDiscovery: true,
        candidates: discovery.candidates.map((candidate) => ({
          scopeKey: candidate.scopeKey,
          displayName: candidate.displayName,
          sessionCount: candidate.sessionCount,
        })),
      }),
    },
  );
  const localScope = mergeDiscoveredRoots(
    mergeRemoteProjectScope(localInspection.scope, registeredScope),
    discovery.candidates,
  );
  saveLocalProjectScope(localScope);
  return projectScopePendingStatus(policy.currentPeriod.period_key, localScope);
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
  const projectScope = await discoverProjectScopeAfterBinding();
  connectedOutput(tokens.partnerId, deviceName, connectivity, projectScope);
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
  const [policy, remoteScope] = await Promise.all([
    fetchPolicy(),
    fetchProjectScope(),
  ]);
  const projectScope = initialProjectDiscoveryNeedsResume(
    Boolean(pending),
    remoteScope.initialized,
  )
    ? await discoverProjectScopeAfterBinding()
    : undefined;
  connectedOutput(
    policy.partnerId,
    config.deviceName,
    connectivity,
    projectScope,
  );
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
    createdAt: value.createdAt ?? value.created_at ?? null,
    updatedAt:
      value.updatedAt ??
      value.updated_at ??
      value.createdAt ??
      value.created_at ??
      null,
    archived:
      value.archived === true ||
      value.isArchived === true ||
      (value.archived_at !== null && value.archived_at !== undefined),
    ephemeral: value.ephemeral === true,
    threadSource:
      typeof value.threadSource === "string"
        ? value.threadSource
        : typeof value.thread_source === "string"
          ? value.thread_source
          : null,
    systemGenerated:
      value.ephemeral === true ||
      isPluginSystemThread(value as Record<string, unknown>) ||
      isOfficialAutomationThread(value as Record<string, unknown>),
  };
}

function configuredProjectRoots(projects: ProjectPolicy[]) {
  return projects.flatMap((project) => project.allowed_paths ?? []);
}

function metadataEligibleThreads(
  summaries: ThreadSummary[],
  config: PluginConfig,
) {
  const excludedSessionIds = new Set(config.excludedSessionIds ?? []);
  const currentSessionId = process.env.CODEX_THREAD_ID;
  return summaries.filter(
    (summary) =>
      summary.id !== currentSessionId &&
      !summary.archived &&
      !excludedSessionIds.has(summary.id) &&
      !pathIsExcluded(summary.cwd, config.excludedPaths ?? []) &&
      !isPluginSystemThread(summary as unknown as Record<string, unknown>),
  );
}

async function listCollectionThreadMetadata(
  config: PluginConfig,
  updatedSince: string,
) {
  const server = new CodexAppServer();
  try {
    await server.connect();
    const summaries = (await server.listThreads({ updatedSince }))
      .map(summaryFromThread)
      .filter((value): value is ThreadSummary => Boolean(value));
    return {
      summaries,
      metadataEligible: metadataEligibleThreads(summaries, config),
    };
  } finally {
    server.close();
  }
}

function projectScopeApprovalRequired(
  periodKey: string,
  localScope: LocalProjectScope,
) {
  return {
    status: "project_scope_approval_required",
    periodKey,
    policyVersion: localScope.version,
    pendingProjects: localScope.entries.filter(
      (entry) => entry.status === "pending",
    ).length,
    read: 0,
    uploaded: 0,
    message:
      "项目范围卡已发送，项目采集范围尚未审批，未读取任何 Session 内容。请在飞书卡片中完成审批。",
  };
}

function projectScopeCardWaitCommand(input: {
  periodKey: string;
  version: number;
  deadlineAt: number;
  attempt: number;
}) {
  return [
    "project-scope-card-wait",
    `--period-key ${Buffer.from(input.periodKey, "utf8").toString("base64url")}`,
    `--version ${input.version}`,
    `--deadline ${Math.trunc(input.deadlineAt)}`,
    `--attempt ${Math.max(0, Math.trunc(input.attempt))}`,
    ...(flag("force") ? ["--force"] : []),
  ].join(" ");
}

function projectScopeCardDeliveryPending(input: {
  periodKey: string;
  version: number;
  deadlineAt?: number;
  attempt?: number;
  lastErrorCode?: string | null;
}) {
  const deadlineAt = input.deadlineAt ?? Date.now() + POLL_TOTAL_MS;
  const attempt = input.attempt ?? 0;
  return {
    status: "project_scope_card_delivery_pending",
    waiting: true,
    periodKey: input.periodKey,
    policyVersion: input.version,
    read: 0,
    uploaded: 0,
    ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
    nextCommand: projectScopeCardWaitCommand({
      periodKey: input.periodKey,
      version: input.version,
      deadlineAt,
      attempt,
    }),
    message: "项目范围卡已幂等登记，当前任务正在等待飞书确认投递成功。",
  };
}

async function projectScopePendingStatus(
  periodKey: string,
  localScope: LocalProjectScope,
  remind = false,
) {
  const pendingProjects = localScope.entries.filter(
    (entry) => entry.status === "pending",
  ).length;
  if (pendingProjects === 0)
    return {
      status: "project_scope_no_candidates" as const,
      waiting: false,
      periodKey,
      policyVersion: localScope.version,
      discovered: 0,
      read: 0,
      uploaded: 0,
      message:
        "过滤临时环境后没有需要审批的项目，本次未读取或上传 Session；后续周期会重新发现。",
    };
  if (remind) {
    await authenticatedRequest("/v1/project-scope/remind", {
      method: "POST",
      body: JSON.stringify({ periodKey }),
    });
  }
  const cardStatus = await fetchProjectScopeCardStatus(
    periodKey,
    localScope.version,
  ).catch((error) => ({
    status: "pending" as const,
    policyVersion: localScope.version,
    retryAfterSeconds: 3,
    lastErrorCode:
      error instanceof HttpError
        ? error.code
        : "PROJECT_SCOPE_CARD_STATUS_UNAVAILABLE",
  }));
  if (cardStatus.status !== "sent")
    return projectScopeCardDeliveryPending({
      periodKey,
      version: localScope.version,
      lastErrorCode:
        "lastErrorCode" in cardStatus ? cardStatus.lastErrorCode : null,
    });
  return projectScopeApprovalRequired(periodKey, localScope);
}

async function fetchProjectScopeCardStatus(
  periodKey: string,
  version: number,
  init: RequestInit = {},
) {
  const query = new URLSearchParams({
    periodKey,
    version: String(version),
  });
  return authenticatedRequest<ProjectScopeCardStatus>(
    `/v1/project-scope/card-status?${query.toString()}`,
    init,
  );
}

async function projectScopeCardWait() {
  const periodKey = decodeWaitPeriod(option("period-key"));
  const version = Number(option("version"));
  if (periodKey === "unknown" || !Number.isInteger(version) || version < 1)
    throw new Error("项目范围卡等待参数无效。");
  const rawDeadline = Number(option("deadline"));
  const deadlineAt = Number.isFinite(rawDeadline)
    ? Math.min(rawDeadline, Date.now() + POLL_TOTAL_MS)
    : Date.now() + POLL_TOTAL_MS;
  const rawAttempt = Number(option("attempt", "0"));
  const attempt =
    Number.isInteger(rawAttempt) && rawAttempt >= 0 ? rawAttempt : 0;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const flow = await waitForConditionAndContinue(
      {
        check: async () => {
          const requestTimeoutMs = Math.max(
            1,
            Math.min(15_000, deadlineAt - Date.now()),
          );
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(requestTimeoutMs),
          ]);
          return (
            (await fetchProjectScopeCardStatus(periodKey, version, { signal }))
              .status === "sent"
          );
        },
        deadlineAt,
        segmentDurationMs: POLL_SEGMENT_MS,
        attempt,
        signal: controller.signal,
        errorCode: (error) =>
          error instanceof HttpError
            ? error.code
            : "PROJECT_SCOPE_CARD_STATUS_UNAVAILABLE",
      },
      async () => {
        const remote = await fetchProjectScope();
        if (remote.initialized) return collectStart();
        const local = cacheRemoteProjectScope(remote);
        return output(projectScopeApprovalRequired(periodKey, local.scope));
      },
    );
    if (flow.continued) return flow.value;
    const result = flow.wait;
    if (result.status === "pending")
      return output(
        projectScopeCardDeliveryPending({
          periodKey,
          version,
          deadlineAt,
          attempt: result.attempt,
          lastErrorCode: result.lastErrorCode,
        }),
      );
    if (result.status === "cancelled")
      return output({
        status: "project_scope_card_wait_cancelled",
        waiting: false,
        read: 0,
        uploaded: 0,
        message: "已取消项目范围卡投递等待，未读取或上传 Session。",
      });
    return output({
      status: "project_scope_card_wait_timed_out",
      waiting: false,
      read: 0,
      uploaded: 0,
      ...(result.lastErrorCode ? { lastErrorCode: result.lastErrorCode } : {}),
      message:
        "当前执行环境的卡片投递等待时间已到，未读取或上传 Session；下次采集会继续检查。",
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
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
    !["1.0", "1.1", "1.2", "1.3"].includes(manifest.schemaVersion) ||
    manifest.pluginInstanceId !== config.pluginInstanceId
  ) {
    throw new Error("Run 清单无效或不属于当前 Plugin Instance。");
  }
  manifest.deadlineAt ??= collectionDeadline(manifest.createdAt);
  manifest.counts.skipped ??= 0;
  manifest.counts.deferred ??= 0;
  manifest.counts.notProcessed ??= 0;
  manifest.outcomes ??= [];
  manifest.claimedJobs ??=
    manifest.counts.uploaded +
    manifest.counts.ignored +
    manifest.counts.failedExtract +
    (manifest.current ? 1 : 0);
  if (manifest.current) manifest.current.failures ??= [];
  manifest.projectDescriptionScan ??= {
    initialized: false,
    queue: [],
    cursor: 0,
    current: null,
    generated: 0,
    unchanged: 0,
    failed: 0,
  };
  refreshCollectionLease(manifest.pluginInstanceId, manifest.runId);
  return { absolute, manifest };
}

function saveRun(runPath: string, manifest: RunManifest) {
  writeFileSync(runPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(runPath, 0o600);
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
  const checkpointEligible =
    phase === "completed"
      ? completionReview(manifest).checkpointEligible
      : canAdvanceCollectionCheckpoint(counts);
  const lastSyncAt = counts.uploaded > 0 ? new Date().toISOString() : undefined;
  const coverage = {
    discovered: counts.discovered,
    eligible: counts.eligible,
    readable: counts.read,
    extracted: counts.uploaded + counts.unchanged,
    deferred: counts.deferred,
    skipped: counts.skipped,
    notProcessed: counts.notProcessed,
    failedRead: counts.failedRead,
    failedExtract: counts.failedExtract,
    excluded: counts.excluded + counts.ignored + counts.cachedIgnored,
    pendingSync: phase === "completed" ? 0 : manifest.queue.length,
    activeAtCutoff: 0,
    hookMissed: 0,
    warnings: checkpointEligible ? [] : ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
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
      deferredCount: counts.deferred,
      excludedCount: counts.excluded + counts.ignored + counts.cachedIgnored,
      lastScanAt: manifest.createdAt,
      ...(lastSyncAt ? { lastSyncAt } : {}),
      coverage,
    }),
  });
}

async function collectStart() {
  const config = loadConfig()!;
  const localInspection = inspectLocalProjectScope(config.pluginInstanceId);
  const [policy, fetchedRemoteScope] = await Promise.all([
    fetchPolicy(),
    fetchProjectScope(),
  ]);
  if (!policy.currentPeriod)
    throw Object.assign(new Error("当前 Team 没有开放的 Report Period。"), {
      code: "REPORT_PERIOD_MISSING",
    });
  const synchronizedScope = await synchronizeLocalProjectScope(
    fetchedRemoteScope,
    localInspection,
  );
  const remoteScope = synchronizedScope.remote;
  let localScope: LocalProjectScope = synchronizedScope.scope;

  if (
    !remoteScope.initialized &&
    localScope.entries.some((entry) => entry.status === "pending")
  ) {
    return output(
      await projectScopePendingStatus(
        policy.currentPeriod.period_key,
        localScope,
        true,
      ),
    );
  }
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
  let summaries: ThreadSummary[];
  let metadataEligible: ThreadSummary[];
  try {
    // Collection may need the full report period for an approved-scope backfill.
    // Project discovery applies its separate seven-day window below.
    ({ summaries, metadataEligible } = await listCollectionThreadMetadata(
      config,
      policy.currentPeriod.starts_at,
    ));
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  const inWindow = flag("force")
    ? metadataEligible
    : metadataEligible.filter((summary) =>
        threadIsInScanWindow(
          summary.updatedAt,
          window.scanStartsAt,
          window.scanEndsAt,
        ),
      );
  const configuredRoots = configuredProjectRoots(policy.projects);
  if (!localScope.initialized) {
    const initialProjectScopeStart = initialProjectScopeStartAt(runStartedAt);
    const permissionDiscoverySummaries = metadataEligible.filter((summary) =>
      threadIsInKnownScanWindow(
        summary.updatedAt,
        initialProjectScopeStart,
        runStartedAt,
      ),
    );
    const discovery = discoverProjectScopes(
      config.pluginInstanceId,
      localScope,
      permissionDiscoverySummaries,
      { configuredRoots },
    );
    try {
      const registeredScope =
        await authenticatedRequest<RemoteProjectScopePolicy>(
          "/v1/project-scope/candidates",
          {
            method: "POST",
            body: JSON.stringify({
              periodKey: policy.currentPeriod.period_key,
              initialDiscovery: true,
              candidates: discovery.candidates.map((candidate) => ({
                scopeKey: candidate.scopeKey,
                displayName: candidate.displayName,
                sessionCount: candidate.sessionCount,
              })),
            }),
          },
        );
      localScope = mergeDiscoveredRoots(
        mergeRemoteProjectScope(localScope, registeredScope),
        discovery.candidates,
      );
      saveLocalProjectScope(localScope);
    } catch (error) {
      releaseCollectionLease(config.pluginInstanceId, runId);
      throw error;
    }
    releaseCollectionLease(config.pluginInstanceId, runId);
    return output(
      await projectScopePendingStatus(
        policy.currentPeriod.period_key,
        localScope,
      ),
    );
  }
  const allThreadDiscovery = discoverProjectScopes(
    config.pluginInstanceId,
    localScope,
    metadataEligible,
    { configuredRoots },
  );
  const existingScopeKeys = new Set(
    localScope.entries.map((entry) => entry.scopeKey),
  );
  const existingCandidates = allThreadDiscovery.candidates.filter((candidate) =>
    existingScopeKeys.has(candidate.scopeKey),
  );
  if (existingCandidates.length > 0) {
    const registeredScope =
      await authenticatedRequest<RemoteProjectScopePolicy>(
        "/v1/project-scope/candidates",
        {
          method: "POST",
          body: JSON.stringify({
            periodKey: policy.currentPeriod.period_key,
            initialDiscovery: false,
            candidates: existingCandidates.map((candidate) => ({
              scopeKey: candidate.scopeKey,
              displayName: candidate.displayName,
              sessionCount: candidate.sessionCount,
            })),
          }),
        },
      );
    localScope = mergeDiscoveredRoots(
      mergeRemoteProjectScope(localScope, registeredScope),
      existingCandidates,
    );
    saveLocalProjectScope(localScope);
  }
  const regularQueue: ScopedThreadSummary[] = authorizedProjectThreads(
    inWindow,
    allThreadDiscovery.threadScopes,
    localScope.entries,
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
  const fullPeriodSummaries = metadataEligible.filter((summary) =>
    threadIsInKnownScanWindow(
      summary.updatedAt,
      policy.currentPeriod!.starts_at,
      runStartedAt,
    ),
  );
  const scopeBackfillKeys = new Set(
    localScope.entries
      .filter((entry) =>
        scopeNeedsCurrentPeriodBackfill(
          entry,
          localScope.initializedAt,
          policy.currentPeriod!.period_key,
        ),
      )
      .map((entry) => entry.scopeKey),
  );
  const fullPeriodQueue = authorizedProjectThreads(
    fullPeriodSummaries,
    allThreadDiscovery.threadScopes,
    localScope.entries,
  )
    .filter((summary) => scopeBackfillKeys.has(summary.scopeKey))
    .map((summary) => ({
      ...summary,
      collectionStartsAt: policy.currentPeriod!.starts_at,
    }));
  const queue = [...regularQueue];
  const queuedIds = new Set(queue.map((summary) => summary.id));
  for (const summary of fullPeriodQueue) {
    if (queuedIds.has(summary.id)) continue;
    queue.push(summary);
    queuedIds.add(summary.id);
  }
  const inWindowIds = new Set(inWindow.map((summary) => summary.id));
  const queuedOutsideWindow = queue.filter(
    (summary) => !inWindowIds.has(summary.id),
  ).length;
  const queuedInsideWindow = queue.filter((summary) =>
    inWindowIds.has(summary.id),
  ).length;
  const manifest: RunManifest = {
    schemaVersion: "1.3",
    runId,
    pluginInstanceId: config.pluginInstanceId,
    createdAt: runStartedAt,
    deadlineAt: collectionDeadline(runStartedAt),
    force: flag("force"),
    period: effectivePeriod,
    reportPeriodStartsAt: policy.currentPeriod.starts_at,
    reportPeriodEndsAt: policy.currentPeriod.ends_at,
    scanStartsAt: window.scanStartsAt,
    scanEndsAt: window.scanEndsAt,
    initialThreadIds: summaries.map((summary) => summary.id),
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
      outsideWindow:
        metadataEligible.length - inWindow.length - queuedOutsideWindow,
      excluded:
        summaries.length -
        metadataEligible.length +
        (inWindow.length - queuedInsideWindow),
      failedRead: 0,
      failedExtract: 0,
      skipped: 0,
      deferred: 0,
      notProcessed: 0,
    },
    current: null,
    claimedJobs: 0,
    outcomes: [],
    approvalWait: null,
    endOfRunScopeScan: {
      completed: false,
      cardPolicyVersion: null,
      cardDeliveryDeadlineAt: null,
      cardDeliveryAttempt: 0,
    },
    projectDescriptionScan: {
      initialized: false,
      queue: [],
      cursor: 0,
      current: null,
      generated: 0,
      unchanged: 0,
      failed: 0,
    },
    scopeBackfillKeys: [...scopeBackfillKeys],
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
    validationFailures: current.failures.length,
    validationAttemptsRemaining: Math.max(
      0,
      MAX_EXTRACTION_FAILURES - current.failures.length,
    ),
    nextCommand: `collect-submit --run ${runPath} --result ${current.resultPath}`,
  });
}

function recordJobOutcome(
  manifest: RunManifest,
  current: CurrentJob,
  outcome: Omit<JobOutcome, "jobId" | "failureCount" | "failureCodes">,
) {
  manifest.outcomes.push({
    jobId: current.jobId,
    failureCount: current.failures.length,
    failureCodes: current.failures.map((failure) => failure.code),
    ...outcome,
  });
  manifest.counts[outcome.status] += 1;
  manifest.current = null;
}

function deferRun(
  runPath: string,
  manifest: RunManifest,
  reason: RunManifest["stopReason"],
) {
  if (!reason) throw new Error("延后处理必须提供安全原因码。");
  if (manifest.current)
    recordJobOutcome(manifest, manifest.current, {
      status: "deferred",
      errorCode: reason,
    });
  manifest.stopReason = reason;
  manifest.counts.notProcessed = Math.max(
    0,
    manifest.queue.length - manifest.cursor,
  );
  saveRun(runPath, manifest);
  output({
    status: "deferred",
    reason,
    deferred: manifest.counts.deferred,
    notProcessed: manifest.counts.notProcessed,
    checkpointAdvanced: false,
    warnings: ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
    nextCommand: `collect-review --run ${runPath}`,
  });
}

async function finishRun(
  runPath: string,
  manifest: RunManifest,
  config: PluginConfig,
) {
  const review = completionReview(manifest);
  await postCollectionStatus(config, manifest, "completed");
  const checkpointAdvanced = review.checkpointEligible;
  if (checkpointAdvanced) {
    const state = loadCollectionState(manifest.pluginInstanceId);
    state.lastSuccessfulRunStartedAt = manifest.createdAt;
    saveCollectionState(state);
    const backfillKeys = new Set(manifest.scopeBackfillKeys ?? []);
    if (backfillKeys.size > 0) {
      const local = inspectLocalProjectScope(manifest.pluginInstanceId);
      if (local.state === "valid") {
        local.scope.entries = local.scope.entries.map((entry) =>
          backfillKeys.has(entry.scopeKey)
            ? {
                ...entry,
                backfilledPeriodKey: manifest.period.period_key,
              }
            : entry,
        );
        saveLocalProjectScope(local.scope);
      }
    }
  }
  const summary = {
    status: "completed",
    reviewed: true,
    periodKey: manifest.period.period_key,
    collectionStartsAt: manifest.period.starts_at,
    collectionEndsAt: manifest.period.ends_at,
    checkpointAdvanced,
    warnings: [
      ...(checkpointAdvanced ? [] : ["PARTIAL_COLLECTION_RETRY_REQUIRED"]),
      ...((manifest.projectDescriptionScan?.failed ?? 0) > 0
        ? ["PROJECT_DESCRIPTION_RETRY_REQUIRED"]
        : []),
    ],
    projectDescriptions: {
      generated: manifest.projectDescriptionScan?.generated ?? 0,
      unchanged: manifest.projectDescriptionScan?.unchanged ?? 0,
      failed: manifest.projectDescriptionScan?.failed ?? 0,
    },
    ...manifest.counts,
  };
  releaseCollectionLease(manifest.pluginInstanceId, manifest.runId);
  rmSync(dirname(runPath), { recursive: true, force: true });
  output(summary);
}

function completionReview(manifest: RunManifest) {
  const outcomeCounts = countJobOutcomes(manifest.outcomes);
  return reviewCollectionCompletion({
    cursor: manifest.cursor,
    queueLength: manifest.queue.length,
    hasCurrentJob: manifest.current !== null,
    claimedJobs: manifest.claimedJobs,
    terminalJobs: manifest.outcomes.length,
    uniqueTerminalJobs:
      new Set(manifest.outcomes.map((outcome) => outcome.jobId)).size ===
      manifest.outcomes.length,
    validFailureAudits: manifest.outcomes.every(jobOutcomeFailureAuditIsValid),
    unexplainedFailedExtract: manifest.outcomes.filter(
      (outcome) => !failedExtractOutcomeIsExplained(outcome),
    ).length,
    outcomeCountsMatch: Object.entries(outcomeCounts).every(
      ([key, count]) =>
        manifest.counts[key as keyof typeof outcomeCounts] === count,
    ),
    stopped: manifest.stopReason !== undefined,
    counts: manifest.counts,
  });
}

function projectDescriptionJobOutput(
  runPath: string,
  current: ProjectDescriptionCurrent,
) {
  output({
    status: "project_description_job",
    runPath,
    jobId:
      current.jobId ?? basename(current.inputPath).replace(/-input\.json$/, ""),
    projectName: current.projectName,
    inputPath: current.inputPath,
    resultPath: current.resultPath,
    resultSchema: resolve(
      import.meta.dirname,
      "../schemas/project-description-result-v1.json",
    ),
    nextCommand: `project-description-submit --run ${runPath} --result ${current.resultPath}`,
  });
}

async function initializeProjectDescriptionScan(
  runPath: string,
  manifest: RunManifest,
) {
  const scan = manifest.projectDescriptionScan!;
  if (scan.initialized) return;
  const local = inspectLocalProjectScope(manifest.pluginInstanceId);
  if (local.state !== "valid") {
    scan.initialized = true;
    saveRun(runPath, manifest);
    return;
  }
  const sources = local.scope.entries.flatMap((entry) => {
    if (!scopeIsActive(entry) || !entry.localRoot) return [];
    const project = mappedProject(entry.localRoot, manifest.projects);
    const source = buildProjectDescriptionSource({
      projectName: entry.displayName,
      localRoot: entry.localRoot,
      rootFingerprint: project.rootFingerprint,
    });
    return source ? [{ ...source, scopeKey: entry.scopeKey }] : [];
  });
  let remote: {
    projects: Array<{
      scopeKey: string;
      sourceFingerprint: string | null;
      pendingSourceFingerprint: string | null;
    }>;
  };
  try {
    remote = await authenticatedRequest("/v1/project-descriptions/state", {
      method: "POST",
      body: JSON.stringify({
        projects: sources.map((source) => ({
          scopeKey: source.scopeKey,
          rootFingerprint: source.rootFingerprint,
          sourceFingerprint: source.sourceFingerprint,
        })),
      }),
    });
  } catch {
    scan.failed += sources.length;
    scan.initialized = true;
    saveRun(runPath, manifest);
    return;
  }
  const states = new Map(remote.projects.map((item) => [item.scopeKey, item]));
  scan.queue = sources.filter((source) => {
    const state = states.get(source.scopeKey);
    const unchanged =
      state?.sourceFingerprint === source.sourceFingerprint ||
      state?.pendingSourceFingerprint === source.sourceFingerprint;
    if (unchanged) scan.unchanged += 1;
    return !unchanged;
  });
  scan.cursor = 0;
  scan.initialized = true;
  saveRun(runPath, manifest);
}

async function continueProjectDescriptionScan(
  runPath: string,
  manifest: RunManifest,
): Promise<boolean> {
  const scan = manifest.projectDescriptionScan!;
  await initializeProjectDescriptionScan(runPath, manifest);
  if (scan.current) {
    projectDescriptionJobOutput(runPath, scan.current);
    return true;
  }
  const next = scan.queue[scan.cursor++];
  if (!next) return false;
  const jobId = `project-description-${randomUUID()}`;
  const paths = writeJob(runPath, jobId, next.modelInput);
  scan.current = { ...next, jobId, ...paths, failures: 0 };
  saveRun(runPath, manifest);
  projectDescriptionJobOutput(runPath, scan.current);
  return true;
}

async function submitProjectDescription() {
  const runPath = option("run");
  const resultPath = option("result");
  if (!runPath || !resultPath)
    throw new Error("project-description-submit 需要 --run 和 --result。");
  const { absolute, manifest } = readRun(runPath);
  const scan = manifest.projectDescriptionScan!;
  const current = scan.current;
  if (!current) throw new Error("当前没有待提交的项目描述 Job。");
  if (resolve(resultPath) !== resolve(current.resultPath))
    throw new Error("项目描述结果路径与当前 Job 不匹配。");
  try {
    const raw = JSON.parse(readFileSync(current.resultPath, "utf8"));
    const result = projectDescriptionResultSchema.parse(raw);
    if (!projectDescriptionIsChinese(result.description))
      throw new Error("PROJECT_DESCRIPTION_CHINESE_REQUIRED");
    if (containsSensitive(result.description))
      throw new Error("PROJECT_DESCRIPTION_SENSITIVE");
    await authenticatedRequest("/v1/project-descriptions/candidates", {
      method: "POST",
      headers: {
        "idempotency-key": `${current.scopeKey}:${current.sourceFingerprint}`,
      },
      body: JSON.stringify({
        scopeKey: current.scopeKey,
        rootFingerprint: current.rootFingerprint,
        sourceFingerprint: current.sourceFingerprint,
        description: result.description.trim(),
      }),
    });
    scan.generated += 1;
    scan.current = null;
    saveRun(absolute, manifest);
    output({
      status: "project_description_uploaded",
      runPath: absolute,
      generated: scan.generated,
      nextCommand: `collect-next --run ${absolute}`,
    });
  } catch (error) {
    current.failures += 1;
    if (current.failures >= 3) {
      scan.failed += 1;
      scan.current = null;
      saveRun(absolute, manifest);
      return output({
        status: "project_description_skipped",
        runPath: absolute,
        reason:
          error instanceof Error
            ? error.message.slice(0, 120)
            : "INVALID_RESULT",
        nextCommand: `collect-next --run ${absolute}`,
      });
    }
    saveRun(absolute, manifest);
    output({
      status: "project_description_validation_failed",
      runPath: absolute,
      remainingAttempts: 3 - current.failures,
      nextCommand: `project-description-submit --run ${absolute} --result ${current.resultPath}`,
    });
  }
}

async function continueScopeApprovalWait(
  runPath: string,
  manifest: RunManifest,
): Promise<boolean> {
  const wait = manifest.approvalWait;
  if (!wait || wait.scopeKeys.length === 0) return false;

  const applyRemote = async () => {
    const remote = await fetchProjectScope();
    const inspection = inspectLocalProjectScope(manifest.pluginInstanceId);
    if (inspection.state !== "valid")
      throw Object.assign(
        new Error("采集过程中本地项目权限文件失效，已停止读取。"),
        { code: "PROJECT_SCOPE_LOCAL_INVALID" },
      );
    const local = mergeRemoteProjectScope(inspection.scope, remote);
    saveLocalProjectScope(local);
    const { approvedKeys, pendingKeys, deniedKeys } =
      resolveProjectScopeApprovals(
        wait.scopeKeys,
        local.entries,
        wait.deadlineAt,
      );

    let appended = 0;
    const queuedIds = new Set(manifest.queue.map((summary) => summary.id));
    for (const summary of wait.deferredQueue) {
      if (!approvedKeys.has(summary.scopeKey) || queuedIds.has(summary.id))
        continue;
      manifest.queue.push(summary);
      queuedIds.add(summary.id);
      appended += 1;
      if (
        summary.initialCountBucket === "excluded" ||
        summary.countedAsExcluded === true
      )
        manifest.counts.excluded = Math.max(0, manifest.counts.excluded - 1);
      else if (
        summary.initialCountBucket === "outsideWindow" ||
        summary.countedAsExcluded === false
      )
        manifest.counts.outsideWindow = Math.max(
          0,
          manifest.counts.outsideWindow - 1,
        );
    }
    if (approvedKeys.size > 0) {
      const backfillKeys = new Set(manifest.scopeBackfillKeys ?? []);
      for (const scopeKey of approvedKeys) backfillKeys.add(scopeKey);
      manifest.scopeBackfillKeys = [...backfillKeys];
      manifest.deadlineAt = collectionDeadline(new Date().toISOString());
      manifest.projectDescriptionScan = {
        initialized: false,
        queue: [],
        cursor: 0,
        current: null,
        generated: manifest.projectDescriptionScan?.generated ?? 0,
        unchanged: manifest.projectDescriptionScan?.unchanged ?? 0,
        failed: manifest.projectDescriptionScan?.failed ?? 0,
      };
    }
    const remainingKeys = deniedKeys.size > 0 ? [] : pendingKeys;
    wait.scopeKeys = remainingKeys;
    wait.deferredQueue = wait.deferredQueue.filter((summary) =>
      remainingKeys.includes(summary.scopeKey),
    );
    return {
      appended,
      pending: remainingKeys.length,
      denied: deniedKeys.size,
    };
  };

  const first = await applyRemote();
  if (first.appended > 0) {
    saveRun(runPath, manifest);
    output({
      status: "project_scope_approved",
      runPath,
      appended: first.appended,
      pendingProjects: first.pending,
      deniedProjects: first.denied,
      nextCommand: `collect-next --run ${runPath}`,
    });
    return true;
  }
  if (first.pending === 0 || Date.now() >= wait.deadlineAt) {
    manifest.approvalWait = null;
    saveRun(runPath, manifest);
    return false;
  }

  const result = await waitForCondition({
    check: async () => {
      const remote = await fetchProjectScope();
      const entries = new Map(
        remote.entries.map((entry) => [entry.scopeKey, entry]),
      );
      return wait.scopeKeys.some(
        (scopeKey) => entries.get(scopeKey)?.status !== "pending",
      );
    },
    deadlineAt: wait.deadlineAt,
    segmentDurationMs: POLL_SEGMENT_MS,
    attempt: wait.attempt,
    errorCode: (error) =>
      error instanceof HttpError
        ? error.code
        : "PROJECT_SCOPE_APPROVAL_STATUS_UNAVAILABLE",
  });
  wait.attempt = result.attempt;
  if (result.status === "confirmed")
    return continueScopeApprovalWait(runPath, manifest);
  if (result.status === "timed_out") {
    manifest.approvalWait = null;
    saveRun(runPath, manifest);
    return false;
  }
  saveRun(runPath, manifest);
  output({
    status: "project_scope_approval_waiting",
    runPath,
    pendingProjects: wait.scopeKeys.length,
    ...("lastErrorCode" in result && result.lastErrorCode
      ? { lastErrorCode: result.lastErrorCode }
      : {}),
    nextCommand: `collect-next --run ${runPath}`,
  });
  return true;
}

async function startEndOfRunScopeScan(
  runPath: string,
  manifest: RunManifest,
): Promise<boolean> {
  const scan = manifest.endOfRunScopeScan;
  if (!scan || scan.completed) return false;

  const config = loadConfig()!;
  const scanStartedAt = new Date().toISOString();
  const scanStartsAt = initialProjectScopeStartAt(scanStartedAt);
  const { summaries, metadataEligible } = await listCollectionThreadMetadata(
    config,
    scanStartsAt,
  );
  manifest.counts.discovered = Math.max(
    manifest.counts.discovered,
    summaries.length,
  );
  const inspection = inspectLocalProjectScope(manifest.pluginInstanceId);
  if (inspection.state !== "valid")
    throw Object.assign(
      new Error("末尾项目扫描时本地项目权限文件失效，已停止读取。"),
      { code: "PROJECT_SCOPE_LOCAL_INVALID" },
    );
  const localScope = inspection.scope;
  const scanCompletedAt = new Date().toISOString();
  const discoverySummaries = metadataEligible.filter((summary) =>
    threadIsInKnownScanWindow(summary.updatedAt, scanStartsAt, scanCompletedAt),
  );
  const discovery = discoverProjectScopes(
    manifest.pluginInstanceId,
    localScope,
    discoverySummaries,
    { configuredRoots: configuredProjectRoots(manifest.projects) },
  );
  const knownScopeKeys = new Set(
    localScope.entries.map((entry) => entry.scopeKey),
  );
  const registeredScope = await authenticatedRequest<RemoteProjectScopePolicy>(
    "/v1/project-scope/candidates",
    {
      method: "POST",
      body: JSON.stringify({
        periodKey: manifest.period.period_key,
        initialDiscovery: false,
        candidates: discovery.candidates.map((candidate) => ({
          scopeKey: candidate.scopeKey,
          displayName: candidate.displayName,
          sessionCount: candidate.sessionCount,
        })),
      }),
    },
  );
  const mergedScope = mergeDiscoveredRoots(
    mergeRemoteProjectScope(localScope, registeredScope),
    discovery.candidates,
  );
  saveLocalProjectScope(mergedScope);
  const pendingScopeKeys = newlyPendingProjectScopeKeys(
    knownScopeKeys,
    mergedScope.entries,
  );
  if (pendingScopeKeys.size === 0) {
    scan.completed = true;
    saveRun(runPath, manifest);
    return false;
  }

  const allThreadDiscovery = discoverProjectScopes(
    manifest.pluginInstanceId,
    mergedScope,
    metadataEligible,
    { configuredRoots: configuredProjectRoots(manifest.projects) },
  );
  const inOriginalWindow = new Set(
    metadataEligible
      .filter(
        (summary) =>
          manifest.force ||
          threadIsInScanWindow(
            summary.updatedAt,
            manifest.scanStartsAt ?? manifest.period.starts_at,
            manifest.scanEndsAt ?? manifest.createdAt,
          ),
      )
      .map((summary) => summary.id),
  );
  const initialThreadIds = new Set(manifest.initialThreadIds ?? []);
  const reportPeriodStartsAt =
    manifest.reportPeriodStartsAt ?? manifest.period.starts_at;
  const collectionEndsAt = new Date(
    Math.min(
      new Date(manifest.reportPeriodEndsAt ?? scanCompletedAt).getTime(),
      new Date(scanCompletedAt).getTime(),
    ),
  ).toISOString();
  const fullPeriodSummaries = metadataEligible.filter((summary) =>
    threadIsInKnownScanWindow(
      summary.updatedAt,
      reportPeriodStartsAt,
      scanCompletedAt,
    ),
  );
  const deferredQueue = fullPeriodSummaries.flatMap(
    (summary): ScopedThreadSummary[] => {
      const scopeKey = allThreadDiscovery.threadScopes.get(summary.id);
      if (!scopeKey || !pendingScopeKeys.has(scopeKey)) return [];
      return [
        {
          ...summary,
          scopeKey,
          collectionStartsAt: reportPeriodStartsAt,
          collectionEndsAt,
          ...(initialThreadIds.has(summary.id)
            ? {
                initialCountBucket: inOriginalWindow.has(summary.id)
                  ? ("excluded" as const)
                  : ("outsideWindow" as const),
              }
            : {}),
        },
      ];
    },
  );
  manifest.approvalWait = {
    scopeKeys: [...pendingScopeKeys],
    deadlineAt: 0,
    attempt: 0,
    deferredQueue,
  };
  scan.completed = true;
  scan.cardPolicyVersion = registeredScope.version;
  scan.cardDeliveryDeadlineAt = Date.now() + POLL_TOTAL_MS;
  saveRun(runPath, manifest);
  return continueEndOfRunCardDeliveryWait(runPath, manifest);
}

async function continueEndOfRunCardDeliveryWait(
  runPath: string,
  manifest: RunManifest,
): Promise<boolean> {
  const scan = manifest.endOfRunScopeScan;
  const wait = manifest.approvalWait;
  if (!scan?.cardPolicyVersion || !scan.cardDeliveryDeadlineAt || !wait)
    return false;
  const result = await waitForCondition({
    check: async () =>
      (
        await fetchProjectScopeCardStatus(
          manifest.period.period_key,
          scan.cardPolicyVersion!,
        )
      ).status === "sent",
    deadlineAt: scan.cardDeliveryDeadlineAt,
    segmentDurationMs: POLL_SEGMENT_MS,
    attempt: scan.cardDeliveryAttempt,
    errorCode: (error) =>
      error instanceof HttpError
        ? error.code
        : "PROJECT_SCOPE_CARD_STATUS_UNAVAILABLE",
  });
  scan.cardDeliveryAttempt = result.attempt;
  if (result.status === "confirmed") {
    scan.cardPolicyVersion = null;
    scan.cardDeliveryDeadlineAt = null;
    wait.deadlineAt = projectScopeApprovalDeadline();
    saveRun(runPath, manifest);
    return continueScopeApprovalWait(runPath, manifest);
  }
  if (result.status === "timed_out") {
    manifest.approvalWait = null;
    scan.cardPolicyVersion = null;
    scan.cardDeliveryDeadlineAt = null;
    saveRun(runPath, manifest);
    return false;
  }
  saveRun(runPath, manifest);
  const lastErrorCode = "lastErrorCode" in result ? result.lastErrorCode : null;
  output({
    status: "project_scope_end_scan_card_waiting",
    runPath,
    pendingProjects: wait.scopeKeys.length,
    ...(lastErrorCode ? { lastErrorCode } : {}),
    nextCommand: `collect-next --run ${runPath}`,
  });
  return true;
}

async function collectNext() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-next 需要 --run <path>。");
  const { absolute, manifest } = readRun(runPath);
  if (manifest.stopReason)
    return deferRun(absolute, manifest, manifest.stopReason);
  if (
    (manifest.current || manifest.cursor < manifest.queue.length) &&
    shouldStopBeforeClaim(manifest.deadlineAt)
  )
    return deferRun(absolute, manifest, "TIME_BUDGET_EXHAUSTED");
  if (manifest.current) return currentJobOutput(absolute, manifest.current);
  const server = new CodexAppServer();
  try {
    await server.connect();
    while (manifest.cursor < manifest.queue.length) {
      if (shouldStopBeforeClaim(manifest.deadlineAt)) {
        deferRun(absolute, manifest, "TIME_BUDGET_EXHAUSTED");
        return;
      }
      const summary = manifest.queue[manifest.cursor++]!;
      const localScope = inspectLocalProjectScope(manifest.pluginInstanceId);
      if (
        localScope.state !== "valid" ||
        !threadMayBeRead(summary, localScope.scope, {
          configuredRoots: configuredProjectRoots(manifest.projects),
        })
      ) {
        manifest.counts.excluded += 1;
        manifest.counts.failedRead += 1;
        saveRun(absolute, manifest);
        continue;
      }
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
        scopeKey: summary.scopeKey,
        period:
          summary.collectionStartsAt || summary.collectionEndsAt
            ? {
                ...manifest.period,
                starts_at:
                  summary.collectionStartsAt ?? manifest.period.starts_at,
                ends_at: summary.collectionEndsAt ?? manifest.period.ends_at,
              }
            : manifest.period,
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
      manifest.current = {
        jobId,
        ...paths,
        expected: immutableContributionFromRequirements(
          job.modelInput.outputRequirements.include.contribution,
        ),
        failures: [],
      };
      manifest.claimedJobs += 1;
      saveRun(absolute, manifest);
      return currentJobOutput(absolute, manifest.current);
    }
  } finally {
    server.close();
  }
  if (await continueProjectDescriptionScan(absolute, manifest)) return;
  if (await startEndOfRunScopeScan(absolute, manifest)) return;
  if (await continueEndOfRunCardDeliveryWait(absolute, manifest)) return;
  if (await continueScopeApprovalWait(absolute, manifest)) return;
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
  const descriptionScan = manifest.projectDescriptionScan!;
  if (
    !descriptionScan.initialized ||
    descriptionScan.current ||
    descriptionScan.cursor < descriptionScan.queue.length
  ) {
    return output({
      status: "review_failed",
      runPath: absolute,
      reason: "PROJECT_DESCRIPTION_SCAN_INCOMPLETE",
      nextCommand: `collect-next --run ${absolute}`,
    });
  }
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

function extractionFailureOutput(
  runPath: string,
  manifest: RunManifest,
  current: CurrentJob,
  code: ExtractionFailureCode,
) {
  current.failures = appendExtractionFailure(current.failures, code);
  saveRun(runPath, manifest);
  const attempts = current.failures.length;
  const terminalSensitiveRejection = code === "SENSITIVE_EGRESS_REJECTED";
  const retriesExhausted = attempts >= MAX_EXTRACTION_FAILURES;
  output({
    status: "validation_failed",
    jobId: current.jobId,
    errorCode: code,
    attempts,
    attemptsRemaining: Math.max(0, MAX_EXTRACTION_FAILURES - attempts),
    nextCommand: terminalSensitiveRejection
      ? `collect-skip --run ${runPath} --job ${current.jobId} --error-code SENSITIVE_EGRESS_REJECTED`
      : retriesExhausted
        ? `collect-skip --run ${runPath} --job ${current.jobId} --error-code EXTRACT_FAILED --cause-code ${code}`
        : `collect-submit --run ${runPath} --result ${current.resultPath}`,
  });
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
  if (current.failures.length >= MAX_EXTRACTION_FAILURES)
    return output({
      status: "validation_failed",
      jobId: current.jobId,
      errorCode: current.failures.at(-1)!.code,
      attempts: current.failures.length,
      attemptsRemaining: 0,
      nextCommand: `collect-skip --run ${absolute} --job ${current.jobId} --error-code EXTRACT_FAILED --cause-code ${current.failures.at(-1)!.code}`,
    });
  let rawResult: unknown;
  try {
    rawResult = JSON.parse(readFileSync(current.resultPath, "utf8"));
  } catch {
    return extractionFailureOutput(
      absolute,
      manifest,
      current,
      "RESULT_JSON_INVALID",
    );
  }
  const repaired = repairImmutableResult(rawResult, current.expected);
  if (repaired.repaired)
    writeFileSync(
      current.resultPath,
      `${JSON.stringify(repaired.result, null, 2)}\n`,
      { mode: 0o600 },
    );
  const parsed = sessionExtractionResultSchema.safeParse(repaired.result);
  if (!parsed.success)
    return extractionFailureOutput(
      absolute,
      manifest,
      current,
      "SCHEMA_VALIDATION_FAILED",
    );
  const result = parsed.data as any;

  if (result.decision === "ignore") {
    const state = loadCollectionState(manifest.pluginInstanceId);
    recordIgnoredSession(
      state,
      current.expected.sessionKey,
      current.expected.contentHash,
    );
    saveCollectionState(state);
    manifest.knownSessions[current.expected.sessionKey] = {
      contentHashes: [current.expected.contentHash],
      decision: "ignored",
    };
    recordJobOutcome(manifest, current, { status: "ignored" });
    saveRun(absolute, manifest);
    return output({
      status: "ignored",
      reason: result.reason,
      nextCommand: `collect-next --run ${absolute}`,
    });
  }

  try {
    assertImmutableContribution(result.contribution, current.expected);
  } catch {
    return extractionFailureOutput(
      absolute,
      manifest,
      current,
      "IMMUTABLE_FIELD_MISMATCH",
    );
  }
  try {
    assertChineseContribution(result.contribution);
  } catch {
    return extractionFailureOutput(
      absolute,
      manifest,
      current,
      "CHINESE_OUTPUT_REQUIRED",
    );
  }
  if (containsSensitive(result.contribution)) {
    writeFileSync(
      current.resultPath,
      `${JSON.stringify({
        schemaVersion: "1.0",
        status: "rejected",
        errorCode: "SENSITIVE_EGRESS_REJECTED",
      })}\n`,
      { mode: 0o600 },
    );
    return extractionFailureOutput(
      absolute,
      manifest,
      current,
      "SENSITIVE_EGRESS_REJECTED",
    );
  }
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
  manifest.knownSessions[result.contribution.sessionKey] = {
    contentHashes: [result.contribution.contentHash],
    decision: "accepted",
  };
  recordJobOutcome(manifest, current, { status: "uploaded" });
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
  const errorCode = option("error-code");
  const causeCode = option("cause-code");
  recordJobOutcome(
    manifest,
    current,
    legalCollectSkipOutcome({
      currentJobId: current.jobId,
      requestedJobId: option("job"),
      errorCode,
      causeCode,
      failures: current.failures,
    }),
  );
  saveRun(absolute, manifest);
  output({
    status: "skipped",
    jobStatus: manifest.outcomes.at(-1)!.status,
    errorCode,
    ...(causeCode ? { causeCode } : {}),
    nextCommand: `collect-next --run ${absolute}`,
  });
}

function collectDefer() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-defer 需要 --run <path>。");
  const { absolute, manifest } = readRun(runPath);
  const reason = option("reason");
  if (
    ![
      "TIME_BUDGET_EXHAUSTED",
      "RUN_INTERRUPTED",
      "TEMPORARILY_UNAVAILABLE",
    ].includes(reason ?? "")
  )
    throw Object.assign(new Error("collect-defer 需要合法的安全原因码。"), {
      code: "DEFER_REASON_REQUIRED",
    });
  deferRun(absolute, manifest, reason as RunManifest["stopReason"]);
}

async function status() {
  const config = loadConfig(false);
  if (!config) return output({ status: "not_connected" });
  const [policy, remoteScope] = await Promise.all([
    fetchPolicy(),
    fetchProjectScope(),
  ]);
  const projectScope = cacheRemoteProjectScope(remoteScope);
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
    projectScopeLocalState: projectScope.state,
    projectScopeVersion: projectScope.scope.version,
    projectScopeInitialized:
      projectScope.state === "valid" && projectScope.scope.initialized,
    projectScopeRequiresApproval:
      projectScope.state !== "valid" || !projectScope.scope.initialized,
    allowedProjectCount:
      projectScope.state === "valid"
        ? projectScope.scope.entries.filter((entry) => scopeIsActive(entry))
            .length
        : 0,
    pendingProjectCount: projectScope.scope.entries.filter(
      (entry) => entry.status === "pending",
    ).length,
    deniedProjectCount: projectScope.scope.entries.filter(
      (entry) => entry.status === "denied",
    ).length,
  });
}

async function projectScopeList() {
  const remote = await fetchProjectScope();
  const local = cacheRemoteProjectScope(remote);
  output({
    status: "project_scope",
    localState: local.state,
    version: local.scope.version,
    initialized: local.scope.initialized,
    requiresApproval: local.state !== "valid" || !local.scope.initialized,
    projects: local.scope.entries.map((entry) => ({
      scopeKey: entry.scopeKey,
      name: entry.displayName,
      permission: entry.status,
      active: scopeIsActive(entry),
      effectiveFrom: entry.effectiveFrom,
      firstSeenPeriodKey: entry.firstSeenPeriodKey,
      sessionCount: entry.sessionCount,
    })),
  });
}

async function synchronizeProjectScopeCommand() {
  const remote = await fetchProjectScope();
  const synchronized = await synchronizeLocalProjectScope(remote);
  output({
    status: "project_scope_synced",
    version: synchronized.remote.version,
    changedCount: synchronized.changedCount,
    localState: synchronized.inspection.state,
  });
}

async function changeProjectScope(decision: "allow" | "deny") {
  const config = loadConfig()!;
  const localInspection = inspectLocalProjectScope(config.pluginInstanceId);
  if (localInspection.state !== "valid")
    throw Object.assign(
      new Error("本地采集权限尚未建立，请先运行采集并在飞书完成首次审批。"),
      { code: "PROJECT_SCOPE_APPROVAL_REQUIRED" },
    );
  const remote = await fetchProjectScope();
  const scopeKey = option("scope-key")?.trim();
  const projectName = option("project")?.trim().toLocaleLowerCase("zh-CN");
  let selected = remote.entries.filter((entry) => {
    if (flag("all-pending")) return entry.status === "pending";
    if (scopeKey) return entry.scopeKey === scopeKey;
    if (projectName)
      return entry.displayName.toLocaleLowerCase("zh-CN") === projectName;
    return false;
  });
  if (!scopeKey && !projectName && !flag("all-pending"))
    throw new Error(
      "需要 --project <项目名>、--scope-key <key> 或 --all-pending。",
    );
  if (projectName && selected.length > 1)
    throw new Error(
      "存在同名项目，请先 project-scope-list，再用 --scope-key 指定。",
    );
  if (selected.length === 0) throw new Error("没有找到匹配的项目权限。");
  selected = selected.slice(0, 500);
  const updated = await authenticatedRequest<RemoteProjectScopePolicy>(
    "/v1/project-scope",
    {
      method: "PATCH",
      body: JSON.stringify({
        baseVersion: remote.version,
        decisions: selected.map((entry) => ({
          scopeKey: entry.scopeKey,
          decision,
        })),
      }),
    },
  );
  saveLocalProjectScope(
    mergeRemoteProjectScope(localInspection.scope, updated),
  );
  output({
    status: "project_scope_updated",
    decision,
    version: updated.version,
    projects: selected.map((entry) => ({
      scopeKey: entry.scopeKey,
      name: entry.displayName,
    })),
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
      "server-url-set --server <url> [--allow-insecure-http]",
      "scheduled-task-config",
      "migrate-credentials",
      "collect-start [--force]",
      "project-scope-card-wait --period-key <base64url> --version <number> --deadline <epoch-ms> --attempt <number> [--force]",
      "collect-next --run <path>",
      "collect-review --run <path>",
      "collect-submit --run <path> --result <path>",
      "project-description-submit --run <path> --result <path>",
      "collect-skip --run <path> --job <job-id> --error-code <code> [--cause-code <code>]",
      "collect-defer --run <path> --reason <TIME_BUDGET_EXHAUSTED|RUN_INTERRUPTED|TEMPORARILY_UNAVAILABLE>",
      "status",
      "project-scope-list",
      "project-scope-sync",
      "project-scope-allow --project <name>|--scope-key <key>|--all-pending",
      "project-scope-deny --project <name>|--scope-key <key>|--all-pending",
      "exclude-session --session-id <id>",
      "include-session --session-id <id>",
      "exclude-path --path <absolute-path>",
      "include-path --path <absolute-path>",
    ],
  });
}

const command = process.argv[2] ?? "help";
const recoveryAwareCommands = new Set([
  "connectivity-test",
  "server-url-set",
  "collect-start",
  "project-scope-card-wait",
  "daily-collect",
  "collect-next",
  "collect-review",
  "collect-submit",
  "project-description-submit",
  "status",
  "project-scope-list",
  "project-scope-sync",
  "project-scope-allow",
  "project-scope-deny",
]);
const recoveryResumeCommands = new Set(
  [...recoveryAwareCommands].filter((value) => value !== "server-url-set"),
);

async function runCommand() {
  if (
    recoveryResumeCommands.has(command) &&
    (await resumeAuthRecovery()) === "waiting"
  )
    return;
  if (command === "connect") await connect();
  else if (command === "connectivity-test") await connectivityTest();
  else if (command === "server-url-set") await setServerUrl();
  else if (command === "scheduled-task-config") scheduledTaskConfig();
  else if (command === "migrate-credentials")
    output(migrateLegacyInstallation());
  else if (command === "collect-start" || command === "daily-collect")
    await collectStart();
  else if (command === "project-scope-card-wait") await projectScopeCardWait();
  else if (command === "collect-next") await collectNext();
  else if (command === "collect-review") await collectReview();
  else if (command === "collect-submit") await collectSubmit();
  else if (command === "project-description-submit")
    await submitProjectDescription();
  else if (command === "collect-skip") collectSkip();
  else if (command === "collect-defer") collectDefer();
  else if (command === "status") await status();
  else if (command === "project-scope-list") await projectScopeList();
  else if (command === "project-scope-sync")
    await synchronizeProjectScopeCommand();
  else if (command === "project-scope-allow") await changeProjectScope("allow");
  else if (command === "project-scope-deny") await changeProjectScope("deny");
  else if (command === "exclude-session") configureExclusion("session");
  else if (command === "include-session") configureExclusion("session", true);
  else if (command === "exclude-path") configureExclusion("path");
  else if (command === "include-path") configureExclusion("path", true);
  else help();
}

try {
  await runCommand();
} catch (error) {
  if (
    recoveryAwareCommands.has(command) &&
    error instanceof HttpError &&
    error.code === "REFRESH_TOKEN_INVALID"
  ) {
    try {
      await startAuthRecovery();
    } catch (recoveryError) {
      const recoveryCode =
        recoveryError instanceof HttpError
          ? recoveryError.code
          : "AUTH_RECOVERY_START_FAILED";
      process.stderr.write(
        `${JSON.stringify({
          status: "error",
          code: recoveryCode,
          message:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
        })}\n`,
      );
      process.exitCode = 1;
    }
  } else {
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
}
