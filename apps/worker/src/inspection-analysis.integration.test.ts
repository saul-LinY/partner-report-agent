import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { queueInspectionAnalysis, sqlClient as sql } from "@partner-report/db";
import { processNextGenerationJob } from "./generation.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

suite("inspection finding analysis job", () => {
  const tenant = randomUUID();
  const team = randomUUID();
  const findingId = randomUUID();
  const analysis = {
    summary: "App 已超过 30 分钟没有上报日志",
    likelyCause: "App 已退出或网络中断",
    impact: "该成员本期上传可能延迟",
    recommendedActions: ["联系成员确认 App 是否在运行"],
    confidence: "medium",
    relatedChain: "app",
  };
  const modelResponse = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify(body) })));

  beforeAll(async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://synthetic-model.test";
    await sql`insert into tenants (id, name) values (${tenant}, 'Inspection Analysis')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Inspection Analysis')`;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await sql`delete from agent_jobs where tenant_id = ${tenant}`;
    await sql`delete from inspection_findings where tenant_id = ${tenant}`;
    process.env.MODEL_API_KEY = "test-only-key";
  });
  afterAll(async () => {
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_BASE_URL;
    await sql`delete from teams where id = ${team}`;
    await sql`delete from tenants where id = ${tenant}`;
  });

  async function seedFinding() {
    await sql`insert into inspection_findings (id, tenant_id, team_id, fingerprint, chain, rule, severity, subject, title, evidence)
      values (${findingId}, ${tenant}, ${team}, ${`${team}:app.heartbeat:device:x`}, 'app', 'app.heartbeat', 'critical',
        'device:x', '成员的 App 已 40 分钟没有上报日志', '{"codes":["ALIVE"]}'::jsonb)`;
    return queueInspectionAnalysis(sql, { tenantId: tenant, teamId: team, findingId, reason: "detected", detectedAt: new Date() });
  }
  const finding = async () =>
    (await sql`select analysis, analysis_status, analyzed_fingerprint_at from inspection_findings where id = ${findingId}`)[0]!;

  it("queues the job idempotently with a sanitized payload and marks the finding queued", async () => {
    const detectedAt = new Date("2026-11-03T04:00:00.000Z");
    await sql`insert into inspection_findings (id, tenant_id, team_id, fingerprint, chain, rule, severity, subject, title)
      values (${findingId}, ${tenant}, ${team}, 'k', 'app', 'app.heartbeat', 'critical', 'device:x', 't')`;
    const input = { tenantId: tenant, teamId: team, findingId, reason: "detected", detectedAt } as const;
    const first = await queueInspectionAnalysis(sql, input);
    const second = await queueInspectionAnalysis(sql, input);
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    const jobs = await sql`select idempotency_key, input_payload from agent_jobs where tenant_id = ${tenant}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotency_key).toBe(`inspection-analysis:${findingId}:${detectedAt.toISOString()}`);
    expect(jobs[0]!.input_payload).toMatchObject({ findingId, rule: "app.heartbeat", events: [], jobs: [] });
    expect((await finding()).analysis_status).toBe("queued");
  });

  it("copies the validated model output into the finding on success", async () => {
    await seedFinding();
    const fetchMock = modelResponse(analysis);
    vi.stubGlobal("fetch", fetchMock);
    const result = await processNextGenerationJob(tenant);
    expect(result).toMatchObject({ processed: true, type: "ANALYZE_INSPECTION_FINDING" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await finding();
    expect(row.analysis_status).toBe("completed");
    expect(row.analysis).toEqual(analysis);
    expect(row.analyzed_fingerprint_at).toBeTruthy();
    const [job] = await sql`select status, output_payload from agent_jobs where tenant_id = ${tenant}`;
    expect(job).toMatchObject({ status: "COMPLETED", output_payload: analysis });
  });

  it("rejects output that does not match the strict schema and retries", async () => {
    await seedFinding();
    vi.stubGlobal("fetch", modelResponse({ ...analysis, extra: "x" }));
    expect(await processNextGenerationJob(tenant)).toMatchObject({ failed: true });
    const [job] = await sql`select status, error_code from agent_jobs where tenant_id = ${tenant}`;
    expect(job).toMatchObject({ status: "RETRY_WAIT", error_code: "MODEL_OUTPUT_SCHEMA_INVALID" });
    expect((await finding()).analysis_status).toBe("queued");
  });

  it("fails terminally with MODEL_NOT_CONFIGURED and marks the finding failed", async () => {
    await seedFinding();
    delete process.env.MODEL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(await processNextGenerationJob(tenant)).toMatchObject({ failed: true });
    const [job] = await sql`select status, error_code, error_message from agent_jobs where tenant_id = ${tenant}`;
    expect(job).toMatchObject({ status: "FAILED", error_code: "MODEL_NOT_CONFIGURED" });
    expect(job!.error_message).toContain("模型");
    expect((await finding()).analysis_status).toBe("failed");
  });
});
