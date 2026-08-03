import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cleanupLocalData } from "./database.js";

describe("local data retention", () => {
  it("removes only old completed records", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table hook_outbox (id integer primary key, processed_at text);
      create table local_jobs (id text primary key, status text, updated_at text);
      create table pending_batches (id text primary key, status text, updated_at text);
      create table remote_leases (job_id text primary key, status text, updated_at text);
    `);
    const old = "2026-06-01T00:00:00.000Z";
    const recent = "2026-08-02T00:00:00.000Z";
    db.prepare("insert into hook_outbox values (1, ?), (2, null)").run(old);
    db.prepare(
      "insert into local_jobs values ('synced-old', 'SYNCED', ?), ('retry-old', 'PENDING', ?), ('synced-new', 'SYNCED', ?)",
    ).run(old, old, recent);
    db.prepare(
      "insert into pending_batches values ('batch-old', 'COMPLETED', ?), ('batch-retry', 'RETRY', ?)",
    ).run(old, old);
    db.prepare(
      "insert into remote_leases values ('lease-old', 'COMPLETED', ?), ('lease-active', 'LEASED', ?)",
    ).run(old, old);

    const result = cleanupLocalData(
      db,
      new Date("2026-08-03T00:00:00.000Z").getTime(),
      30,
    );

    expect(result).toMatchObject({
      hooks: 1,
      localJobs: 1,
      batches: 1,
      leases: 1,
    });
    expect(db.prepare("select id from local_jobs order by id").all()).toEqual([
      { id: "retry-old" },
      { id: "synced-new" },
    ]);
    expect(db.prepare("select id from pending_batches").all()).toEqual([
      { id: "batch-retry" },
    ]);
    expect(db.prepare("select job_id from remote_leases").all()).toEqual([
      { job_id: "lease-active" },
    ]);
    db.close();
  });
});
