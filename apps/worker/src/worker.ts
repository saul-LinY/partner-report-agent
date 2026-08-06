import { closeDatabase, sqlClient as sql } from "@partner-report/db";
import {
  scheduleDueWeeklyReports,
  scheduleProjectScopeFallbacks,
} from "./weekly.js";
import { processNextGenerationJob } from "./generation.js";

let stopping = false;

async function tick() {
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
  const scopeFallbacks = await scheduleProjectScopeFallbacks();
  if (scopeFallbacks > 0)
    console.log(`Queued ${scopeFallbacks} project scope fallback card(s).`);
  const generation = await processNextGenerationJob();
  if (generation.processed)
    console.log("Central generation job processed", generation);
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
}

async function loop() {
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error(
        "worker tick failed",
        error instanceof Error ? error.message : error,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

const shutdown = async () => {
  stopping = true;
  await closeDatabase();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Partner Report worker started.");
await loop();
