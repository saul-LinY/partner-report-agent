import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  aggregationResultSchema,
  assertFactSemantics,
  assertReportSemantics,
  factBatchSchema,
  individualReportResultSchema,
  sessionFactUploadSchema,
} from "@partner-report/contracts";
import { z } from "zod";
import {
  PLUGIN_VERSION,
  dataDirectory,
  loadConfig,
  normalizeServerUrl,
  removeSecrets,
  saveConfig,
  saveSecret,
} from "./config.js";
import {
  activeCollectionRun,
  activitySummary,
  getState,
  listLocalJobs,
  openDatabase,
  pendingLocalCount,
  setState,
  type LocalJob,
  type LocalCollectionRun,
  type RemoteLease,
} from "./database.js";
import { localCoverage } from "./coverage.js";
import {
  classifyDiagnosticError,
  diagnosticMessage,
  flushDiagnostics,
  isTerminalExtractionError,
  queueDiagnostic,
  queueDiagnosticSafely,
  type DiagnosticErrorCode,
  type DiagnosticStage,
} from "./diagnostics.js";
import { authenticatedRequest, HttpError, publicRequest } from "./http.js";
import {
  containsSensitive,
  mappedProject,
  prepareSessionJobs,
} from "./scan.js";
import {
  beginCollectionCycle,
  collectionWorkDirectory,
  failCollectionCycle,
  finishCollectionCycle,
} from "./automation.js";
import {
  SCHEDULED_COLLECTION_TASK,
  SCHEDULED_CONTINUATION_TASK,
} from "./collection-config.js";
import { claimCollectionRun, collectionDrainState } from "./collection-run.js";

type Policy = {
  pluginInstanceId: string;
  partnerId: string;
  team: {
    minimum_plugin_version: string;
    evidence_excerpt_enabled: boolean;
  };
  projects: Array<{
    id: string;
    name: string;
    aliases: string[];
    allowed_paths: string[];
    external_ids: string[];
  }>;
  currentPeriod: {
    id: string;
    period_key: string;
    starts_at: string;
    ends_at: string;
  } | null;
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
  connectivityStatus: "pending";
};

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

function rememberCurrentSystemSession() {
  if (!process.env.CODEX_THREAD_ID) return;
  const db = openDatabase();
  try {
    const systemSessions = new Set<string>(
      JSON.parse(getState(db, "system_session_ids") ?? "[]"),
    );
    systemSessions.add(process.env.CODEX_THREAD_ID);
    setState(db, "system_session_ids", JSON.stringify([...systemSessions]));
  } finally {
    db.close();
  }
}

function scheduledTaskConfig() {
  output({
    status: "scheduled_task_config",
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    setupMode: "create_if_missing_or_repair_prompt_only",
  });
}

function continuationTaskConfig() {
  output({
    status: "continuation_task_config",
    scheduledTask: SCHEDULED_CONTINUATION_TASK,
    setupMode: "create_or_resume_until_run_completed",
  });
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

async function fetchPolicy(db = openDatabase()) {
  const policy = await authenticatedRequest<Policy>("/v1/plugin-bindings/me");
  if (
    policy.team.minimum_plugin_version &&
    compareVersions(PLUGIN_VERSION, policy.team.minimum_plugin_version) < 0
  ) {
    setState(db, "last_error_code", "PLUGIN_VERSION_BLOCKED");
    throw new Error(
      `Plugin v${PLUGIN_VERSION} 低于 Team 最低版本 v${policy.team.minimum_plugin_version}。`,
    );
  }
  setState(db, "last_policy", JSON.stringify(policy));
  return policy;
}

async function connect() {
  const requestedServerUrl =
    option("server") ?? process.env.PARTNER_REPORT_SERVER_URL;
  if (!requestedServerUrl) {
    throw new Error(
      "connect 需要 --server <url>，也可以设置 PARTNER_REPORT_SERVER_URL。",
    );
  }
  const serverUrl = normalizeServerUrl(
    requestedServerUrl,
    flag("allow-insecure-http"),
  );
  const deviceName = option("device-name", hostname())!;
  const bindingCode =
    option("binding-code") ?? process.env.PARTNER_REPORT_BINDING_CODE;
  if (!bindingCode) {
    throw new Error(
      "connect 需要 Admin 在数据中台生成的 --binding-code <code>。",
    );
  }
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
  const connectivity = await performConnectivityTest({
    challenge: tokens.challenge,
    challengeExpiresAt: tokens.challengeExpiresAt,
    capabilityVersion: tokens.capabilityVersion,
  });
  outputConnected(tokens.partnerId, deviceName, connectivity);
}

function outputConnected(
  partnerId: string | null,
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
    taskSetupMode: "create_if_missing",
    existingTaskPolicy: {
      preserve: [
        "schedule",
        "timezone",
        "model",
        "reasoningEffort",
        "notifications",
        "destination",
        "project",
      ],
      requiredPrompt: SCHEDULED_COLLECTION_TASK.prompt,
    },
    nextStep:
      "由 $partner-report-sync 在同名任务不存在时创建上面的默认 Codex Scheduled task；已有任务保留用户配置。",
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
      config = loadConfig()!;
      saveConfig({
        ...config,
        connectivityStatus: "pending",
        pendingConnectivityChallenge: {
          value: connectivity.challenge,
          expiresAt: connectivity.challengeExpiresAt,
        },
      });
    }
    if (connectivity.capabilityVersion !== "1.0")
      throw Object.assign(new Error("连接能力版本不受支持。"), {
        code: "VERSION_BLOCKED",
      });
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
    const db = openDatabase();
    try {
      setState(db, "connectivity_status", "verified");
      setState(
        db,
        "connectivity_verified_at",
        String(response.verifiedAt ?? new Date().toISOString()),
      );
      await flushDiagnostics(db).catch(() => undefined);
    } finally {
      db.close();
    }
    return response;
  } catch (error) {
    const classified = classifyDiagnosticError(error, "CONNECTIVITY_TIMEOUT");
    queueDiagnosticSafely(
      "connectivity",
      classified.code,
      true,
      classified.requestId,
    );
    config = loadConfig()!;
    saveConfig({ ...config, connectivityStatus: "failed" });
    const wrapped = Object.assign(
      new Error(
        `${diagnosticMessage(classified.code)} 绑定和凭证已保留；运行 connectivity-test 可直接重试。`,
      ),
      { code: classified.code },
    );
    throw wrapped;
  }
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
  const policy = await authenticatedRequest<{ partnerId: string }>(
    "/v1/plugin-bindings/me",
  );
  outputConnected(policy.partnerId, config.deviceName, connectivity);
}

