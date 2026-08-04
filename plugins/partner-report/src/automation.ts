import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { dataDirectory, loadConfig } from "./config.js";
import { SCHEDULED_CONTINUATION_TASK } from "./collection-config.js";
import { queueDiagnosticSafely } from "./diagnostics.js";
import {
  cleanupLocalData,
  getState,
  openDatabase,
  setState,
} from "./database.js";

type CommandResult = Record<string, unknown> & { status: string };

function safeError(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function spawnCli(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(command, args, {
        env: {
          ...process.env,
          PARTNER_REPORT_AUTOMATION: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + String(chunk)).slice(-128_000);
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-128_000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise({ stdout, stderr });
        else
          reject(
            new Error(
              stderr.trim() ||
                `${command} exited with code ${code ?? "unknown"}`,
            ),
          );
      });
    },
  );
}

async function runCli(cliPath: string, args: string[]) {
  const { stdout } = await spawnCli(process.execPath, [cliPath, ...args]);
  try {
    return JSON.parse(stdout) as CommandResult;
  } catch {
    throw new Error(
      `Partner Report CLI returned invalid JSON for ${args[0] ?? "command"}`,
    );
  }
}

export function maximumCollectionJobs() {
  const configured = Number(
    process.env.PARTNER_REPORT_MAX_JOBS_PER_INVOCATION ??
      process.env.PARTNER_REPORT_MAX_JOBS ??
      50,
  );
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(Math.floor(configured), 100))
    : 50;
}

export function collectionWorkDirectory() {
  const instance =
    loadConfig(false)?.pluginInstanceId.replace(/[^a-zA-Z0-9._-]/g, "_") ??
    "unbound";
  const path = resolve(tmpdir(), "partner-report-agent", instance, "work");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function markRunner(
  state: "idle" | "working" | "delayed" | "error",
  errorCode?: string,
) {
  const db = openDatabase();
  try {
    setState(db, "runner_state", state);
    setState(db, "last_runner_at", new Date().toISOString());
    if (errorCode) setState(db, "last_error_code", errorCode);
    else if (state === "idle") setState(db, "last_error_code", "");
  } finally {
    db.close();
  }
}

function recoverStaleLocalJobs() {
  const db = openDatabase();
  try {
    const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    const stale = db
      .prepare(
        "select id, session_id from local_jobs where status = 'IN_PROGRESS' and updated_at < ?",
      )
      .all(staleBefore) as Array<{ id: string; session_id: string }>;
    const now = new Date().toISOString();
    for (const job of stale) {
      db.prepare(
        "update local_jobs set status = 'PENDING', error_code = 'STALE_LOCAL_JOB_RECOVERED', updated_at = ? where id = ?",
      ).run(now, job.id);
      db.prepare(
        "update session_activity set processing_state = 'PENDING_EXTRACT', updated_at = ? where session_id = ?",
      ).run(now, job.session_id);
    }
    return stale.length;
  } finally {
    db.close();
  }
}

function cleanupOldLocalState() {
  const configuredDays = Number(
    process.env.PARTNER_REPORT_LOCAL_RETENTION_DAYS ?? 30,
  );
  const retentionDays = Number.isFinite(configuredDays)
    ? Math.max(1, Math.min(Math.floor(configuredDays), 365))
    : 30;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  const db = openDatabase();
  let database;
  try {
    database = cleanupLocalData(db, Date.now(), retentionDays);
  } finally {
    db.close();
  }

  let workFiles = 0;
  const workDirectories = [
    collectionWorkDirectory(),
    resolve(dataDirectory(), "work"),
  ];
  for (const workDirectory of workDirectories) {
    if (!existsSync(workDirectory)) continue;
    for (const name of readdirSync(workDirectory)) {
      if (!/^(local|remote)-.+-(input|result)\.json$/.test(name)) continue;
      const path = resolve(workDirectory, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          workFiles += 1;
        }
      } catch {
        // A concurrently active collection may replace or remove its work file.
      }
    }
  }
  return { ...database, workFiles };
}

