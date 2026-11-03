import { closeDatabase, sqlClient as sql } from "@partner-report/db";
import { autoApproveExpiredReviews } from "./review-timeout.js";
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

let stopping = false;
let workerState = "starting";
let workerError: string | null = null;

async function heartbeat(tickCompleted = false) {
  await sql`insert into service_heartbeats (name,heartbeat_at,last_tick_at,status,error_code,capabilities)
    values ('worker',now(),case when ${tickCompleted} then now() else null end,${workerState},${workerError},
      ${JSON.stringify({ collectorAnalysis: true, modelConfigured: modelGatewayConfigured() })}::jsonb)
    on conflict (name) do update set heartbeat_at=now(),status=excluded.status,error_code=excluded.error_code,
      capabilities=excluded.capabilities,last_tick_at=coalesce(excluded.last_tick_at,service_heartbeats.last_tick_at)`;
}

async function tick() {
  await backfillCollectorUploads();
  await scheduleCollectorCards();
  const reviewTimeout = await autoApproveExpiredReviews();
  if (reviewTimeout.approvedReviews > 0) {
    console.log(
      `Auto-approved ${reviewTimeout.approvedItems} work card(s) in ${reviewTimeout.approvedReviews} expired review(s).`,
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
  const generation = await processNextGenerationJob();
  if (generation.processed)
    console.log("Central generation job processed", generation);
  await scheduleCollectorCards();
  const inspection = await runScheduledInspections();
  if (inspection.teams > 0 && (inspection.opened > 0 || inspection.escalated > 0 || inspection.resolved > 0)) {
    console.log("Inspection run finished", inspection);
  }
  await sql`
    update plugin_device_authorizations set status = 'expired'
    where status in ('pending', 'approved') and expires_at < now()
  `;
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
  return generation.processed;
}

async function loop() {
  while (!stopping) {
    let processed = false;
    try {
      workerState = "processing";
      await heartbeat();
      processed = await tick();
      workerState = "idle";
      workerError = null;
      await heartbeat(true);
    } catch (error) {
      workerState = "error";
      workerError = "WORKER_TICK_FAILED";
      await heartbeat().catch(() => {});
      console.error(
        "worker tick failed",
        error instanceof Error ? error.message : error,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, processed ? 250 : 15_000),
    );
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

console.log("Partner Report worker started.");
const heartbeatTimer = setInterval(() => {
  void heartbeat().catch(() => {});
}, 15_000);
heartbeatTimer.unref();
await loop();
