import type { DatabaseSync } from "node:sqlite";
import { getState, pendingLocalCount, retryCount } from "./database.js";

export function localCoverage(db: DatabaseSync) {
  const counts = db.prepare(`
    select
      count(*) as discovered,
      sum(case when status not in ('failed_read', 'excluded') then 1 else 0 end) as readable,
      sum(case when status = 'synced' then 1 else 0 end) as extracted,
      sum(case when status = 'failed_read' then 1 else 0 end) as failed_read,
      sum(case when status = 'failed_extract' then 1 else 0 end) as failed_extract,
      sum(case when status = 'excluded' then 1 else 0 end) as excluded
    from session_inventory
  `).get() as Record<string, number | null>;
  const warnings: string[] = [];
  const latestError = db.prepare(`
    select error_code from (
      select error_code, updated_at from local_jobs where error_code is not null
      union all
      select error_code, updated_at from pending_batches where error_code is not null
    ) order by updated_at desc limit 1
  `).get() as { error_code?: string } | undefined;
  if (latestError?.error_code) warnings.push(latestError.error_code);
  const lastSyncAt = getState(db, "last_sync_at");
  return {
    coverage: {
      discovered: Number(counts.discovered ?? 0),
      readable: Number(counts.readable ?? 0),
      extracted: Number(counts.extracted ?? 0),
      failedRead: Number(counts.failed_read ?? 0),
      failedExtract: Number(counts.failed_extract ?? 0),
      excluded: Number(counts.excluded ?? 0),
      pendingSync: pendingLocalCount(db),
      activeAtCutoff: 0,
      hookMissed: Number(getState(db, "hook_missed_at_scan") ?? 0),
      warnings,
      ...(lastSyncAt ? { lastSyncAt } : {})
    },
    retryCount: retryCount(db),
    lastErrorCode: latestError?.error_code ?? null
  };
}
