import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDirectory } from "./config.js";

export type LocalJob = {
  id: string;
  type: string;
  status: string;
  session_id: string;
  source_revision: number;
  from_turn_id: string;
  to_turn_id: string;
  source_hash: string;
  input_json: string;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type RemoteLease = {
  job_id: string;
  type: string;
  lease_token: string;
  input_json: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SessionActivity = {
  session_id: string;
  latest_turn_id: string | null;
  last_activity_at: string;
  quiet_until: string;
  processing_state: string;
  generation: number;
};

export function openDatabase() {
  const path = resolve(dataDirectory(), "partner-report.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = WAL;
    pragma foreign_keys = ON;
    create table if not exists hook_outbox (
      id integer primary key autoincrement,
      event_name text not null,
      session_id text,
      turn_id text,
      cwd text,
      model text,
      created_at text not null,
      processed_at text
    );
    create table if not exists state (
      key text primary key,
      value text not null,
      updated_at text not null
    );
    create table if not exists session_activity (
      session_id text primary key,
      latest_turn_id text,
      cwd text,
      model text,
      last_event_name text not null,
      last_activity_at text not null,
      quiet_until text not null,
      processing_state text not null,
      generation integer not null default 1,
      updated_at text not null
    );
    create index if not exists session_activity_due_idx on session_activity(processing_state, quiet_until);
    create table if not exists session_inventory (
      session_id text primary key,
      cwd text,
      project_id text,
      status text not null,
      reason_code text,
      observed_at text not null,
      updated_at text not null
    );
    create table if not exists session_cursors (
      session_id text primary key,
      last_turn_id text not null,
      source_revision integer not null,
      source_hash text not null,
      updated_at text not null
    );
    create table if not exists local_jobs (
      id text primary key,
      type text not null,
      status text not null,
      session_id text not null,
      source_revision integer not null,
      from_turn_id text not null,
      to_turn_id text not null,
      source_hash text not null,
      input_json text not null,
      result_json text,
      error_code text,
      attempts integer not null default 0,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists local_jobs_status_idx on local_jobs(status, created_at);
    create table if not exists pending_batches (
      id text primary key,
      payload_json text not null,
      status text not null,
      attempts integer not null default 0,
      error_code text,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists remote_leases (
      job_id text primary key,
      type text not null,
      lease_token text not null,
      input_json text not null,
      status text not null,
      created_at text not null,
      updated_at text not null
    );
    pragma user_version = 2;
  `);
  chmodSync(path, 0o600);
  return db;
}

export function setState(db: DatabaseSync, key: string, value: string) {
  const now = new Date().toISOString();
  db.prepare(
    `insert into state (key, value, updated_at) values (?, ?, ?) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

export function getState(db: DatabaseSync, key: string) {
  const row = db.prepare("select value from state where key = ?").get(key) as
    { value?: string } | undefined;
  return row?.value ?? null;
}

export function listLocalJobs(db: DatabaseSync, statuses: string[]) {
  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `select * from local_jobs where status in (${placeholders}) order by created_at asc`,
    )
    .all(...statuses) as unknown as LocalJob[];
}

export function pendingLocalCount(db: DatabaseSync) {
  const row = db
    .prepare(
      "select count(*) as count from local_jobs where status not in ('SYNCED', 'CANCELLED')",
    )
    .get() as { count: number };
  return Number(row.count);
}

export function activitySummary(db: DatabaseSync) {
  const counts = db
    .prepare(
      `
    select
      sum(case when processing_state in ('DIRTY', 'QUIET_WAIT') then 1 else 0 end) as dirty,
      sum(case when processing_state in ('PENDING_EXTRACT', 'EXTRACTING') then 1 else 0 end) as extracting,
      min(case when processing_state in ('DIRTY', 'QUIET_WAIT') then quiet_until end) as next_due_at,
      max(last_activity_at) as last_activity_at
    from session_activity
  `,
    )
    .get() as {
    dirty: number | null;
    extracting: number | null;
    next_due_at: string | null;
    last_activity_at: string | null;
  };
  return {
    dirtySessions: Number(counts.dirty ?? 0),
    extractingSessions: Number(counts.extracting ?? 0),
    nextDueAt: counts.next_due_at,
    lastHookAt: getState(db, "last_hook_at"),
  };
}

export function retryCount(db: DatabaseSync) {
  const jobs = db
    .prepare(
      "select coalesce(sum(attempts), 0) as count from local_jobs where status not in ('SYNCED', 'CANCELLED')",
    )
    .get() as { count: number };
  const batches = db
    .prepare(
      "select coalesce(sum(attempts), 0) as count from pending_batches where status != 'COMPLETED'",
    )
    .get() as { count: number };
  return Number(jobs.count) + Number(batches.count);
}

export function cleanupLocalData(
  db: DatabaseSync,
  now = Date.now(),
  retentionDays = 30,
) {
  const boundedRetentionDays = Number.isFinite(retentionDays)
    ? Math.max(1, Math.min(Math.floor(retentionDays), 365))
    : 30;
  const historyCutoff = new Date(
    now - boundedRetentionDays * 24 * 60 * 60_000,
  ).toISOString();
  const hookCutoff = new Date(
    now - Math.min(7, boundedRetentionDays) * 24 * 60 * 60_000,
  ).toISOString();
  const hooks = db
    .prepare(
      "delete from hook_outbox where processed_at is not null and processed_at < ?",
    )
    .run(hookCutoff);
  const localJobs = db
    .prepare(
      "delete from local_jobs where status in ('SYNCED', 'CANCELLED') and updated_at < ?",
    )
    .run(historyCutoff);
  const batches = db
    .prepare(
      "delete from pending_batches where status = 'COMPLETED' and updated_at < ?",
    )
    .run(historyCutoff);
  const leases = db
    .prepare(
      "delete from remote_leases where status in ('COMPLETED', 'FAILED', 'EXPIRED') and updated_at < ?",
    )
    .run(historyCutoff);
  db.exec("pragma optimize;");
  return {
    hooks: Number(hooks.changes),
    localJobs: Number(localJobs.changes),
    batches: Number(batches.changes),
    leases: Number(leases.changes),
    historyCutoff,
  };
}