async function reportFailure(cliPath: string, errorCode: string) {
  markRunner("error", errorCode);
  await runCli(cliPath, [
    "collection-status",
    "--phase",
    "failed",
    "--error-code",
    errorCode,
  ]).catch(() => undefined);
}

export async function beginCollectionCycle(cliPath: string, force = false) {
  markRunner("working");
  try {
    const started = await runCli(cliPath, [
      "collection-status",
      "--phase",
      "started",
    ]);
    if (started.status === "already_running") {
      return {
        status: "already_running",
        collectionRunId: started.collectionRunId ?? null,
        leaseExpiresAt: started.leaseExpiresAt ?? null,
      };
    }
    const recoveredLocalJobs = recoverStaleLocalJobs();
    const cleanup = cleanupOldLocalState();
    const prepared = await runCli(
      cliPath,
      force ? ["prepare", "--force"] : ["prepare"],
    );
    const db = openDatabase();
    try {
      setState(db, "last_discovery_at", new Date().toISOString());
    } finally {
      db.close();
    }
    return {
      status: "ready_for_agent",
      periodKey: started.periodKey ?? null,
      collectionRunId: started.collectionRunId ?? null,
      invocationDeadlineAt: started.invocationDeadlineAt ?? null,
      recoveredLocalJobs,
      cleanup,
      pendingLocalJobs: prepared.pendingLocalJobs ?? 0,
      maxJobs: maximumCollectionJobs(),
      nextCommand: "next-local",
    };
  } catch (error) {
    queueDiagnosticSafely("scan", "SCAN_FAILED");
    await reportFailure(cliPath, "DAILY_COLLECTION_FAILED");
    throw new Error(`Daily collection failed: ${safeError(error)}`);
  }
}

export async function finishCollectionCycle(cliPath: string) {
  try {
    const batchIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const result = await runCli(cliPath, ["sync"]);
      if (result.status === "empty") break;
      if (typeof result.batchId === "string") batchIds.push(result.batchId);
      if (result.status === "partial") break;
    }
    const db = openDatabase();
    let pendingLocalJobs = 0;
    try {
      pendingLocalJobs = Number(
        (
          db
            .prepare(
              "select count(*) as count from local_jobs where status not in ('SYNCED', 'CANCELLED')",
            )
            .get() as { count: number }
        ).count,
      );
    } finally {
      db.close();
    }
    if (pendingLocalJobs > 0) {
      markRunner("delayed");
      const continuation = await runCli(cliPath, [
        "collection-status",
        "--phase",
        "continuation_pending",
      ]);
      return {
        status: "continuation_required",
        collectionRunId: continuation.collectionRunId ?? null,
        periodKey: continuation.periodKey ?? null,
        pendingLocalJobs,
        batchIds,
        continuationTask: SCHEDULED_CONTINUATION_TASK,
      };
    }
    markRunner("idle");
    const completed = await runCli(cliPath, [
      "collection-status",
      "--phase",
      "completed",
    ]);
    return {
      status: "completed",
      periodKey: completed.periodKey ?? null,
      sessionCount: completed.sessionCount ?? 0,
      factCount: completed.factCount ?? 0,
      pendingLocalJobs: completed.pendingLocalJobs ?? 0,
      batchIds,
      coverage: completed.coverage ?? null,
    };
  } catch (error) {
    queueDiagnosticSafely("sync", "SYNC_FAILED");
    await reportFailure(cliPath, "DAILY_COLLECTION_FAILED");
    throw new Error(`Daily collection failed: ${safeError(error)}`);
  }
}

export async function failCollectionCycle(
  cliPath: string,
  errorCode = "LOCAL_AGENT_FAILED",
) {
  queueDiagnosticSafely(
    "extract",
    errorCode === "SENSITIVE_EGRESS_REJECTED"
      ? "SENSITIVE_EGRESS_REJECTED"
      : "LOCAL_AGENT_FAILED",
    errorCode !== "SENSITIVE_EGRESS_REJECTED",
  );
  await reportFailure(cliPath, errorCode);
  return { status: "failed", errorCode };
}