async function prepare() {
  const config = loadConfig()!;
  const db = openDatabase();
  try {
    const policy = await fetchPolicy(db);
    const run = activeCollectionRun(db);
    if (!run) throw new Error("没有活动采集 Run，请先运行 daily-collect。");
    if (process.env.CODEX_THREAD_ID) {
      const systemSessions = new Set<string>(
        JSON.parse(getState(db, "system_session_ids") ?? "[]"),
      );
      systemSessions.add(process.env.CODEX_THREAD_ID);
      setState(db, "system_session_ids", JSON.stringify([...systemSessions]));
    }
    const stats = await prepareSessionJobs(db, config, policy, flag("force"), {
      id: run.id,
      windowStartsAt: run.window_starts_at,
      windowEndsAt: run.window_ends_at,
      initialLookback: Boolean(run.initial_lookback),
    });
    const projectSync = await syncProjectDiscoveries(db, policy);
    db.prepare(
      `update collection_runs set status = 'RUNNING', discovered_count = ?,
        eligible_count = ?, deferred_count = ?, excluded_count = ?, updated_at = ?
       where id = ?`,
    ).run(
      stats.discovered,
      stats.eligible,
      stats.deferred,
      stats.excluded,
      new Date().toISOString(),
      run.id,
    );
    await heartbeat(db);
    output({
      status: "prepared",
      stats,
      projectSync,
      pendingLocalJobs: pendingLocalCount(db),
      activeCollectionRun:
        db
          .prepare(
            "select id, period_key, status, window_starts_at, window_ends_at, invocation_deadline_at, continuation_count from collection_runs where status in ('STARTED', 'RUNNING', 'CONTINUATION_PENDING') order by created_at asc limit 1",
          )
          .get() ?? null,
      nextCommand: "next-local",
    });
  } finally {
    db.close();
  }
}

async function syncProjectDiscoveries(
  db: ReturnType<typeof openDatabase>,
  policy: Policy,
) {
  const inventory = db
    .prepare(
      `select session_id, cwd from session_inventory
       where cwd is not null and status != 'excluded'
       order by session_id`,
    )
    .all() as Array<{ session_id: string; cwd: string }>;
  const discoveries = inventory.flatMap((session) => {
    const project = mappedProject(session.cwd, policy.projects);
    return project.matchMethod === "path_discovered" && project.rootName
      ? [
          {
            sessionId: session.session_id,
            rootName: project.rootName,
            rootFingerprint: project.rootFingerprint,
          },
        ]
      : [];
  });
  let mapped = 0;
  const projectIds = new Set<string>();
  for (let index = 0; index < discoveries.length; index += 100) {
    const chunk = discoveries.slice(index, index + 100);
    const response = await authenticatedRequest<{
      submitted: number;
      mappings: Array<{
        sessionId: string;
        projectId: string;
        projectName: string;
      }>;
    }>("/v1/plugin-instances/me/project-discoveries", {
      method: "POST",
      body: JSON.stringify({ discoveries: chunk }),
    });
    mapped += response.mappings.length;
    for (const mapping of response.mappings) {
      projectIds.add(mapping.projectId);
      db.prepare(
        "update session_inventory set project_id = ?, updated_at = ? where session_id = ?",
      ).run(
        mapping.projectId,
        new Date().toISOString(),
        mapping.sessionId,
      );
    }
  }
  return {
    discoveredSessions: discoveries.length,
    mappedSessions: mapped,
    projectCount: projectIds.size,
  };
}

async function syncProjects() {
  const db = openDatabase();
  try {
    const policy = await fetchPolicy(db);
    output({
      status: "projects_synced",
      ...(await syncProjectDiscoveries(db, policy)),
    });
  } finally {
    db.close();
  }
}

