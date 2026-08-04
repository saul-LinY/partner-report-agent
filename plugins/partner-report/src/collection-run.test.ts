import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimCollectionRun,
  collectionDrainState,
  INITIAL_LOOKBACK_MS,
} from "./collection-run.js";

const databases: DatabaseSync[] = [];

function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    create table state (key text primary key, value text not null, updated_at text not null);
    create table local_jobs (id text primary key, status text not null, run_id text);
    create table pending_batches (id text primary key, status text not null);
    create table collection_runs (
      id text primary key, period_key text not null, status text not null,
      window_starts_at text not null, window_ends_at text not null,
      initial_lookback integer not null, invocation_deadline_at text not null,
      continuation_count integer not null default 0, lease_owner text,
      lease_expires_at text, created_at text not null, updated_at text not null
    );
  `);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("logical collection run", () => {
  it("starts with a rolling 24-hour window", () => {
    const db = database();
    const now = new Date("2026-08-04T04:00:00.000Z");
    const claimed = claimCollectionRun(db, "2026-W31", {
      now,
      owner: "run-a",
    });
    expect(claimed.status).toBe("running");
    expect(claimed.run.initial_lookback).toBe(1);
    expect(claimed.run.window_ends_at).toBe(now.toISOString());
    expect(new Date(claimed.run.window_starts_at).getTime()).toBe(
      now.getTime() - INITIAL_LOOKBACK_MS,
    );
  });

  it("blocks a concurrent owner and allows takeover after lease expiry", () => {
    const db = database();
    const now = new Date("2026-08-04T04:00:00.000Z");
    const first = claimCollectionRun(db, "2026-W31", {
      now,
      owner: "run-a",
    });
    const blocked = claimCollectionRun(db, "2026-W31", {
      now: new Date(now.getTime() + 60_000),
      owner: "run-b",
    });
    expect(blocked.status).toBe("already_running");
    const resumed = claimCollectionRun(db, "2026-W31", {
      now: new Date(now.getTime() + 13 * 60_000),
      owner: "run-b",
    });
    expect(resumed.status).toBe("running");
    expect(resumed.run.id).toBe(first.run.id);
    expect(resumed.run.lease_owner).toBe("run-b");
  });

  it("continues the next run from the last acknowledged window", () => {
    const db = database();
    const previousEnd = "2026-08-03T04:00:00.000Z";
    db.prepare(
      "insert into state values ('last_collection_window_end', ?, ?)",
    ).run(previousEnd, previousEnd);
    const claimed = claimCollectionRun(db, "2026-W31", {
      now: new Date("2026-08-06T04:00:00.000Z"),
      owner: "run-a",
    });
    expect(claimed.run.initial_lookback).toBe(0);
    expect(claimed.run.window_starts_at).toBe(previousEnd);
  });

  it("refuses completion while a local job or batch remains", () => {
    const db = database();
    db.exec(
      "insert into local_jobs values ('job', 'PENDING', null); insert into pending_batches values ('batch', 'RETRY');",
    );
    expect(collectionDrainState(db)).toEqual({
      pendingLocalJobs: 1,
      pendingBatches: 1,
      drained: false,
    });
    db.exec(
      "update local_jobs set status = 'SYNCED'; update pending_batches set status = 'COMPLETED';",
    );
    expect(collectionDrainState(db)).toEqual({
      pendingLocalJobs: 0,
      pendingBatches: 0,
      drained: true,
    });
  });

  it("drains a queue larger than one invocation without early completion", () => {
    const db = database();
    const insert = db.prepare(
      "insert into local_jobs (id, status, run_id) values (?, 'PENDING', 'large-run')",
    );
    for (let index = 0; index < 120; index += 1) {
      insert.run(`session-${String(index).padStart(3, "0")}`);
    }
    const drainOneInvocation = () => {
      const jobs = db
        .prepare(
          "select id from local_jobs where status = 'PENDING' order by id limit 50",
        )
        .all() as Array<{ id: string }>;
      const sync = db.prepare(
        "update local_jobs set status = 'SYNCED' where id = ?",
      );
      for (const job of jobs) sync.run(job.id);
      return jobs.length;
    };
    expect(drainOneInvocation()).toBe(50);
    expect(collectionDrainState(db)).toMatchObject({
      pendingLocalJobs: 70,
      drained: false,
    });
    expect(drainOneInvocation()).toBe(50);
    expect(collectionDrainState(db)).toMatchObject({
      pendingLocalJobs: 20,
      drained: false,
    });
    expect(drainOneInvocation()).toBe(20);
    expect(collectionDrainState(db)).toEqual({
      pendingLocalJobs: 0,
      pendingBatches: 0,
      drained: true,
    });
  });
});
