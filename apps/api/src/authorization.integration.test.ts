import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { buildApp } from "./server.js";
import { createProjectScopeBackup } from "./project-scope-backup.js";

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
    currentPeriodA: randomUUID(),
    reviewA: randomUUID(),
    projectA: randomUUID(),
    workItemA: randomUUID(),
    pluginA: randomUUID(),
    projectScopeAllowedA: randomUUID(),
    projectScopePendingA: randomUUID(),
    retryJobA: randomUUID(),
    clearJobA: randomUUID(),
    completedGenerationJobA: randomUUID(),
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
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenantA}, 'Fixture Tenant A'), (${fixture.tenantB}, 'Fixture Tenant B')`;
      await tx`insert into teams (id, tenant_id, name, timezone, report_type) values (${fixture.teamA}, ${fixture.tenantA}, 'Fixture Team A', 'Asia/Shanghai', 'test'), (${fixture.teamB}, ${fixture.tenantB}, 'Fixture Team B', 'Asia/Shanghai', 'test')`;
      await tx`insert into users (id, email, display_name, password_hash) values (${fixture.userA}, ${`fixture-a-${fixture.userA}@local.test`}, 'Fixture A', 'not-used'), (${fixture.userB}, ${`fixture-b-${fixture.userB}@local.test`}, 'Fixture B', 'not-used')`;
      await tx`insert into partners (id, tenant_id, team_id, user_id, email, display_name) values (${fixture.partnerA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.userA}, ${`fixture-a-${fixture.userA}@local.test`}, 'Fixture A'), (${fixture.partnerB}, ${fixture.tenantB}, ${fixture.teamB}, ${fixture.userB}, ${`fixture-b-${fixture.userB}@local.test`}, 'Fixture B')`;
      await tx`insert into memberships (id, tenant_id, team_id, user_id, partner_id, roles) values (${fixture.membershipA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.userA}, ${fixture.partnerA}, '["admin","partner"]'::jsonb)`;
      await tx`insert into web_sessions (id, user_id, token_hash, expires_at) values (${fixture.sessionA}, ${fixture.userA}, ${createHash("sha256").update(token).digest("hex")}, ${new Date(Date.now() + 3_600_000).toISOString()})`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone, status) values (${fixture.periodA}, ${fixture.tenantA}, ${fixture.teamA}, 'fixture-period-a', '2020-08-01T00:00:00Z', '2020-08-08T00:00:00Z', '2020-08-08T00:00:00Z', '2020-08-10T02:00:00Z', 'Asia/Shanghai', 'closed')`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone, status) values (${fixture.currentPeriodA}, ${fixture.tenantA}, ${fixture.teamA}, 'fixture-current-a', '2030-08-01T00:00:00Z', '2030-08-08T00:00:00Z', '2030-08-08T00:00:00Z', '2030-08-10T02:00:00Z', 'Asia/Shanghai', 'open')`;
      await tx`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state) values (${fixture.reviewA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.periodA}, 'ITEMS_APPROVED')`;
      await tx`insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids) values (${fixture.projectA}, ${fixture.tenantA}, ${fixture.teamA}, 'Fixture Project A', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
      await tx`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, fact_ids, payload) values (${fixture.workItemA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.periodA}, ${fixture.reviewA}, ${fixture.projectA}, 'Direct progress item', 'completed', '[]'::jsonb, '{"summary":"Visible in data platform","outcomes":["Done"],"blockers":[],"nextSteps":[],"importance":{"partnerEmphasis":3}}'::jsonb)`;
      await tx`insert into plugin_instances (id, tenant_id, team_id, partner_id, device_name, version, access_token_hash, refresh_token_hash, access_expires_at) values (${fixture.pluginA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'Fixture Laptop', '0.1.0', ${createHash("sha256").update(pluginToken).digest("hex")}, ${createHash("sha256").update(`refresh-${fixture.pluginA}`).digest("hex")}, ${new Date(Date.now() + 3_600_000).toISOString()})`;
      await tx`insert into project_scope_policies (plugin_instance_id, tenant_id, team_id, partner_id, version, initialized, initialized_at) values (${fixture.pluginA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 3, true, now())`;
      await tx`insert into project_scope_entries (id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key, display_name, status, effective_from, first_seen_period_key, session_count) values (${fixture.projectScopeAllowedA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, ${"a".repeat(64)}, 'Allowed Fixture Project', 'allowed', now(), 'fixture-current-a', 4), (${fixture.projectScopePendingA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, ${"b".repeat(64)}, 'Pending Fixture Project', 'pending', null, 'fixture-current-a', 2)`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, plugin_instance_id, type, status, idempotency_key, input_payload, attempt_count, max_attempts, error_code, error_message) values (${fixture.retryJobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, 'RESCAN_SESSIONS', 'FAILED', ${`fixture:${fixture.retryJobA}`}, '{}'::jsonb, 3, 3, 'SCAN_FAILED', 'Fixture scan failed')`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, type, status, idempotency_key, input_payload, attempt_count, max_attempts, error_code, error_message) values (${fixture.clearJobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'GENERATE_TEAM_REPORT', 'RETRY_WAIT', ${`fixture:${fixture.clearJobA}`}, '{}'::jsonb, 1, 3, 'CENTRAL_GENERATION_FAILED', 'Fixture generation failed')`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, type, status, idempotency_key, input_payload, completed_at) values (${fixture.completedGenerationJobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'AGGREGATE_WORK_ITEMS', 'COMPLETED', ${`fixture:${fixture.completedGenerationJobA}`}, '{}'::jsonb, now())`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone) values (${fixture.periodB}, ${fixture.tenantB}, ${fixture.teamB}, 'fixture-period', '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z', '2026-08-10T02:00:00Z', 'Asia/Shanghai')`;
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
      await tx`delete from outbox_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from audit_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from agent_jobs where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from team_report_versions where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from team_reports where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from plugin_diagnostic_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from coverage_snapshots where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from sync_batches where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from session_facts where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from session_records where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from collection_runs where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from project_scope_backup_snapshots where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from project_scope_entries where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from project_scope_policies where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from plugin_instances where tenant_id = ${fixture.tenantA} and id != ${fixture.pluginA}`;
      await tx`delete from plugin_instances where id = ${fixture.pluginA}`;
      await tx`delete from work_item_versions where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from work_items where id = ${fixture.workItemA}`;
      await tx`delete from reviews where id in (${fixture.reviewA}, ${fixture.reviewB})`;
      await tx`delete from report_periods where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from projects where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from memberships where id = ${fixture.membershipA}`;
      await tx`delete from partners where id in (${fixture.partnerA}, ${fixture.partnerB})`;
      await tx`delete from users where id in (${fixture.userA}, ${fixture.userB})`;
      await tx`delete from teams where id in (${fixture.teamA}, ${fixture.teamB})`;
      await tx`delete from tenants where id in (${fixture.tenantA}, ${fixture.tenantB})`;
    });
  });

  const headers = { cookie: `pra_session=${token}` };

  it("removes a Partner and revokes its bound device and binding code", async () => {
    const partnerId = randomUUID();
    const pluginId = randomUUID();
    const bindingCodeId = randomUUID();
    const pluginAccessToken = `removed-partner-${pluginId}`;
    const bindingCode = `PR-REMOVE-${bindingCodeId}`.toUpperCase();
    const email = `removed-${partnerId}@local.test`;
    try {
      await sql.begin(async (tx) => {
        await tx`
          insert into partners (id, tenant_id, team_id, email, display_name)
          values (${partnerId}, ${fixture.tenantA}, ${fixture.teamA}, ${email}, 'Removed Partner')
        `;
        await tx`
          insert into plugin_instances (
            id, tenant_id, team_id, partner_id, device_name, version,
            access_token_hash, refresh_token_hash, access_expires_at
          ) values (
            ${pluginId}, ${fixture.tenantA}, ${fixture.teamA}, ${partnerId},
            'removed-device', '0.4.0',
            ${createHash("sha256").update(pluginAccessToken).digest("hex")},
            ${createHash("sha256").update(`refresh-${pluginId}`).digest("hex")},
            now() + interval '1 hour'
          )
        `;
        await tx`
          insert into plugin_binding_codes (
            id, tenant_id, team_id, partner_id, code_hash, code_value,
            code_prefix, label, created_by
          ) values (
            ${bindingCodeId}, ${fixture.tenantA}, ${fixture.teamA}, ${partnerId},
            ${createHash("sha256").update(bindingCode).digest("hex")},
            ${bindingCode}, 'PR-REMOVE', 'Removed fixture', ${fixture.userA}
          )
        `;
      });

      const removed = await app.inject({
        method: "DELETE",
        url: `/v1/admin/partners/${partnerId}`,
        headers,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({
        ok: true,
        partnerId,
        revokedPluginCount: 1,
        revokedBindingCodeCount: 1,
      });
      const state = await sql<any[]>`
        select p.status as partner_status, pi.status as plugin_status,
          pbc.status as binding_code_status
        from partners p
        join plugin_instances pi on pi.partner_id = p.id
        join plugin_binding_codes pbc on pbc.partner_id = p.id
        where p.id = ${partnerId} and p.tenant_id = ${fixture.tenantA}
      `;
      expect(state).toEqual([
        {
          partner_status: "suspended",
          plugin_status: "revoked",
          binding_code_status: "revoked",
        },
      ]);
      const overview = await app.inject({
        method: "GET",
        url: "/v1/admin/overview",
        headers,
      });
      expect(
        overview
          .json()
          .connections.some(
            (connection: any) => connection.partnerId === partnerId,
          ),
      ).toBe(false);
    } finally {
      await sql`delete from plugin_binding_codes where partner_id = ${partnerId}`;
      await sql`delete from plugin_instances where partner_id = ${partnerId}`;
      await sql`delete from partners where id = ${partnerId}`;
    }
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

  it("lets an Admin rename a Partner with a normalized display name", async () => {
    const partnerId = randomUUID();
    try {
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (
          ${partnerId}, ${fixture.tenantA}, ${fixture.teamA},
          ${`rename-${partnerId}@local.test`}, 'Original Name'
        )
      `;
      const renamed = await app.inject({
        method: "PATCH",
        url: `/v1/admin/partners/${partnerId}`,
        headers,
        payload: { displayName: "  Updated Name  " },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().display_name).toBe("Updated Name");

      const invalid = await app.inject({
        method: "PATCH",
        url: `/v1/admin/partners/${partnerId}`,
        headers,
        payload: { displayName: "   " },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await sql`delete from audit_events where target_id = ${partnerId}`;
      await sql`delete from partners where id = ${partnerId}`;
    }
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

  it("lets an Admin inspect only safe project permissions in the current team", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/partners/${fixture.partnerA}/project-scopes`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      partner: {
        id: fixture.partnerA,
        displayName: "Fixture A",
      },
      summary: { total: 2, allowed: 1, pending: 1, denied: 0 },
      instances: expect.arrayContaining([
        expect.objectContaining({
          id: fixture.pluginA,
          deviceName: "Fixture Laptop",
          policyVersion: 3,
          initialized: true,
          projects: [
            expect.objectContaining({
              name: "Pending Fixture Project",
              permission: "pending",
              sessionCount: 2,
            }),
            expect.objectContaining({
              name: "Allowed Fixture Project",
              permission: "allowed",
              sessionCount: 4,
            }),
          ],
        }),
      ]),
    });
    expect(response.body).not.toContain("a".repeat(64));
    expect(response.body).not.toContain("b".repeat(64));
    expect(response.body).not.toContain("scopeKey");
    expect(response.body).not.toContain("localRoot");

    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/admin/partners/${fixture.partnerB}/project-scopes`,
      headers,
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it("lets an Admin preview the latest protected permission backup", async () => {
    const snapshot = await createProjectScopeBackup(
      {
        tenantId: fixture.tenantA,
        teamId: fixture.teamA,
        partnerId: fixture.partnerA,
        pluginInstanceId: fixture.pluginA,
      },
      "manual_test",
    );
    expect(snapshot).not.toBeNull();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/project-scope-backups/latest",
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        summary: { total: 2, allowed: 1, pending: 1, denied: 0 },
        plugins: [
          {
            partnerName: "Fixture A",
            deviceName: "Fixture Laptop",
            reason: "manual_test",
            summary: { total: 2, allowed: 1, pending: 1, denied: 0 },
            projects: expect.arrayContaining([
              expect.objectContaining({
                name: "Allowed Fixture Project",
                permission: "allowed",
              }),
              expect.objectContaining({
                name: "Pending Fixture Project",
                permission: "pending",
              }),
            ]),
          },
        ],
      });
      expect(response.body).not.toContain("a".repeat(64));
      expect(response.body).not.toContain("b".repeat(64));
      expect(response.body).not.toContain("scopeKey");
      expect(response.body).not.toContain("pluginInstanceId");
    } finally {
      if (snapshot)
        await sql`
          delete from project_scope_backup_snapshots
          where id = ${snapshot.id}
        `;
    }
  });

  it("lets an Admin request completed permissions be reviewed in the App", async () => {
    await sql.begin(async (tx) => {
      await tx`
        update project_scope_entries set status = 'denied', effective_from = null
        where id = ${fixture.projectScopePendingA}
      `;
      await tx`
        update project_scope_policies set version = 4, initialized = true,
          initialized_at = now()
        where plugin_instance_id = ${fixture.pluginA}
      `;
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/admin/plugin-instances/${fixture.pluginA}/project-scopes/reapproval`,
        headers,
        payload: { baseVersion: 4 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "reapproval_requested",
        version: 5,
        pending: 2,
      });
      const scopes = await sql<
        Array<{ status: string; effective_from: Date | null }>
      >`
        select status, effective_from from project_scope_entries
        where plugin_instance_id = ${fixture.pluginA}
        order by display_name
      `;
      expect(scopes).toEqual([
        { status: "pending", effective_from: null },
        { status: "pending", effective_from: null },
      ]);
    } finally {
      await sql.begin(async (tx) => {
        await tx`
          update project_scope_entries set
            status = case
              when id = ${fixture.projectScopeAllowedA} then 'allowed'
              else 'pending'
            end,
            effective_from = case
              when id = ${fixture.projectScopeAllowedA} then now()
              else null
            end
          where id in (${fixture.projectScopeAllowedA}, ${fixture.projectScopePendingA})
        `;
        await tx`
          update project_scope_policies set version = 3, initialized = true,
            initialized_at = now()
          where plugin_instance_id = ${fixture.pluginA}
        `;
        await tx`
          delete from outbox_events
          where aggregate_id = ${fixture.pluginA}
            and payload->>'reason' = 'admin_reapproval'
        `;
      });
    }
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

  it("shows failed job context and lets an Admin retry it", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/v1/admin/agent-jobs?status=FAILED",
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContainEqual(
      expect.objectContaining({
        id: fixture.retryJobA,
        partner_name: "Fixture A",
        plugin_device_name: "Fixture Laptop",
        error_code: "SCAN_FAILED",
        error_message: "Fixture scan failed",
      }),
    );

    const retry = await app.inject({
      method: "POST",
      url: `/v1/admin/agent-jobs/${fixture.retryJobA}/retry`,
      headers,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      id: fixture.retryJobA,
      status: "PENDING",
      attempt_count: 3,
      max_attempts: 6,
    });

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/admin/agent-jobs/${fixture.retryJobA}/retry`,
      headers,
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().code).toBe("JOB_NOT_RETRYABLE");

    const crossTenant = await app.inject({
      method: "POST",
      url: `/v1/admin/agent-jobs/${fixture.jobB}/retry`,
      headers,
    });
    expect(crossTenant.statusCode).toBe(404);

    const clear = await app.inject({
      method: "POST",
      url: `/v1/admin/agent-jobs/${fixture.clearJobA}/clear`,
      headers,
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toMatchObject({
      id: fixture.clearJobA,
      status: "CANCELLED",
      error_code: "CENTRAL_GENERATION_FAILED",
      error_message: "Fixture generation failed",
    });

    const repeatedClear = await app.inject({
      method: "POST",
      url: `/v1/admin/agent-jobs/${fixture.clearJobA}/clear`,
      headers,
    });
    expect(repeatedClear.statusCode).toBe(409);
    expect(repeatedClear.json().code).toBe("JOB_NOT_CLEARABLE");
  });

  it("counts completed generation jobs in system monitoring", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/system-monitoring",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().components).toContainEqual(
      expect.objectContaining({
        key: "generation",
        detail: expect.stringContaining("过去 24 小时完成 1 个生成任务"),
      }),
    );
  });

  it("shows isolated central logs and queues model analysis for one execution", async () => {
    const recent = await app.inject({
      method: "GET",
      url: "/v1/admin/system-logs",
      headers,
    });
    expect(recent.statusCode).toBe(200);
    expect(recent.json().window).toMatchObject({
      mode: "recent",
      date: null,
      timezone: "Asia/Shanghai",
    });
    const executionIds = recent
      .json()
      .executions.map((item: any) => item.executionId);
    expect(executionIds).toContain(`job:${fixture.retryJobA}`);
    expect(executionIds).not.toContain(`job:${fixture.jobB}`);

    const analyze = await app.inject({
      method: "POST",
      url: "/v1/admin/system-logs/analyze",
      headers,
      payload: { executionId: `job:${fixture.retryJobA}` },
    });
    expect(analyze.statusCode).toBe(200);
    expect(analyze.json()).toMatchObject({
      ok: true,
      job: { status: "PENDING" },
    });
    const analysisRows = await sql<
      Array<{ type: string; input_payload: { executionId: string } }>
    >`
      select type, input_payload from agent_jobs
      where tenant_id = ${fixture.tenantA} and team_id = ${fixture.teamA}
        and type = 'ANALYZE_SYSTEM_LOGS'
        and input_payload->>'executionId' = ${`job:${fixture.retryJobA}`}
    `;
    expect(analysisRows).toEqual([
      {
        type: "ANALYZE_SYSTEM_LOGS",
        input_payload: expect.objectContaining({
          executionId: `job:${fixture.retryJobA}`,
        }),
      },
    ]);

    const crossTenant = await app.inject({
      method: "POST",
      url: "/v1/admin/system-logs/analyze",
      headers,
      payload: { executionId: `job:${fixture.jobB}` },
    });
    expect(crossTenant.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/admin/system-logs?date=2026-02-31",
      headers,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("versions and atomically locks an Admin-reviewed Team Report", async () => {
    const reportId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`
        insert into team_reports (
          id, tenant_id, team_id, period_id, status, current_version
        ) values (
          ${reportId}, ${fixture.tenantA}, ${fixture.teamA},
          ${fixture.currentPeriodA}, 'TEAM_DRAFT', 1
        )
      `;
      await tx`
        insert into team_report_versions (
          id, tenant_id, report_id, version, title, summary, markdown,
          payload, source_checksum, generator_version
        ) values (
          ${randomUUID()}, ${fixture.tenantA}, ${reportId}, 1,
          'Fixture Team Report', 'Fixture summary', '# Fixture Team Report',
          '{"missingPartnerIds":[],"qualityWarnings":[],"projectProgress":[{"progress":"Stale baseline"}]}'::jsonb,
          'fixture-team-source', 'synthetic-test/1.0'
        )
      `;
    });
    const list = await app.inject({
      method: "GET",
      url: "/v1/admin/team-reports",
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContainEqual(
      expect.objectContaining({ id: reportId, status: "TEAM_DRAFT" }),
    );
    const edited = await app.inject({
      method: "PATCH",
      url: `/v1/admin/team-reports/${reportId}`,
      headers,
      payload: {
        baseVersion: 1,
        title: "Edited Team Report",
        summary: "Admin reviewed synthetic summary",
        markdown: "# Edited Team Report\n\nReviewed.",
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toEqual({ version: 2 });
    const [editedVersion] = await sql<any[]>`
      select payload from team_report_versions where report_id = ${reportId} and version = 2
    `;
    expect(editedVersion.payload).not.toHaveProperty("projectProgress");
    expect(editedVersion.payload.markdown).toBe(
      "# Edited Team Report\n\nReviewed.",
    );
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/admin/team-reports/${reportId}/submit`,
      headers,
      payload: { baseVersion: 2 },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ ok: true, version: 2 });
    const [reports, periods] = await Promise.all([
      sql<
        any[]
      >`select status, current_version from team_reports where id = ${reportId}`,
      sql<
        any[]
      >`select status from report_periods where id = ${fixture.currentPeriodA}`,
    ]);
    expect(reports).toEqual([{ status: "LOCKED", current_version: 2 }]);
    expect(periods).toEqual([{ status: "completed" }]);
    const archive = await app.inject({
      method: "GET",
      url: "/v1/admin/report-archive",
      headers,
    });
    expect(archive.statusCode).toBe(200);
    expect(
      archive
        .json()
        .periods.find((period: any) => period.id === fixture.currentPeriodA),
    ).toMatchObject({
      periodKey: "fixture-current-a",
      teamReport: {
        id: reportId,
        version: 2,
        title: "Edited Team Report",
        summary: "Admin reviewed synthetic summary",
      },
    });
  });

  it("generates a Team Report on demand from the selected period", async () => {
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const snapshotId = randomUUID();
    let teamReportId = "";
    await sql.begin(async (tx) => {
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone, status
        ) values (
          ${periodId}, ${fixture.tenantA}, ${fixture.teamA}, ${`manual-team-${periodId}`},
          '2022-08-01T00:00:00Z', '2022-08-08T00:00:00Z',
          '2022-08-08T00:00:00Z', '2022-08-08T00:00:00Z',
          'Asia/Shanghai', 'facts_frozen'
        )
      `;
      await tx`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state
        ) values (
          ${reviewId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${periodId}, 'ITEMS_APPROVED'
        )
      `;
      await tx`
        insert into work_item_snapshots (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          review_version, checksum, payload, approved_by, approved_at
        ) values (
          ${snapshotId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${periodId}, ${reviewId}, 1, 'manual-team-source',
          '{"workItems":[],"coverage":{}}'::jsonb, ${fixture.userA}, now()
        )
      `;
    });

    try {
      const generated = await app.inject({
        method: "POST",
        url: "/v1/admin/team-reports/generate",
        headers,
        payload: { periodId },
      });
      expect(generated.statusCode).toBe(200);
      expect(generated.json()).toMatchObject({
        reportId: expect.any(String),
        queued: true,
        workCardSnapshotCount: 1,
        missingPartnerIds: [],
      });
      teamReportId = generated.json().reportId;

      const jobs = await sql<any[]>`
        select type, input_payload from agent_jobs
        where tenant_id = ${fixture.tenantA}
          and input_payload->>'reportId' = ${teamReportId}
      `;
      expect(jobs).toMatchObject([
        {
          type: "GENERATE_TEAM_REPORT",
          input_payload: {
            workCards: [{ snapshotId }],
            missingPartnerIds: [],
          },
        },
      ]);
      expect(jobs[0].input_payload.previousTeamReport).toBeNull();
      expect(jobs[0].input_payload).not.toHaveProperty("projects");

      const repeated = await app.inject({
        method: "POST",
        url: "/v1/admin/team-reports/generate",
        headers,
        payload: { periodId },
      });
      expect(repeated.statusCode).toBe(409);
      expect(repeated.json()).toMatchObject({ code: "TEAM_REPORT_EXISTS" });
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from agent_jobs where tenant_id = ${fixture.tenantA} and input_payload->>'reportId' = ${teamReportId || null}`;
        await tx`delete from team_reports where id = ${teamReportId || null}`;
        await tx`delete from work_item_snapshots where id = ${snapshotId}`;
        await tx`delete from reviews where id = ${reviewId}`;
        await tx`delete from report_periods where id = ${periodId}`;
      });
    }
  });

  it("regenerates a locked Team Report while keeping its current version visible", async () => {
    const periodId = randomUUID();
    const reportId = randomUUID();
    const sourceJobId = randomUUID();
    try {
      await sql.begin(async (tx) => {
        await tx`
          insert into report_periods (
            id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
            submission_deadline_at, timezone, status
          ) values (
            ${periodId}, ${fixture.tenantA}, ${fixture.teamA}, ${`regenerate-${periodId}`},
            '2023-08-01T00:00:00Z', '2023-08-08T00:00:00Z',
            '2023-08-08T00:00:00Z', '2023-08-08T00:00:00Z',
            'Asia/Shanghai', 'completed'
          )
        `;
        await tx`
          insert into team_reports (
            id, tenant_id, team_id, period_id, status, current_version,
            generated_at, locked_at
          ) values (
            ${reportId}, ${fixture.tenantA}, ${fixture.teamA}, ${periodId},
            'LOCKED', 1, now(), now()
          )
        `;
        await tx`
          insert into team_report_versions (
            id, tenant_id, report_id, version, title, summary, markdown,
            payload, source_checksum, generator_version
          ) values (
            ${randomUUID()}, ${fixture.tenantA}, ${reportId}, 1,
            'Locked Team Report', 'Locked summary', '# Locked Team Report',
            '{"missingPartnerIds":[],"qualityWarnings":[]}'::jsonb,
            'locked-source', 'synthetic-test/1.0'
          )
        `;
        await tx`
          insert into agent_jobs (
            id, tenant_id, team_id, partner_id, type, status,
            idempotency_key, input_payload, completed_at
          ) values (
            ${sourceJobId}, ${fixture.tenantA}, ${fixture.teamA}, null,
            'GENERATE_TEAM_REPORT', 'COMPLETED', ${`fixture:${sourceJobId}`},
            ${JSON.stringify({
              reportId,
              sourceChecksum: "locked-source",
              workCards: [
                {
                  partnerId: fixture.partnerA,
                  partnerName: "Fixture A",
                  snapshotId: randomUUID(),
                  workItems: [{ title: "Fixture Project" }],
                  projectDescriptions: ["Should be removed"],
                  noReportableActivity: false,
                },
              ],
              missingPartnerIds: [],
              previousTeamReport: null,
            })}::jsonb,
            now()
          )
        `;
      });

      const regenerated = await app.inject({
        method: "POST",
        url: `/v1/admin/team-reports/${reportId}/regenerate`,
        headers,
        payload: { instructions: "Use the current report structure." },
      });
      expect(regenerated.statusCode).toBe(200);
      expect(regenerated.json()).toEqual({ jobId: expect.any(String) });

      const [reports, jobs] = await Promise.all([
        sql<any[]>`
          select status, current_version from team_reports where id = ${reportId}
        `,
        sql<any[]>`
          select input_payload from agent_jobs
          where id = ${regenerated.json().jobId}
        `,
      ]);
      expect(reports).toEqual([{ status: "LOCKED", current_version: 1 }]);
      expect(jobs[0].input_payload.workCards).toMatchObject([
        {
          partnerName: "Fixture A",
          projectNames: ["Fixture Project"],
        },
      ]);
      expect(jobs[0].input_payload.workCards[0]).not.toHaveProperty(
        "projectDescriptions",
      );

      const duplicate = await app.inject({
        method: "POST",
        url: `/v1/admin/team-reports/${reportId}/regenerate`,
        headers,
        payload: {},
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        code: "TEAM_REPORT_REGENERATION_IN_PROGRESS",
      });
    } finally {
      await sql`delete from agent_jobs where tenant_id = ${fixture.tenantA} and input_payload->>'reportId' = ${reportId}`;
      await sql`delete from team_report_versions where report_id = ${reportId}`;
      await sql`delete from team_reports where id = ${reportId}`;
      await sql`delete from report_periods where id = ${periodId}`;
    }
  });

  it("creates a new immutable Work Card snapshot after reopening", async () => {
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    const coverageId = randomUUID();
    let firstSnapshotId = "";

    await sql.begin(async (tx) => {
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone, status
        ) values (
          ${periodId}, ${fixture.tenantA}, ${fixture.teamA}, ${`replacement-${periodId}`},
          '2021-08-01T00:00:00Z', '2021-08-08T00:00:00Z',
          '2021-08-08T00:00:00Z', '2021-08-10T02:00:00Z',
          'Asia/Shanghai', 'facts_frozen'
        )
      `;
      await tx`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state,
          approved_count, pending_count
        ) values (
          ${reviewId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${periodId}, 'IN_PROGRESS', 1, 0
        )
      `;
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${workItemId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${periodId}, ${reviewId}, 'Replacement work card', 'in_progress',
          'approved', '[]'::jsonb, '{"overview":"第一次确认。"}'::jsonb
        )
      `;
      await tx`
        insert into coverage_snapshots (
          id, tenant_id, team_id, partner_id, period_id, payload
        ) values (
          ${coverageId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${periodId}, '{"discovered":1,"extracted":1}'::jsonb
        )
      `;
    });

    try {
      const first = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/complete`,
        headers,
        payload: { baseVersion: 1 },
      });
      expect(first.statusCode).toBe(200);
      firstSnapshotId = first.json().snapshotId;
      expect(firstSnapshotId).toEqual(expect.any(String));
      const reopened = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/reopen`,
        headers,
        payload: { baseVersion: 1 },
      });
      expect(reopened.statusCode).toBe(200);

      await sql`
        update work_items set payload = '{"overview":"第二次确认。"}'::jsonb
        where id = ${workItemId}
      `;
      const second = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/complete`,
        headers,
        payload: { baseVersion: 2 },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().snapshotId).toEqual(expect.any(String));
      expect(second.json().snapshotId).not.toBe(firstSnapshotId);

      const snapshots = await sql<any[]>`
        select id, payload from work_item_snapshots
        where tenant_id = ${fixture.tenantA} and review_id = ${reviewId}
        order by created_at, id
      `;
      expect(snapshots).toHaveLength(2);
      expect(
        snapshots.map(
          (snapshot) => snapshot.payload.workItems[0].payload.overview,
        ),
      ).toEqual(["第一次确认。", "第二次确认。"]);
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from work_item_snapshots where review_id = ${reviewId}`;
        await tx`delete from work_items where review_id = ${reviewId}`;
        await tx`delete from coverage_snapshots where id = ${coverageId}`;
        await tx`delete from reviews where id = ${reviewId}`;
        await tx`delete from report_periods where id = ${periodId}`;
      });
    }
  });

  it("freezes the approved Work Cards after the final decision", async () => {
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    const coverageId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, pending_count
        ) values (
          ${reviewId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, 'IN_PROGRESS', 1
        )
      `;
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${workItemId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, ${reviewId}, ${fixture.projectA},
          '自动完成工作卡片审核', 'in_progress', 'pending', '[]'::jsonb,
          '{"overview":"最后一张工作卡片完成审核。","dailyProgress":[]}'::jsonb
        )
      `;
      await tx`
        insert into coverage_snapshots (
          id, tenant_id, team_id, partner_id, period_id, payload
        ) values (
          ${coverageId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, '{"discovered":1,"extracted":1}'::jsonb
        )
      `;
    });

    try {
      const decision = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/items/${workItemId}/decision`,
        headers,
        payload: { decision: "approve", baseVersion: 1 },
      });
      expect(decision.statusCode).toBe(200);
      expect(decision.json()).toMatchObject({
        version: 2,
        snapshotId: expect.any(String),
      });
      expect(decision.json()).not.toHaveProperty("reportId");
      const snapshots = await sql<any[]>`
          select payload from work_item_snapshots
          where id = ${decision.json().snapshotId}
      `;
      expect(snapshots[0].payload.workItems[0]).toMatchObject({
        id: workItemId,
        title: "自动完成工作卡片审核",
        status: "in_progress",
        review_status: "approved",
        payload: {
          overview: "最后一张工作卡片完成审核。",
        },
      });
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from work_item_snapshots where review_id = ${reviewId}`;
        await tx`delete from coverage_snapshots where id = ${coverageId}`;
        await tx`delete from work_items where id = ${workItemId}`;
        await tx`delete from reviews where id = ${reviewId}`;
      });
    }
  });

  it("keeps the final Work Card pending when completed evidence is missing", async () => {
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, pending_count
        ) values (
          ${reviewId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, 'IN_PROGRESS', 1
        )
      `;
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${workItemId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, ${reviewId}, ${fixture.projectA},
          '缺少完成结果', 'completed', 'pending', '[]'::jsonb,
          '{"overview":"只有进展，没有完成结果。","dailyProgress":[]}'::jsonb
        )
      `;
    });

    try {
      const decision = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/items/${workItemId}/decision`,
        headers,
        payload: { decision: "approve", baseVersion: 1 },
      });
      expect(decision.statusCode).toBe(409);
      expect(decision.json()).toMatchObject({
        code: "COMPLETION_EVIDENCE_REQUIRED",
      });
      const [reviews, items] = await Promise.all([
        sql<
          Array<{
            state: string;
            version: number;
            pending_count: number;
            approved_count: number;
          }>
        >`
          select state, version, pending_count, approved_count
          from reviews where id = ${reviewId}
        `,
        sql<Array<{ review_status: string }>>`
          select review_status from work_items where id = ${workItemId}
        `,
      ]);
      expect(reviews).toEqual([
        {
          state: "IN_PROGRESS",
          version: 1,
          pending_count: 1,
          approved_count: 0,
        },
      ]);
      expect(items).toEqual([{ review_status: "pending" }]);
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from work_items where id = ${workItemId}`;
        await tx`delete from reviews where id = ${reviewId}`;
      });
    }
  });

  it("rolls back a Web approval when completed evidence is missing", async () => {
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    let changeId: string | null = null;
    await sql.begin(async (tx) => {
      await tx`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, pending_count
        ) values (
          ${reviewId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, 'IN_PROGRESS', 1
        )
      `;
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${workItemId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.currentPeriodA}, ${reviewId}, ${fixture.projectA},
          'Web 缺少完成结果', 'completed', 'pending', '[]'::jsonb,
          '{"overview":"只有进展，没有完成结果。","dailyProgress":[]}'::jsonb
        )
      `;
    });

    try {
      const preview = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/changes/preview`,
        headers,
        payload: {
          workItemIds: [workItemId],
          baseVersion: 1,
          operation: "approve",
          source: "web",
        },
      });
      expect(preview.statusCode).toBe(200);
      changeId = preview.json().changeId;
      const applied = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/changes/apply`,
        headers,
        payload: { changeId },
      });
      expect(applied.statusCode).toBe(409);
      expect(applied.json()).toMatchObject({
        code: "COMPLETION_EVIDENCE_REQUIRED",
      });
      const [reviews, items] = await Promise.all([
        sql<
          Array<{
            version: number;
            pending_count: number;
            approved_count: number;
          }>
        >`
          select version, pending_count, approved_count
          from reviews where id = ${reviewId}
        `,
        sql<Array<{ review_status: string }>>`
          select review_status from work_items where id = ${workItemId}
        `,
      ]);
      expect(reviews).toEqual([
        { version: 1, pending_count: 1, approved_count: 0 },
      ]);
      expect(items).toEqual([{ review_status: "pending" }]);
    } finally {
      await sql.begin(async (tx) => {
        if (changeId)
          await tx`delete from review_changes where id = ${changeId}`;
        await tx`delete from work_items where id = ${workItemId}`;
        await tx`delete from reviews where id = ${reviewId}`;
      });
    }
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
});