function materialize(prefix: string, id: string, input: unknown) {
  const workDir = collectionWorkDirectory();
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const inputPath = resolve(workDir, `${prefix}-${id}-input.json`);
  const resultPath = resolve(workDir, `${prefix}-${id}-result.json`);
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(inputPath, 0o600);
  return { inputPath, resultPath };
}

function nextLocal() {
  const db = openDatabase();
  try {
    const job = db
      .prepare(
        "select * from local_jobs where status = 'PENDING' order by created_at asc limit 1",
      )
      .get() as unknown as LocalJob | undefined;
    if (!job) return output({ status: "empty" });
    const now = new Date().toISOString();
    db.prepare(
      "update local_jobs set status = 'IN_PROGRESS', attempts = attempts + 1, updated_at = ? where id = ? and status = 'PENDING'",
    ).run(now, job.id);
    db.prepare(
      "update session_activity set processing_state = 'EXTRACTING', updated_at = ? where session_id = ?",
    ).run(now, job.session_id);
    const paths = materialize("local", job.id, JSON.parse(job.input_json));
    output({
      status: "ready",
      kind: "EXTRACT_SESSION_FACTS",
      jobId: job.id,
      ...paths,
      schemaPath: resolve(
        process.env.PLUGIN_ROOT ?? resolve(import.meta.dirname, ".."),
        "schemas/session-fact-upload-v1.json",
      ),
    });
  } finally {
    db.close();
  }
}

function completeLocal() {
  const jobId = option("job-id");
  const resultPath = option("result");
  if (!jobId || !resultPath)
    throw new Error("complete-local 需要 --job-id 与 --result。");
  const expectedResultPath = resolve(
    collectionWorkDirectory(),
    `local-${jobId}-result.json`,
  );
  if (resolve(resultPath) !== expectedResultPath)
    throw new Error("complete-local 的结果路径与本地任务不一致。");
  const db = openDatabase();
  try {
    const job = db
      .prepare(
        "select * from local_jobs where id = ? and status = 'IN_PROGRESS'",
      )
      .get(jobId) as unknown as LocalJob | undefined;
    if (!job) throw new Error("本地任务不存在或状态不是 IN_PROGRESS。");
    try {
      const input = JSON.parse(job.input_json) as any;
      const raw = JSON.parse(readFileSync(resultPath, "utf8"));
      const result = sessionFactUploadSchema.parse(raw);
      for (const fact of result.facts) assertFactSemantics(fact);
      if (
        result.sessionId !== job.session_id ||
        result.project.id !== input.session.project.id ||
        result.project.matchMethod !== input.session.project.matchMethod ||
        result.project.rootFingerprint !==
          input.session.project.rootFingerprint ||
        result.project.rootName !== input.session.project.rootName ||
        result.sourceRevision !== job.source_revision ||
        result.sourceHash !== job.source_hash ||
        result.fromTurnId !== job.from_turn_id ||
        result.toTurnId !== job.to_turn_id ||
        result.observedAt !== input.session.observedAt ||
        result.sourceOccurredAt !== input.session.sourceOccurredAt ||
        result.status !== input.outputRequirements.status
      ) {
        throw new Error("提取结果的 Session 来源边界与本地任务不一致。");
      }
      const invalidFactBoundary = result.facts.some(
        (fact: {
          sessionId: string;
          sourceRevision: number;
          sourceHash: string;
          fromTurnId: string;
          toTurnId: string;
          factOrigin: string;
          production: unknown;
        }) =>
          fact.sessionId !== job.session_id ||
          fact.sourceRevision !== job.source_revision ||
          fact.sourceHash !== job.source_hash ||
          fact.fromTurnId !== job.from_turn_id ||
          fact.toTurnId !== job.to_turn_id ||
          fact.factOrigin !== input.outputRequirements.factOrigin ||
          !isDeepStrictEqual(
            fact.production,
            input.outputRequirements.production,
          ),
      );
      if (invalidFactBoundary)
        throw new Error("Fact 来源边界或生产元数据与本地任务不一致。");
      if (
        !input.extractionPolicy.evidenceExcerptEnabled &&
        result.facts.some((fact: { evidence: Array<{ excerpt?: string }> }) =>
          fact.evidence.some(
            (evidence: { excerpt?: string }) => evidence.excerpt !== undefined,
          ),
        )
      ) {
        throw new Error("Team 未启用 Evidence excerpt，但结果包含 excerpt。");
      }
      if (containsSensitive(result))
        throw new Error("提取结果触发敏感信息拦截。");
      const now = new Date().toISOString();
      db.prepare(
        "update local_jobs set status = 'READY_TO_SYNC', result_json = ?, error_code = null, updated_at = ? where id = ?",
      ).run(JSON.stringify(result), now, jobId);
      db.prepare(
        "update session_inventory set status = 'pending_sync', reason_code = null, updated_at = ? where session_id = ?",
      ).run(now, job.session_id);
      db.prepare(
        "update session_activity set processing_state = 'READY_TO_SYNC', updated_at = ? where session_id = ?",
      ).run(now, job.session_id);
      for (const path of [
        resolve(collectionWorkDirectory(), `local-${jobId}-input.json`),
        expectedResultPath,
      ]) {
        try {
          unlinkSync(path);
        } catch {
          // Validation is complete; cleanup can be retried by retention handling.
        }
      }
      output({ status: "validated", jobId, factCount: result.facts.length });
    } catch (error) {
      try {
        unlinkSync(expectedResultPath);
      } catch {
        // The agent may have failed before writing a result.
      }
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(
        "update local_jobs set status = 'PENDING', error_code = 'LOCAL_RESULT_INVALID', updated_at = ? where id = ?",
      ).run(new Date().toISOString(), jobId);
      db.prepare(
        "update session_inventory set status = 'failed_extract', reason_code = 'LOCAL_RESULT_INVALID', updated_at = ? where session_id = ?",
      ).run(new Date().toISOString(), job.session_id);
      db.prepare(
        "update session_activity set processing_state = 'DIRTY', updated_at = ? where session_id = ?",
      ).run(new Date().toISOString(), job.session_id);
      throw new Error(message);
    }
  } finally {
    db.close();
  }
}

