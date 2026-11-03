import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInspection, sqlClient as sql } from "@partner-report/db";
import { sha256 } from "../common.js";
import { signSessionToken } from "../auth-security.js";
import { buildApp } from "../server.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

type Fixture = {
  tenant: string;
  team: string;
  user: string;
  partner: string;
  instance: string;
  binding: string;
  device: string;
  token: string;
};

suite("inspection runs and admin endpoints", () => {
  const ids = (): Fixture => ({
    tenant: randomUUID(),
    team: randomUUID(),
    user: randomUUID(),
    partner: randomUUID(),
    instance: randomUUID(),
    binding: randomUUID(),
    device: randomUUID(),
    token: randomUUID(),
  });
  const a = ids();
  const b = ids();
  let app: FastifyInstance;
  const cookie = (token: string) => ({
    cookie: `pra_session=${signSessionToken(token, process.env.SESSION_SECRET?.trim())}`,
  });

  async function seed(x: Fixture, name: string) {
    await sql`insert into tenants (id,name) values (${x.tenant},${name})`;
    await sql`insert into teams (id,tenant_id,name) values (${x.team},${x.tenant},${name})`;
    await sql`insert into users (id,email,display_name,password_hash) values (${x.user},${`${x.user}@test.local`},'Admin','test-only')`;
    await sql`insert into memberships (id,tenant_id,team_id,user_id,roles) values (${randomUUID()},${x.tenant},${x.team},${x.user},'["admin"]'::jsonb)`;
    await sql`insert into web_sessions (id,user_id,token_hash,expires_at) values (${randomUUID()},${x.user},${sha256(x.token)},now()+interval '1 day')`;
    await sql`insert into partners (id,tenant_id,team_id,email,display_name) values (${x.partner},${x.tenant},${x.team},${`${x.partner}@test.local`},${`成员-${name}`})`;
    await sql`insert into plugin_instances (id,tenant_id,team_id,partner_id,device_name,version,access_token_hash,refresh_token_hash,access_expires_at)
      values (${x.instance},${x.tenant},${x.team},${x.partner},'Legacy','2',${sha256(randomUUID())},${sha256(randomUUID())},now()+interval '1 day')`;
    await sql`insert into plugin_binding_codes (id,tenant_id,team_id,partner_id,code_hash,code_prefix,plugin_instance_id,created_by,status)
      values (${x.binding},${x.tenant},${x.team},${x.partner},${sha256(randomUUID())},'PR-INSP',${x.instance},${x.user},'claimed')`;
    await sql`insert into collector_devices (id,tenant_id,team_id,partner_id,scope_instance_id,binding_code_id,device_name,version,token_hash,last_log_at)
      values (${x.device},${x.tenant},${x.team},${x.partner},${x.instance},${x.binding},'Test Mac','1.0',${sha256(randomUUID())},now()-interval '40 minutes')`;
  }

  async function cleanup(x: Fixture) {
    await sql`delete from agent_jobs where tenant_id=${x.tenant}`;
    await sql`delete from inspection_findings where tenant_id=${x.tenant}`;
    await sql`delete from inspection_runs where tenant_id=${x.tenant}`;
    await sql`delete from audit_events where tenant_id=${x.tenant}`;
    await sql`delete from collector_logs where device_id=${x.device}`;
    await sql`delete from collector_devices where tenant_id=${x.tenant}`;
    await sql`delete from plugin_binding_codes where tenant_id=${x.tenant}`;
    await sql`delete from plugin_instances where tenant_id=${x.tenant}`;
    await sql`delete from partners where tenant_id=${x.tenant}`;
    await sql`delete from web_sessions where user_id=${x.user}`;
    await sql`delete from memberships where tenant_id=${x.tenant}`;
    await sql`delete from users where id=${x.user}`;
    await sql`delete from teams where id=${x.team}`;
    await sql`delete from tenants where id=${x.tenant}`;
  }

  beforeAll(async () => {
    await seed(a, "Inspection A");
    await seed(b, "Inspection B");
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app?.close();
    await cleanup(a);
    await cleanup(b);
  });

  const heartbeatFinding = () =>
    sql`select * from inspection_findings where tenant_id=${a.tenant} and rule='app.heartbeat'`;

  it("opens a finding, re-detects it, then resolves it once the device logs again", async () => {
    const first = await runInspection(sql, { tenantId: a.tenant, teamId: a.team, trigger: "manual" });
    const [opened] = await heartbeatFinding();
    expect(first.opened).toContain(opened!.id);
    expect(first.run.finishedAt).toBeTruthy();
    expect(opened).toMatchObject({
      status: "open",
      severity: "critical",
      occurrences: 1,
      subject: `device:${a.device}`,
      partner_id: a.partner,
      analysis_status: "none",
    });
    expect(opened!.evidence).toMatchObject({ deviceId: a.device, partnerId: a.partner });

    const second = await runInspection(sql, { tenantId: a.tenant, teamId: a.team, trigger: "schedule" });
    expect(second.opened).toEqual([]);
    expect(second.escalated).toEqual([]);
    const [redetected] = await heartbeatFinding();
    expect(redetected).toMatchObject({ id: opened!.id, status: "open", occurrences: 2 });

    await sql`update collector_devices set last_log_at=now() where id=${a.device}`;
    const third = await runInspection(sql, { tenantId: a.tenant, teamId: a.team, trigger: "schedule" });
    expect(third.resolvedCount).toBeGreaterThanOrEqual(1);
    const [resolved] = await heartbeatFinding();
    expect(resolved).toMatchObject({ status: "resolved" });
    expect(resolved!.resolved_at).toBeTruthy();

    await sql`update collector_devices set last_log_at=now()-interval '10 minutes' where id=${a.device}`;
    const fourth = await runInspection(sql, { tenantId: a.tenant, teamId: a.team, trigger: "schedule" });
    expect(fourth.opened).toEqual([opened!.id]);
    const [reopened] = await heartbeatFinding();
    expect(reopened).toMatchObject({ status: "open", severity: "warning", resolved_at: null });

    await sql`update collector_devices set last_log_at=now()-interval '40 minutes' where id=${a.device}`;
    const fifth = await runInspection(sql, { tenantId: a.tenant, teamId: a.team, trigger: "schedule" });
    expect(fifth.escalated).toEqual([opened!.id]);
  });

  it("refuses a second concurrent run for the same team", async () => {
    const [stuck] = await sql`insert into inspection_runs (id,tenant_id,team_id,trigger) values (${randomUUID()},${a.tenant},${a.team},'manual') returning id`;
    const response = await app.inject({ method: "POST", url: "/v1/admin/inspection/run", headers: cookie(a.token) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "INSPECTION_RUNNING" });
    const list = await app.inject({ method: "GET", url: "/v1/admin/inspection", headers: cookie(a.token) });
    expect(list.json().running).toBe(true);
    await sql`update inspection_runs set finished_at=now() where id=${stuck!.id}`;
    const ok = await app.inject({ method: "POST", url: "/v1/admin/inspection/run", headers: cookie(a.token) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, run: { trigger: "manual" } });
  });

  it("lists findings with summary, members and queues analysis idempotently", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/admin/inspection?chain=app", headers: cookie(a.token) });
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json();
    expect(body.summary.open.app.critical).toBeGreaterThanOrEqual(1);
    expect(body.summary.openTotal).toBeGreaterThanOrEqual(1);
    expect(body.members).toEqual([{ id: a.partner, name: "成员-Inspection A" }]);
    expect(body.lastRun).toMatchObject({ trigger: "manual" });
    const finding = body.findings.find((f: { rule: string }) => f.rule === "app.heartbeat");
    expect(finding).toMatchObject({
      chain: "app",
      partnerId: a.partner,
      analysisStatus: "none",
      analysisError: null,
      jobs: [],
    });

    const analyze = await app.inject({ method: "POST", url: `/v1/admin/inspection/findings/${finding.id}/analyze`, headers: cookie(a.token) });
    expect(analyze.statusCode, analyze.body).toBe(200);
    expect(analyze.json()).toEqual({ ok: true, analysisStatus: "queued" });
    const again = await app.inject({ method: "POST", url: `/v1/admin/inspection/findings/${finding.id}/analyze`, headers: cookie(a.token) });
    expect(again.statusCode).toBe(200);
    const jobs = await sql`select input_payload from agent_jobs where tenant_id=${a.tenant} and type='ANALYZE_INSPECTION_FINDING' and input_payload->>'findingId'=${finding.id} and status='PENDING'`;
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]!.input_payload)).not.toMatch(/\/Users\//);
  });

  it("surfaces a failed analysis job's error code and live job status", async () => {
    const [finding] = await heartbeatFinding();
    const jobId = randomUUID();
    await sql`insert into agent_jobs (id,tenant_id,team_id,type,status,idempotency_key,input_payload,error_code,error_message)
      values (${jobId},${a.tenant},${a.team},'EXTRACT_COLLECTOR_SESSION','FAILED',${jobId},'{}'::jsonb,'MODEL_AUTH_FAILED','x')`;
    await sql`update inspection_findings set analysis_status='failed', evidence=evidence || ${JSON.stringify({ jobIds: [jobId] })}::jsonb where id=${finding!.id}`;
    await sql`update agent_jobs set status='FAILED', error_code='MODEL_NOT_CONFIGURED', error_message='中台尚未配置可用的模型服务。'
      where id=(select id from agent_jobs where tenant_id=${a.tenant} and type='ANALYZE_INSPECTION_FINDING' and input_payload->>'findingId'=${finding!.id} order by created_at desc limit 1)`;
    const list = await app.inject({ method: "GET", url: "/v1/admin/inspection", headers: cookie(a.token) });
    const row = list.json().findings.find((f: { id: string }) => f.id === finding!.id);
    expect(row.analysisError).toEqual({ code: "MODEL_NOT_CONFIGURED", message: "中台尚未配置可用的模型服务。" });
    expect(row.jobs).toEqual([
      expect.objectContaining({ id: jobId, type: "EXTRACT_COLLECTOR_SESSION", status: "FAILED", errorCode: "MODEL_AUTH_FAILED" }),
    ]);
  });

  it("keeps tenants isolated and requires an admin", async () => {
    const [finding] = await heartbeatFinding();
    const other = await app.inject({ method: "GET", url: "/v1/admin/inspection", headers: cookie(b.token) });
    expect(other.statusCode).toBe(200);
    expect(other.json().findings).toEqual([]);
    expect(other.json().members).toEqual([{ id: b.partner, name: "成员-Inspection B" }]);
    const analyze = await app.inject({ method: "POST", url: `/v1/admin/inspection/findings/${finding!.id}/analyze`, headers: cookie(b.token) });
    expect(analyze.statusCode).toBe(404);
    const anonymous = await app.inject({ method: "GET", url: "/v1/admin/inspection" });
    expect(anonymous.statusCode).toBe(401);
    expect(await sql`select 1 from inspection_findings where tenant_id=${b.tenant}`).toEqual([]);
  });
});
