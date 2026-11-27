import { setTimeout as sleep } from "node:timers/promises";
import { closeDatabase, sqlClient as sql } from "@partner-report/db";
import { autoApproveExpiredReviews } from "./review-timeout.js";
import { publishDueLeadershipSnapshots } from "./leadership.js";
import { scheduleDueWeeklyReports } from "./weekly.js";
import {
  processNextGenerationJob,
  releaseCentralJobLeases,
} from "./generation.js";
import {
  backfillCollectorUploads,
  scheduleCollectorCards,
} from "./collector-pipeline.js";
import { modelGatewayConfigured } from "./model.js";
import { runScheduledInspections } from "./inspection-analysis.js";
import { processNextProjectProfile } from "./project-profile.js";
import { recoverGatewayFailures } from "./model-recovery.js";

// Each job sends at most 4 model requests at once (see PROJECT_GENERATION_CONCURRENCY), keeping the worker under the gateway limit.
const GENERATION_JOBS_IN_FLIGHT = 3;
const SCHEDULER_IDLE_MS = 15_000;
const EXECUTOR_IDLE_MS = 5_000;
const BUSY_MS = 250;
const RECOVERY_IDLE_MS = 60_000;
let stopping = false;
let workerState = "starting";
let workerError: string | null = null;
let activeSteps = 0;
const failingLoops: Record<string, true> = {};

function refreshState() {
  if (stopping) return;
  const failing = Object.keys(failingLoops).length > 0;
  workerState = failing ? "error" : activeSteps > 0 ? "processing" : "idle";
  workerError = failing ? "WORKER_TICK_FAILED" : null;
}

async function heartbeat(tickCompleted = false) {
  await sql`insert into service_heartbeats (name,heartbeat_at,last_tick_at,status,error_code,capabilities)
    values ('worker',now(),case when ${tickCompleted} then now() else null end,${workerState},${workerError},
      ${JSON.stringify({ collectorAnalysis: true, modelConfigured: modelGatewayConfigured() })}::jsonb)
    on conflict (name) do update set heartbeat_at=now(),status=excluded.status,error_code=excluded.error_code,
      capabilities=excluded.capabilities,last_tick_at=coalesce(excluded.last_tick_at,service_heartbeats.last_tick_at)`;
}

/** Sweeps that must never wait behind a model call: scheduling, timeouts, inspections, housekeeping. */
async function schedulerStep() {
  const backfilled = await backfillCollectorUploads();
  await scheduleCollectorCards();
  const reviewTimeout = await autoApproveExpiredReviews();
  if (reviewTimeout.approvedReviews > 0) {
    console.log(
      `Auto-approved ${reviewTimeout.approvedItems} work card(s) in ${reviewTimeout.approvedReviews} review(s) at the Monday deadline.`,
    );
  }
  try {
    const leadership = await publishDueLeadershipSnapshots();
    if (leadership.published > 0) {
      console.log(`Published ${leadership.published} leadership snapshot(s).`);
    }
  } catch (error) {
    // Per-period failures are isolated inside; this covers the candidate query so the rest of the sweep still runs.
    console.error(
      "Leadership snapshot sweep failed",
      error instanceof Error ? error.message : error,
    );
  }
  const weekly = await scheduleDueWeeklyReports();
  if (weekly.closedPeriods > 0) {
    console.log(
      `Weekly cutoff closed ${weekly.closedPeriods} period(s) and queued ${weekly.aggregationJobs} aggregation job(s).`,
    );
  }
  if (weekly.teamReportJobs > 0) {
    console.log(
      `Queued ${weekly.teamReportJobs} Team Report generation job(s).`,
    );
  }
  const inspection = await runScheduledInspections();
  if (
    inspection.teams > 0 &&
    (inspection.opened > 0 ||
      inspection.escalated > 0 ||
      inspection.resolved > 0)
  ) {
    console.log("Inspection run finished", inspection);
  }
  await sql`
    update agent_jobs set
      status = case when attempt_count < max_attempts then 'PENDING' else 'FAILED' end,
      lease_token_hash = null,
      lease_until = null,
      error_code = case when attempt_count >= max_attempts then 'LEASE_EXHAUSTED' else error_code end,
      updated_at = now()
    where status = 'LEASED' and lease_until < now()
  `;
  await sql`delete from web_sessions where expires_at < now()`;
  await sql`delete from invitations where accepted_at is null and expires_at < now() - interval '7 days'`;
  await sql`
    delete from agent_jobs
    where type like 'SYSTEM_HEALTH_%'
      and status in ('COMPLETED', 'FAILED', 'CANCELLED')
      and updated_at < now() - interval '10 minutes'
  `;
  await heartbeat(true);
  // A full backfill batch means more uploads are waiting.
  return backfilled >= 20 ? BUSY_MS : SCHEDULER_IDLE_MS;
}

/** Leases and runs one model-backed job. Each executor loop holds at most one job at a time. */
async function generationStep() {
  const generation = await processNextGenerationJob();
  if (!generation.processed) return EXECUTOR_IDLE_MS;
  console.log("Central generation job processed", generation);
  // Finished analysis may make a member's cards ready to queue; don't wait for the next scheduler sweep.
  await scheduleCollectorCards();
  return BUSY_MS;
}

async function profileStep() {
  if (!modelGatewayConfigured()) return SCHEDULER_IDLE_MS;
  return (await processNextProjectProfile()).processed
    ? BUSY_MS
    : SCHEDULER_IDLE_MS;
}

/** Model probes can take seconds, so recovery of gateway-caused failures runs apart from the scheduler. */
async function recoveryStep() {
  if (!modelGatewayConfigured()) return RECOVERY_IDLE_MS;
  await recoverGatewayFailures();
  return RECOVERY_IDLE_MS;
}

/** One failing loop is reported in the heartbeat but never stops the others. */
async function runLoop(name: string, step: () => Promise<number>) {
  while (!stopping) {
    let delayMs = SCHEDULER_IDLE_MS;
    activeSteps++;
    refreshState();
    try {
      delayMs = await step();
      delete failingLoops[name];
    } catch (error) {
      failingLoops[name] = true;
      console.error(
        `worker loop ${name} failed`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      activeSteps--;
      refreshState();
    }
    await sleep(delayMs);
  }
}

const shutdown = async () => {
  stopping = true;
  clearInterval(heartbeatTimer);
  workerState = "stopped";
  await heartbeat().catch(() => {});
  await releaseCentralJobLeases().catch(() => {});
  await closeDatabase();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Weekly Report worker started.");
const heartbeatTimer = setInterval(() => {
  void heartbeat().catch(() => {});
}, 15_000);
heartbeatTimer.unref();
await Promise.all([
  runLoop("scheduler", schedulerStep),
  ...Array.from({ length: GENERATION_JOBS_IN_FLIGHT }, (_, index) =>
    runLoop(`generation-${index + 1}`, generationStep),
  ),
  runLoop("profile", profileStep),
  runLoop("model-recovery", recoveryStep),
]);