function failLocal() {
  const jobId = option("job-id");
  if (!jobId) throw new Error("fail-local 需要 --job-id。");
  const db = openDatabase();
  try {
    const job = db
      .prepare(
        "select * from local_jobs where id = ? and status = 'IN_PROGRESS'",
      )
      .get(jobId) as unknown as LocalJob | undefined;
    if (!job) throw new Error("本地任务不存在或状态不是 IN_PROGRESS。");
    const now = new Date().toISOString();
    const errorCode = option("error-code", "LOCAL_AGENT_FAILED")!;
    if (isTerminalExtractionError(errorCode)) {
      db.prepare(
        "update local_jobs set status = 'CANCELLED', error_code = ?, updated_at = ? where id = ?",
      ).run(errorCode, now, jobId);
      db.prepare(
        "update session_inventory set status = 'excluded', reason_code = ?, updated_at = ? where session_id = ?",
      ).run(errorCode, now, job.session_id);
      db.prepare(
        "update session_activity set processing_state = 'CLEAN', updated_at = ? where session_id = ?",
      ).run(now, job.session_id);
      if (errorCode === "SENSITIVE_EGRESS_REJECTED") {
        queueDiagnostic(db, "extract", "SENSITIVE_EGRESS_REJECTED", false);
      }
      return output({
        status: "excluded",
        jobId,
        errorCode,
        retryable: false,
      });
    }
    db.prepare(
      "update local_jobs set status = 'PENDING', error_code = ?, updated_at = ? where id = ?",
    ).run(errorCode, now, jobId);
    db.prepare(
      "update session_inventory set status = 'failed_extract', reason_code = ?, updated_at = ? where session_id = ?",
    ).run(errorCode, now, job.session_id);
    db.prepare(
      "update session_activity set processing_state = 'PENDING_EXTRACT', updated_at = ? where session_id = ?",
    ).run(now, job.session_id);
    output({ status: "retry_scheduled", jobId, errorCode });
  } finally {
    db.close();
  }
}

function buildBatch(
  db: ReturnType<typeof openDatabase>,
  jobs: LocalJob[],
  policy: Policy,
) {
  const config = loadConfig()!;
  const batchId = randomUUID();
  const runId = jobs[0]?.run_id ?? getState(db, "active_collection_run_id");
  const run = runId
    ? (db
        .prepare("select * from collection_runs where id = ?")
        .get(runId) as unknown as LocalCollectionRun | undefined)
    : undefined;
  const payload = factBatchSchema.parse({
    schemaVersion: "1.0",
    producerVersion: `partner-report-sync/${PLUGIN_VERSION}`,
    batchId,
    pluginInstanceId: config.pluginInstanceId,
    ...(run
      ? {
          collectionRunId: run.id,
          periodKey: run.period_key,
          collectionWindow: {
            startsAt: run.window_starts_at,
            endsAt: run.window_ends_at,
            initialLookback: Boolean(run.initial_lookback),
          },
        }
      : {}),
    periodCandidates: policy.currentPeriod
      ? [policy.currentPeriod.period_key]
      : [],
    sessions: jobs.map((job) => JSON.parse(job.result_json!)),
  });
  const now = new Date().toISOString();
  db.prepare(
    "insert into pending_batches (id, payload_json, status, created_at, updated_at, run_id) values (?, ?, 'PENDING', ?, ?, ?)",
  ).run(batchId, JSON.stringify(payload), now, now, run?.id ?? null);
  return { batchId, payload };
}

