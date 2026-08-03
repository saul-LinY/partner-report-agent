import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { buildApp } from "./server.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("tenant and role authorization", () => {
  const fixture = {
    tenantA: randomUUID(),
    teamA: randomUUID(),
    userA: randomUUID(),
    partnerA: randomUUID(),
    membershipA: randomUUID(),
    sessionA: randomUUID(),
    periodA: randomUUID(),
    reviewA: randomUUID(),
    projectA: randomUUID(),
    workItemA: randomUUID(),
    pluginA: randomUUID(),
    bindingA: randomUUID(),
    jobA: randomUUID(),
    tenantB: randomUUID(),
    teamB: randomUUID(),
    userB: randomUUID(),
    partnerB: randomUUID(),
    periodB: randomUUID(),
    reviewB: randomUUID(),
    projectB: randomUUID(),
    jobB: randomUUID(),
  };
  const token = `tenant-isolation-${fixture.userA}`;
  const pluginToken = `plugin-idempotency-${fixture.pluginA}`;
  const bindingCode = `PR-TEST-${fixture.bindingA}`.toUpperCase();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenantA}, 'Fixture Tenant A'), (${fixture.tenantB}, 'Fixture Tenant B')`;
      await tx`insert into teams (id, tenant_id, name, timezone) values (${fixture.teamA}, ${fixture.tenantA}, 'Fixture Team A', 'Asia/Shanghai'), (${fixture.teamB}, ${fixture.tenantB}, 'Fixture Team B', 'Asia/Shanghai')`;
      await tx`insert into users (id, email, display_name, password_hash) values (${fixture.userA}, ${`fixture-a-${fixture.userA}@local.test`}, 'Fixture A', 'not-used'), (${fixture.userB}, ${`fixture-b-${fixture.userB}@local.test`}, 'Fixture B', 'not-used')`;
      await tx`insert into partners (id, tenant_id, team_id, user_id, email, display_name) values (${fixture.partnerA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.userA}, ${`fixture-a-${fixture.userA}@local.test`}, 'Fixture A'), (${fixture.partnerB}, ${fixture.tenantB}, ${fixture.teamB}, ${fixture.userB}, ${`fixture-b-${fixture.userB}@local.test`}, 'Fixture B')`;
      await tx`insert into memberships (id, tenant_id, team_id, user_id, partner_id, roles) values (${fixture.membershipA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.userA}, ${fixture.partnerA}, '["admin","partner"]'::jsonb)`;
      await tx`insert into web_sessions (id, user_id, token_hash, expires_at) values (${fixture.sessionA}, ${fixture.userA}, ${createHash("sha256").update(token).digest("hex")}, ${new Date(Date.now() + 3_600_000).toISOString()})`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, timezone, status) values (${fixture.periodA}, ${fixture.tenantA}, ${fixture.teamA}, 'fixture-period-a', '2020-08-01T00:00:00Z', '2020-08-08T00:00:00Z', '2020-08-08T00:00:00Z', 'Asia/Shanghai', 'closed')`;
      await tx`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state) values (${fixture.reviewA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.periodA}, 'ITEMS_APPROVED')`;
      await tx`insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids) values (${fixture.projectA}, ${fixture.tenantA}, ${fixture.teamA}, 'Fixture Project A', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
      await tx`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, fact_ids, payload) values (${fixture.workItemA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.periodA}, ${fixture.reviewA}, ${fixture.projectA}, 'Direct progress item', 'completed', '[]'::jsonb, '{"summary":"Visible in data platform","outcomes":["Done"],"blockers":[],"nextSteps":[],"importance":{"partnerEmphasis":3}}'::jsonb)`;
      await tx`insert into plugin_instances (id, tenant_id, team_id, partner_id, device_name, version, access_token_hash, refresh_token_hash, access_expires_at) values (${fixture.pluginA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'fixture-device', '0.1.0', ${createHash("sha256").update(pluginToken).digest("hex")}, ${createHash("sha256").update(`refresh-${fixture.pluginA}`).digest("hex")}, ${new Date(Date.now() + 3_600_000).toISOString()})`;
      await tx`insert into plugin_binding_codes (id, tenant_id, team_id, partner_id, code_hash, code_prefix, label, created_by) values (${fixture.bindingA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${createHash("sha256").update(bindingCode).digest("hex")}, 'PR-TEST', 'Fixture Codex', ${fixture.userA})`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, plugin_instance_id, type, status, idempotency_key, input_payload, output_payload, completed_at) values (${fixture.jobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, 'RESCAN_SESSIONS', 'COMPLETED', ${`fixture:${fixture.jobA}`}, '{}'::jsonb, '{"completed":true,"batchIds":[]}'::jsonb, now())`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, timezone) values (${fixture.periodB}, ${fixture.tenantB}, ${fixture.teamB}, 'fixture-period', '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z', 'Asia/Shanghai')`;
      await tx`insert into reviews (id, tenant_id, team_id, partner_id, period_id) values (${fixture.reviewB}, ${fixture.tenantB}, ${fixture.teamB}, ${fixture.partnerB}, ${fixture.periodB})`;
      await tx`insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids) values (${fixture.projectB}, ${fixture.tenantB}, ${fixture.teamB}, 'Tenant B Project', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, type, idempotency_key, input_payload) values (${fixture.jobB}, ${fixture.tenantB}, ${fixture.teamB}, ${fixture.partnerB}, 'RESCAN_SESSIONS', ${`fixture:${fixture.jobB}`}, '{}'::jsonb)`;
    });
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await sql.begin(async (tx) => {
      await tx`delete from web_sessions where id = ${fixture.sessionA}`;
      await tx`delete from audit_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from agent_jobs where id in (${fixture.jobA}, ${fixture.jobB})`;
      await tx`delete from plugin_binding_codes where id = ${fixture.bindingA}`;
      await tx`delete from plugin_instances where tenant_id = ${fixture.tenantA} and id != ${fixture.pluginA}`;
      await tx`delete from plugin_instances where id = ${fixture.pluginA}`;
      await tx`delete from work_items where id = ${fixture.workItemA}`;
      await tx`delete from reviews where id in (${fixture.reviewA}, ${fixture.reviewB})`;
      await tx`delete from report_periods where id in (${fixture.periodA}, ${fixture.periodB})`;
      await tx`delete from projects where id in (${fixture.projectA}, ${fixture.projectB})`;
      await tx`delete from memberships where id = ${fixture.membershipA}`;
      await tx`delete from partners where id in (${fixture.partnerA}, ${fixture.partnerB})`;
      await tx`delete from users where id in (${fixture.userA}, ${fixture.userB})`;
      await tx`delete from teams where id in (${fixture.teamA}, ${fixture.teamB})`;
      await tx`delete from tenants where id in (${fixture.tenantA}, ${fixture.tenantB})`;
    });
  });

  const headers = { cookie: `pra_session=${token}` };

  it("claims an Admin-issued binding code into the correct isolated Partner", async () => {
    const claim = await app.inject({
      method: "POST",
      url: "/v1/plugin-bindings/claim",
      payload: { bindingCode, deviceName: "Fixture Laptop", pluginVersion: "0.2.0" },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ partnerId: fixture.partnerA, pluginInstanceId: expect.any(String) });
    const policy = await app.inject({
      method: "GET",
      url: "/v1/plugin-bindings/me",
      headers: { authorization: `Bearer ${claim.json().accessToken}` },
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json().partnerId).toBe(fixture.partnerA);
    const reused = await app.inject({
      method: "POST",
      url: "/v1/plugin-bindings/claim",
      payload: { bindingCode, deviceName: "Second Device", pluginVersion: "0.2.0" },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().code).toBe("BINDING_CODE_INVALID");
  });

  it("keeps the latest closed period available for read-only Partner navigation", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/partner/dashboard",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().period.id).toBe(fixture.periodA);
    expect(response.json().review.id).toBe(fixture.reviewA);
  });

  it("returns project cards through the first-review workspace", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/reviews/${fixture.reviewA}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({
      id: fixture.workItemA,
      project_id: fixture.projectA,
      project_name: "Fixture Project A",
    });
  });

  it("does not expose another tenant's Partner review", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/reviews/${fixture.reviewB}`,
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("REVIEW_NOT_FOUND");
  });

  it("does not mutate another tenant's Admin resources", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/projects/${fixture.projectB}`,
      headers,
      payload: { name: "Cross tenant mutation" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not expose another tenant's task metadata", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/agent-jobs/${fixture.jobB}`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects writes after a Review leaves IN_PROGRESS", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/reviews/${fixture.reviewA}/changes/preview`,
      headers,
      payload: {
        workItemIds: [randomUUID()],
        baseVersion: 1,
        operation: "approve",
        source: "web",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("REVIEW_NOT_EDITABLE");
  });

  it("treats an identical repeated job completion as idempotent", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/agent-jobs/${fixture.jobA}/complete`,
      headers: {
        authorization: `Bearer ${pluginToken}`,
        "x-job-lease": "response-was-lost",
      },
      payload: { completed: true, batchIds: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, idempotent: true });

    const conflict = await app.inject({
      method: "POST",
      url: `/v1/agent-jobs/${fixture.jobA}/complete`,
      headers: {
        authorization: `Bearer ${pluginToken}`,
        "x-job-lease": "response-was-lost",
      },
      payload: { completed: true, batchIds: ["different"] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("JOB_ALREADY_COMPLETED");
  });
});
