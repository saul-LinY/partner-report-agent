import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { processNextGenerationJob } from "./generation.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

suite("durable model retry scheduling", () => {
  const tenant = randomUUID();
  const team = randomUUID();
  beforeAll(async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://synthetic-model.test";
    await sql`insert into tenants (id, name) values (${tenant}, 'Model Retry Tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Model Retry Tests')`;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await sql`delete from agent_jobs where tenant_id = ${tenant}`;
  });
  afterAll(async () => {
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_BASE_URL;
    await sql`delete from teams where id = ${team}`;
    await sql`delete from tenants where id = ${tenant}`;
  });
  async function createJob(
    type = "SYSTEM_HEALTH_GENERATION",
    payload: unknown = {},
    maxAttempts = 4,
  ) {
    const id = randomUUID();
    await sql`insert into agent_jobs (id, tenant_id, team_id, type, idempotency_key, input_payload, max_attempts)
      values (${id}, ${tenant}, ${team}, ${type}, ${id}, ${JSON.stringify(payload)}::jsonb, ${maxAttempts})`;
    return id;
  }

  it("persists Retry-After, skips premature retries, and clears errors on recovery", async () => {
    const id = await createJob();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>busy</html>", {
            status: 503,
            headers: { "retry-after": "600" },
          }),
      ),
    );
    expect(await processNextGenerationJob(tenant)).toMatchObject({
      jobId: id,
      failed: true,
    });
    const [failed] =
      await sql`select *, extract(epoch from next_retry_at - updated_at) as delay from agent_jobs where id = ${id}`;
    expect(failed).toMatchObject({
      status: "RETRY_WAIT",
      attempt_count: 1,
      error_code: "MODEL_SERVICE_UNAVAILABLE",
    });
    expect(Number(failed!.delay)).toBeGreaterThanOrEqual(600);
    await sql`update agent_jobs set updated_at = now() - interval '1 day' where id = ${id}`;
    expect(await processNextGenerationJob(tenant)).toEqual({
      processed: false,
    });
    await sql`update agent_jobs set next_retry_at = now() - interval '1 second' where id = ${id}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(JSON.parse(String(init.body)).max_output_tokens).toBe(4096);
        return new Response(JSON.stringify({ output_text: '{"ok":true}' }));
      }),
    );
    expect(await processNextGenerationJob(tenant)).toMatchObject({
      jobId: id,
      processed: true,
    });
    const [completed] = await sql`select * from agent_jobs where id = ${id}`;
    expect(completed).toMatchObject({
      status: "COMPLETED",
      attempt_count: 2,
      error_code: null,
      error_message: null,
      next_retry_at: null,
      lease_until: null,
    });
  });

  it("increases queue delays after repeated transient failures and stops at the attempt limit", async () => {
    const id = await createJob("SYSTEM_HEALTH_GENERATION", {}, 3);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("busy", {
            status: 503,
            headers: { "retry-after": "11" },
          }),
      ),
    );
    for (const attempt of [1, 2, 3]) {
      expect(await processNextGenerationJob(tenant)).toMatchObject({
        jobId: id,
        failed: true,
      });
      const [row] =
        await sql`select *, extract(epoch from next_retry_at - updated_at) as delay from agent_jobs where id = ${id}`;
      expect(row!.attempt_count).toBe(attempt);
      if (attempt < 3) {
        expect(row!.status).toBe("RETRY_WAIT");
        expect(Number(row!.delay)).toBeGreaterThanOrEqual(
          60 * 2 ** (attempt - 1),
        );
        expect(Number(row!.delay)).toBeLessThan(75 * 2 ** (attempt - 1));
        await sql`update agent_jobs set next_retry_at = now() - interval '1 second' where id = ${id}`;
      } else {
        expect(row).toMatchObject({ status: "FAILED", next_retry_at: null });
        expect(await processNextGenerationJob(tenant)).toEqual({
          processed: false,
        });
      }
    }
  });

  it("stops retrying invalid credentials immediately", async () => {
    const id = await createJob();
    const fetchMock = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await processNextGenerationJob(tenant);
    const [row] = await sql`select * from agent_jobs where id = ${id}`;
    expect(row).toMatchObject({
      status: "FAILED",
      attempt_count: 1,
      error_code: "MODEL_AUTH_FAILED",
      next_retry_at: null,
    });
    expect(await processNextGenerationJob(tenant)).toEqual({
      processed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still picks up legacy retry jobs without a scheduled time", async () => {
    const id = await createJob("SYSTEM_HEALTH_QUEUE");
    await sql`update agent_jobs set status = 'RETRY_WAIT', updated_at = now() - interval '2 minutes' where id = ${id}`;
    expect(await processNextGenerationJob(tenant)).toMatchObject({
      jobId: id,
      processed: true,
    });
  });

  it("leases enough time for every bounded project batch", async () => {
    const projectBuckets = ["a", "b", "c", "d", "e"].map((projectKey) => ({
      projectKey,
    }));
    const id = await createJob("AGGREGATE_WORK_ITEMS", {
      projectBuckets,
      reviewId: randomUUID(),
    });
    const fetchMock = vi.fn(async () => {
      const [row] =
        await sql`select extract(epoch from lease_until - updated_at) as lease_seconds from agent_jobs where id = ${id}`;
      expect(Number(row!.lease_seconds)).toBe(3 * 2 * 240 + 60);
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await processNextGenerationJob(tenant);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leases time for all weekly project batches and the final summary", async () => {
    const id = await createJob("GENERATE_TEAM_REPORT", {
      workCards: [
        {
          partnerId: randomUUID(),
          snapshotId: randomUUID(),
          workItems: ["a", "b", "c", "d", "e"].map((projectKey) => ({
            projectKey,
            title: projectKey,
          })),
        },
      ],
    });
    const fetchMock = vi.fn(async () => {
      const [row] =
        await sql`select extract(epoch from lease_until - updated_at) as lease_seconds from agent_jobs where id = ${id}`;
      expect(Number(row!.lease_seconds)).toBe((3 + 1) * 240 + 60);
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await processNextGenerationJob(tenant);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