async function sync() {
  const db = openDatabase();
  try {
    const policy = await fetchPolicy(db);
    const retryBatch = db
      .prepare(
        "select * from pending_batches where status = 'RETRY' order by created_at asc limit 1",
      )
      .get() as
      { id: string; payload_json: string; attempts: number } | undefined;
    let batchId: string;
    let payload: any;
    if (retryBatch) {
      batchId = retryBatch.id;
      payload = JSON.parse(retryBatch.payload_json);
    } else {
      const jobs = listLocalJobs(db, ["READY_TO_SYNC"]).slice(0, 50);
      if (jobs.length === 0) {
        await heartbeat(db);
        return output({
          status: "empty",
          pendingLocalJobs: pendingLocalCount(db),
        });
      }
      ({ batchId, payload } = buildBatch(db, jobs, policy));
    }

    try {
      const response = await authenticatedRequest<{
        batchId: string;
        accepted: number;
        rejected: number;
        results: Array<{
          sessionId: string;
          status: string;
          revision: number;
          code?: string;
        }>;
      }>("/v1/session-facts/batch", {
        method: "POST",
        headers: { "idempotency-key": batchId },
        body: JSON.stringify(payload),
      });
      const now = new Date().toISOString();
      for (const result of response.results) {
        const job = db
          .prepare(
            "select * from local_jobs where session_id = ? and source_revision = ? and status = 'READY_TO_SYNC'",
          )
          .get(result.sessionId, result.revision) as unknown as
          LocalJob | undefined;
        if (!job) continue;
        if (result.status === "accepted") {
          db.prepare(
            `
            insert into session_cursors (session_id, last_turn_id, source_revision, source_hash, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (session_id) do update set last_turn_id = excluded.last_turn_id,
              source_revision = excluded.source_revision, source_hash = excluded.source_hash, updated_at = excluded.updated_at
          `,
          ).run(
            job.session_id,
            job.to_turn_id,
            job.source_revision,
            job.source_hash,
            now,
          );
          db.prepare(
            "update local_jobs set status = 'SYNCED', error_code = null, updated_at = ? where id = ?",
          ).run(now, job.id);
          db.prepare(
            "update session_inventory set status = 'synced', reason_code = null, updated_at = ? where session_id = ?",
          ).run(now, job.session_id);
          db.prepare(
            `
            update session_activity set
              processing_state = case when latest_turn_id = ? then 'CLEAN' else 'DIRTY' end,
              updated_at = ?
            where session_id = ?
          `,
          ).run(job.to_turn_id, now, job.session_id);
        } else {
          db.prepare(
            "update local_jobs set error_code = ?, updated_at = ? where id = ?",
          ).run(result.code ?? "SERVER_REJECTED", now, job.id);
        }
      }
      db.prepare(
        "update pending_batches set status = 'COMPLETED', error_code = null, updated_at = ? where id = ?",
      ).run(now, batchId);
      setState(db, "last_sync_at", now);
      await heartbeat(db);
      output({
        status: response.rejected > 0 ? "partial" : "synced",
        ...response,
        pendingLocalJobs: pendingLocalCount(db),
      });
    } catch (error) {
      const code =
        error instanceof HttpError ? error.code : "NETWORK_OR_SERVER_ERROR";
      db.prepare(
        "update pending_batches set status = 'RETRY', attempts = attempts + 1, error_code = ?, updated_at = ? where id = ?",
      ).run(code, new Date().toISOString(), batchId);
      throw error;
    }
  } finally {
    db.close();
  }
}

