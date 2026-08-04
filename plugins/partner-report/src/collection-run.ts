import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  activeCollectionRun,
  getState,
  setState,
  type LocalCollectionRun,
} from "./database.js";

export const INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;
export const INVOCATION_SOFT_LIMIT_MS = 10 * 60_000;
export const LEASE_GRACE_MS = 2 * 60_000;

export function collectionRunnerOwner() {
  return (
    process.env.CODEX_THREAD_ID ??
    process.env.PARTNER_REPORT_RUNNER_ID ??
    `manual-${process.ppid}`
  );
}

export function claimCollectionRun(
  db: DatabaseSync,
  periodKey: string,
  options: { now?: Date; owner?: string } = {},
) {
  const now = options.now ?? new Date();
  const owner = options.owner ?? collectionRunnerOwner();
  const current = activeCollectionRun(db);
  if (
    current?.lease_owner &&
    current.lease_owner !== owner &&
    current.lease_expires_at &&
    new Date(current.lease_expires_at).getTime() > now.getTime()
  ) {
    return { status: "already_running" as const, run: current };
  }
  const deadline = new Date(now.getTime() + INVOCATION_SOFT_LIMIT_MS);
  const leaseExpiresAt = new Date(deadline.getTime() + LEASE_GRACE_MS);
  if (current) {
    db.prepare(
      `update collection_runs set status = 'RUNNING', invocation_deadline_at = ?,
        lease_owner = ?, lease_expires_at = ?, updated_at = ? where id = ?`,
    ).run(
      deadline.toISOString(),
      owner,
      leaseExpiresAt.toISOString(),
      now.toISOString(),
      current.id,
    );
    db.prepare(
      "update local_jobs set run_id = ? where run_id is null and status not in ('SYNCED', 'CANCELLED')",
    ).run(current.id);
    return {
      status: "running" as const,
      run: db
        .prepare("select * from collection_runs where id = ?")
        .get(current.id) as unknown as LocalCollectionRun,
    };
  }
  const previousWindowEnd = getState(db, "last_collection_window_end");
  const startsAt = previousWindowEnd
    ? new Date(previousWindowEnd)
    : new Date(now.getTime() - INITIAL_LOOKBACK_MS);
  const id = randomUUID();
  db.prepare(
    `insert into collection_runs (
      id, period_key, status, window_starts_at, window_ends_at, initial_lookback,
      invocation_deadline_at, continuation_count, lease_owner, lease_expires_at,
      created_at, updated_at
    ) values (?, ?, 'RUNNING', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    periodKey,
    startsAt.toISOString(),
    now.toISOString(),
    previousWindowEnd ? 0 : 1,
    deadline.toISOString(),
    owner,
    leaseExpiresAt.toISOString(),
    now.toISOString(),
    now.toISOString(),
  );
  setState(db, "active_collection_run_id", id);
  return {
    status: "running" as const,
    run: db
      .prepare("select * from collection_runs where id = ?")
      .get(id) as unknown as LocalCollectionRun,
  };
}

export function collectionDrainState(db: DatabaseSync) {
  const pendingLocalJobs = Number(
    (
      db
        .prepare(
          "select count(*) as count from local_jobs where status not in ('SYNCED', 'CANCELLED')",
        )
        .get() as { count: number }
    ).count,
  );
  const pendingBatches = Number(
    (
      db
        .prepare(
          "select count(*) as count from pending_batches where status != 'COMPLETED'",
        )
        .get() as { count: number }
    ).count,
  );
  return {
    pendingLocalJobs,
    pendingBatches,
    drained: pendingLocalJobs === 0 && pendingBatches === 0,
  };
}
