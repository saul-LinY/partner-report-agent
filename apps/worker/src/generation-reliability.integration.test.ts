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
import { recoverGatewayFailures } from "./model-recovery.js";

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
    const projectBuckets = Array.from({ length: 13 }, (_, i) => ({
      projectKey: `p${i}`,
    }));
    const id = await createJob("AGGREGATE_WORK_ITEMS", {
      projectBuckets,
      reviewId: randomUUID(),
    });
    const leases: number[] = [];
    const fetchMock = vi.fn(async () => {
      const [row] =
        await sql`select extract(epoch from lease_until - updated_at) as lease_seconds from agent_jobs where id = ${id}`;
      leases.push(Number(row!.lease_seconds));
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await processNextGenerationJob(tenant);
    // 13 projects at 4 per batch = 4 batches, 2 stages, and a fallback chain budget of 2 timeouts.
    expect(leases[0]).toBe(4 * 2 * 2 * 240 + 60);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("leases time for all weekly project batches and the final summary", async () => {
    const id = await createJob("GENERATE_TEAM_REPORT", {
      workCards: [
        {
          partnerId: randomUUID(),
          snapshotId: randomUUID(),
          workItems: Array.from({ length: 13 }, (_, i) => ({
            projectKey: `p${i}`,
            title: `p${i}`,
          })),
        },
      ],
    });
    const leases: number[] = [];
    const fetchMock = vi.fn(async () => {
      const [row] =
        await sql`select extract(epoch from lease_until - updated_at) as lease_seconds from agent_jobs where id = ${id}`;
      leases.push(Number(row!.lease_seconds));
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await processNextGenerationJob(tenant);
    // 13 projects at 4 per batch = 4 batches, plus the final summary.
    expect(leases[0]).toBe((4 + 1) * 2 * 240 + 60);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("requeues gateway-caused failures once a probe of the team model succeeds, and nothing else", async () => {
    const start = Date.now();
    const failed = async (
      code: string,
      type = "EXTRACT_COLLECTOR_SESSION",
      attempts = 1,
    ) => {
      const id = await createJob(type, {}, 3);
      await sql`update agent_jobs set status = 'FAILED', error_code = ${code}, attempt_count = ${attempts} where id = ${id}`;
      return id;
    };
    const auth = await failed("MODEL_AUTH_FAILED");
    const missing = await failed("MODEL_NOT_FOUND", "AGGREGATE_WORK_ITEMS");
    const rejected = await failed("MODEL_REQUEST_REJECTED");
    const cutOff = await failed("MODEL_OUTPUT_TOKEN_LIMIT");
    const exhausted = await failed(
      "MODEL_AUTH_FAILED",
      "EXTRACT_COLLECTOR_SESSION",
      12,
    );
    const status = async () =>
      Object.fromEntries(
        (
          await sql<{ id: string; status: string; max_attempts: number }[]>`
          select id, status, max_attempts from agent_jobs where tenant_id = ${tenant}`
        ).map((row) => [row.id, row]),
      );

    // The gateway still refuses: nothing moves.
    const refused = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", refused);
    expect(await recoverGatewayFailures(tenant, start)).toBe(0);
    expect(refused).toHaveBeenCalledTimes(1);
    // Probes are throttled to one per five minutes per team.
    expect(await recoverGatewayFailures(tenant, start + 60_000)).toBe(0);
    expect(refused).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ output_text: '{"ok":true}' })),
      ),
    );
    expect(await recoverGatewayFailures(tenant, start + 10 * 60_000)).toBe(2);
    const after = await status();
    expect(after[auth]).toMatchObject({ status: "PENDING", max_attempts: 4 });
    expect(after[missing]!.status).toBe("PENDING");
    // Input-specific and size failures need a different fix; a job retried this often waits for a person.
    for (const id of [rejected, cutOff, exhausted])
      expect(after[id]!.status).toBe("FAILED");
  });
});