async function heartbeat(existingDb?: ReturnType<typeof openDatabase>) {
  const config = loadConfig()!;
  const db = existingDb ?? openDatabase();
  try {
    const health = localCoverage(db);
    const activity = activitySummary(db);
    const runnerError = getState(db, "last_error_code");
    const body = {
      pluginVersion: PLUGIN_VERSION,
      deviceName: config.deviceName,
      runnerState: getState(db, "runner_state") ?? "idle",
      ...(activity.lastHookAt ? { lastHookAt: activity.lastHookAt } : {}),
      ...(getState(db, "last_runner_at")
        ? { lastRunnerAt: getState(db, "last_runner_at")! }
        : {}),
      ...(getState(db, "last_scan_at")
        ? { lastScanAt: getState(db, "last_scan_at")! }
        : {}),
      ...(getState(db, "last_sync_at")
        ? { lastSyncAt: getState(db, "last_sync_at")! }
        : {}),
      ...(activity.nextDueAt ? { nextDueAt: activity.nextDueAt } : {}),
      dirtySessions: activity.dirtySessions,
      extractingSessions: activity.extractingSessions,
      pendingLocalJobs: pendingLocalCount(db),
      retryCount: health.retryCount,
      ...(health.lastErrorCode || runnerError
        ? { lastErrorCode: health.lastErrorCode ?? runnerError! }
        : {}),
      coverage: health.coverage,
    };
    await authenticatedRequest("/v1/plugin-instances/me/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await flushDiagnostics(db).catch(() => undefined);
    setState(db, "last_heartbeat_at", new Date().toISOString());
    if (!existingDb) output({ status: "heartbeat_sent", ...body });
  } finally {
    if (!existingDb) db.close();
  }
}

async function collectionStatus() {
  const phase = z
    .enum(["started", "running", "continuation_pending", "completed", "failed"])
    .parse(option("phase"));
  const config = loadConfig()!;
  const db = openDatabase();
  try {
    const policy = await fetchPolicy(db);
    if (!policy.currentPeriod)
      throw new Error("服务端没有开放的 Report Period。");
    const ensured =
      phase === "started"
        ? claimCollectionRun(db, policy.currentPeriod.period_key)
        : null;
    if (ensured?.status === "already_running") {
      return output({
        status: "already_running",
        collectionRunId: ensured.run.id,
        leaseExpiresAt: ensured.run.lease_expires_at,
      });
    }
    const run = ensured?.run ?? activeCollectionRun(db);
    if (!run) throw new Error("没有活动采集 Run。");
    const health = localCoverage(db);
    const drain = collectionDrainState(db);
    const pending = drain.pendingLocalJobs;
    if (phase === "completed" && !drain.drained) {
      throw new Error(
        `COLLECTION_NOT_DRAINED: pendingLocalJobs=${pending}, pendingBatches=${drain.pendingBatches}`,
      );
    }
    const sessionCount = Number(
      (
        db
          .prepare(
            "select count(distinct session_id) as count from local_jobs where run_id = ? and status = 'SYNCED'",
          )
          .get(run.id) as { count: number }
      ).count,
    );
    const rows = db
      .prepare(
        "select result_json from local_jobs where run_id = ? and status = 'SYNCED' and result_json is not null",
      )
      .all(run.id) as Array<{ result_json: string }>;
    const factCount = rows.reduce((total, row) => {
      try {
        return total + (JSON.parse(row.result_json).facts?.length ?? 0);
      } catch {
        return total;
      }
    }, 0);
    const scanStats = JSON.parse(getState(db, "last_scan_stats") ?? "{}");
    const body = {
      pluginVersion: PLUGIN_VERSION,
      deviceName: config.deviceName,
      phase,
      collectionRunId: run.id,
      periodKey: run.period_key,
      windowStartsAt: run.window_starts_at,
      windowEndsAt: run.window_ends_at,
      initialLookback: Boolean(run.initial_lookback),
      sessionCount,
      factCount,
      pendingLocalJobs: pending,
      discoveredCount: Number(scanStats.discovered ?? 0),
      eligibleCount: Number(scanStats.eligible ?? scanStats.queued ?? 0),
      deferredCount: Number(scanStats.deferred ?? 0),
      excludedCount: Number(scanStats.excluded ?? 0),
      ...(getState(db, "last_scan_at")
        ? { lastScanAt: getState(db, "last_scan_at")! }
        : {}),
      ...(getState(db, "last_sync_at")
        ? { lastSyncAt: getState(db, "last_sync_at")! }
        : {}),
      ...(option("error-code") ? { errorCode: option("error-code") } : {}),
      coverage: health.coverage,
    };
    await authenticatedRequest("/v1/plugin-instances/me/collection-status", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const now = new Date().toISOString();
    if (phase === "completed") {
      db.prepare(
        `update collection_runs set status = 'COMPLETED', completed_at = ?,
          lease_owner = null, lease_expires_at = null, updated_at = ? where id = ?`,
      ).run(now, now, run.id);
      setState(db, "last_collection_window_end", run.window_ends_at);
      setState(db, "active_collection_run_id", "");
    } else if (phase === "continuation_pending") {
      db.prepare(
        `update collection_runs set status = 'CONTINUATION_PENDING',
          continuation_count = continuation_count + 1, lease_owner = null,
          lease_expires_at = null, updated_at = ? where id = ?`,
      ).run(now, run.id);
    } else if (phase === "failed") {
      db.prepare(
        `update collection_runs set status = 'FAILED', error_code = ?,
          lease_owner = null, lease_expires_at = null, updated_at = ? where id = ?`,
      ).run(option("error-code") ?? "LOCAL_AGENT_FAILED", now, run.id);
    }
    await flushDiagnostics(db).catch(() => undefined);
    setState(db, `last_collection_${phase}_at`, now);
    output({
      status: `collection_${phase}`,
      invocationDeadlineAt: run.invocation_deadline_at,
      continuationCount: run.continuation_count,
      ...body,
    });
  } finally {
    db.close();
  }
}

async function leaseNext() {
  const db = openDatabase();
  try {
    let existing = db
      .prepare(
        "select * from remote_leases where status = 'LEASED' order by created_at asc limit 1",
      )
      .get() as unknown as RemoteLease | undefined;
    if (
      existing &&
      Date.now() - new Date(existing.updated_at).getTime() >= 15 * 60_000
    ) {
      db.prepare(
        "update remote_leases set status = 'EXPIRED', updated_at = ? where job_id = ? and status = 'LEASED'",
      ).run(new Date().toISOString(), existing.job_id);
      existing = undefined;
    }
    if (existing) {
      const paths = materialize(
        "remote",
        existing.job_id,
        JSON.parse(existing.input_json),
      );
      return output({
        status: "ready",
        kind: existing.type,
        jobId: existing.job_id,
        ...paths,
        schemaPath: schemaForRemoteType(existing.type),
      });
    }
    const pending = await authenticatedRequest<
      Array<{ id: string; type: string }>
    >("/v1/agent-jobs/pending");
    if (pending.length === 0) return output({ status: "empty" });
    const leased = await authenticatedRequest<{
      id: string;
      type: string;
      input_payload: unknown;
      leaseToken: string;
      lease_until: string;
    }>(`/v1/agent-jobs/${pending[0]!.id}/ack`, { method: "POST" });
    const now = new Date().toISOString();
    db.prepare(
      `
      insert into remote_leases (job_id, type, lease_token, input_json, status, created_at, updated_at)
      values (?, ?, ?, ?, 'LEASED', ?, ?)
      on conflict(job_id) do update set type = excluded.type, lease_token = excluded.lease_token,
        input_json = excluded.input_json, status = 'LEASED', updated_at = excluded.updated_at
    `,
    ).run(
      leased.id,
      leased.type,
      leased.leaseToken,
      JSON.stringify(leased.input_payload),
      now,
      now,
    );
    const paths = materialize("remote", leased.id, leased.input_payload);
    output({
      status: "ready",
      kind: leased.type,
      jobId: leased.id,
      leaseUntil: leased.lease_until,
      ...paths,
      schemaPath: schemaForRemoteType(leased.type),
    });
  } finally {
    db.close();
  }
}

function schemaForRemoteType(type: string) {
  const root = process.env.PLUGIN_ROOT ?? resolve(import.meta.dirname, "..");
  if (type === "AGGREGATE_WORK_ITEMS")
    return resolve(root, "schemas/aggregation-result-v1.json");
  if (
    ["GENERATE_INDIVIDUAL_REPORT", "REGENERATE_INDIVIDUAL_REPORT"].includes(
      type,
    )
  )
    return resolve(root, "schemas/individual-report-result-v1.json");
  return null;
}

async function completeRemote() {
  const jobId = option("job-id");
  const resultPath = option("result");
  if (!jobId || !resultPath)
    throw new Error("complete-remote 需要 --job-id 与 --result。");
  const db = openDatabase();
  try {
    const lease = db
      .prepare(
        "select * from remote_leases where job_id = ? and status = 'LEASED'",
      )
      .get(jobId) as unknown as RemoteLease | undefined;
    if (!lease) throw new Error("远程任务租约不存在。");
    const raw = JSON.parse(readFileSync(resultPath, "utf8"));
    const result =
      lease.type === "AGGREGATE_WORK_ITEMS"
        ? aggregationResultSchema.parse(raw)
        : [
              "GENERATE_INDIVIDUAL_REPORT",
              "REGENERATE_INDIVIDUAL_REPORT",
            ].includes(lease.type)
          ? individualReportResultSchema.parse(raw)
          : z
              .object({
                completed: z.literal(true),
                batchIds: z.array(z.string()).default([]),
              })
              .parse(raw);
    if (
      ["GENERATE_INDIVIDUAL_REPORT", "REGENERATE_INDIVIDUAL_REPORT"].includes(
        lease.type,
      )
    ) {
      assertReportSemantics(
        result as ReturnType<typeof individualReportResultSchema.parse>,
      );
    }
    if (containsSensitive(result))
      throw new Error("Agent Job 结果触发敏感信息拦截。");
    await authenticatedRequest(`/v1/agent-jobs/${jobId}/complete`, {
      method: "POST",
      headers: { "x-job-lease": lease.lease_token },
      body: JSON.stringify(result),
    });
    db.prepare(
      "update remote_leases set status = 'COMPLETED', updated_at = ? where job_id = ?",
    ).run(new Date().toISOString(), jobId);
    output({ status: "completed", jobId, type: lease.type });
  } finally {
    db.close();
  }
}

async function failRemote() {
  const jobId = option("job-id");
  if (!jobId) throw new Error("fail-remote 需要 --job-id。");
  const db = openDatabase();
  try {
    const lease = db
      .prepare(
        "select * from remote_leases where job_id = ? and status = 'LEASED'",
      )
      .get(jobId) as unknown as RemoteLease | undefined;
    if (!lease) throw new Error("远程任务租约不存在。");
    const body = {
      errorCode: option("error-code", "LOCAL_AGENT_FAILED"),
      message: option("message", "Local Codex task failed"),
      retryable: !flag("terminal"),
    };
    await authenticatedRequest(`/v1/agent-jobs/${jobId}/fail`, {
      method: "POST",
      headers: { "x-job-lease": lease.lease_token },
      body: JSON.stringify(body),
    });
    db.prepare(
      "update remote_leases set status = 'FAILED', updated_at = ? where job_id = ?",
    ).run(new Date().toISOString(), jobId);
    output({ status: "failed", jobId, ...body });
  } finally {
    db.close();
  }
}

async function status() {
  const config = loadConfig(false);
  const db = openDatabase();
  try {
    const health = localCoverage(db);
    output({
      connected: Boolean(config),
      pluginVersion: PLUGIN_VERSION,
      pluginInstanceId: config?.pluginInstanceId ?? null,
      serverUrl: config?.serverUrl ?? null,
      connectivityStatus:
        config?.connectivityStatus ??
        getState(db, "connectivity_status") ??
        "pending",
      connectivityVerifiedAt:
        config?.connectivityVerifiedAt ??
        getState(db, "connectivity_verified_at"),
      lastScanAt: getState(db, "last_scan_at"),
      lastSyncAt: getState(db, "last_sync_at"),
      lastHeartbeatAt: getState(db, "last_heartbeat_at"),
      lastRunnerAt: getState(db, "last_runner_at"),
      runnerState: getState(db, "runner_state") ?? "idle",
      lastErrorCode: health.lastErrorCode ?? getState(db, "last_error_code"),
      pendingLocalJobs: pendingLocalCount(db),
      activeCollectionRun:
        db
          .prepare(
            "select id, period_key, status, window_starts_at, window_ends_at, invocation_deadline_at, continuation_count from collection_runs where status in ('STARTED', 'RUNNING', 'CONTINUATION_PENDING') order by created_at asc limit 1",
          )
          .get() ?? null,
      pendingDiagnostics: Number(
        (
          db
            .prepare(
              "select count(*) as count from diagnostic_outbox where status = 'PENDING'",
            )
            .get() as { count: number }
        ).count,
      ),
      coverage: health.coverage,
      activeRemoteLease:
        db
          .prepare(
            "select job_id, type, created_at from remote_leases where status = 'LEASED' order by created_at asc limit 1",
          )
          .get() ?? null,
    });
  } finally {
    db.close();
  }
}

async function diagnostic() {
  const stage = z
    .enum(["binding", "connectivity", "task_setup", "scan", "extract", "sync"])
    .parse(option("stage")) as DiagnosticStage;
  const errorCode = z
    .enum([
      "DNS_FAILED",
      "TLS_FAILED",
      "CONNECTION_REFUSED",
      "CONNECTIVITY_TIMEOUT",
      "AUTH_FAILED",
      "VERSION_BLOCKED",
      "CHALLENGE_INVALID",
      "CHALLENGE_EXPIRED",
      "CLIENT_CLOCK_SKEW",
      "REQUEST_INVALID",
      "TASK_SETUP_FAILED",
      "SCAN_FAILED",
      "EXTRACT_FAILED",
      "SYNC_FAILED",
      "LOCAL_STORAGE_FAILED",
      "LOCAL_AGENT_FAILED",
      "SENSITIVE_EGRESS_REJECTED",
    ])
    .parse(option("error-code")) as DiagnosticErrorCode;
  const db = openDatabase();
  try {
    queueDiagnostic(db, stage, errorCode, !flag("terminal"));
    const synced = await flushDiagnostics(db).catch(() => ({
      submitted: 0,
      accepted: 0,
    }));
    output({ status: "diagnostic_recorded", stage, errorCode, synced });
  } finally {
    db.close();
  }
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
    excludedSessionCount:
      kind === "session" ? current.size : config.excludedSessionIds.length,
    excludedPathCount:
      kind === "path" ? current.size : config.excludedPaths.length,
  });
}

function help() {
  output({
    commands: [
      "connect --server <url> --binding-code <code> [--device-name <name>]",
      "connectivity-test",
      "scheduled-task-config",
      "continuation-task-config",
      "daily-collect [--force]",
      "weekly-collect [--force] (deprecated alias)",
      "run-once [--force]",
      "daily-finish",
      "daily-fail [--error-code <code>]",
      "prepare [--force]",
      "next-local",
      "complete-local --job-id <id> --result <path>",
      "fail-local --job-id <id> [--error-code <code>]",
      "sync",
      "status",
      "sync-projects",
      "diagnostic --stage <stage> --error-code <code> [--terminal]",
      "exclude-session --session-id <id>",
      "include-session --session-id <id>",
      "exclude-path --path <absolute-path>",
      "include-path --path <absolute-path>",
    ],
  });
}

const command = process.argv[2] ?? "help";
try {
  if (
    [
      "connect",
      "connectivity-test",
      "scheduled-task-config",
      "continuation-task-config",
      "daily-collect",
      "weekly-collect",
      "run-once",
      "daily-finish",
      "daily-fail",
    ].includes(command)
  ) {
    rememberCurrentSystemSession();
  }
  if (command === "connect") await connect();
  else if (command === "connectivity-test") await connectivityTest();
  else if (command === "scheduled-task-config") scheduledTaskConfig();
  else if (command === "continuation-task-config") continuationTaskConfig();
  else if (
    command === "run-once" ||
    command === "daily-collect" ||
    command === "weekly-collect"
  ) {
    output(
      await beginCollectionCycle(resolve(process.argv[1]!), flag("force")),
    );
  } else if (command === "daily-finish")
    output(await finishCollectionCycle(resolve(process.argv[1]!)));
  else if (command === "daily-fail") {
    output(
      await failCollectionCycle(
        resolve(process.argv[1]!),
        option("error-code", "LOCAL_AGENT_FAILED"),
      ),
    );
    process.exitCode = 1;
  } else if (command === "prepare") await prepare();
  else if (command === "next-local") nextLocal();
  else if (command === "complete-local") completeLocal();
  else if (command === "fail-local") failLocal();
  else if (command === "sync") await sync();
  else if (command === "heartbeat") await heartbeat();
  else if (command === "collection-status") await collectionStatus();
  else if (command === "status") await status();
  else if (command === "sync-projects") await syncProjects();
  else if (command === "diagnostic") await diagnostic();
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
    `${JSON.stringify({ status: "error", code, message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
