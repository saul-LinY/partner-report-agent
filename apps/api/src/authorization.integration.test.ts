import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { buildApp } from "./server.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;

async function waitForBlockedReportMutation() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await sql<Array<{ waiting: number }>>`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock' and query ilike '%individual_reports%'
    `;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a blocked individual report mutation");
}

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
    bindingA: randomUUID(),
    feishuBindingA: randomUUID(),
    feishuDeliveryA: randomUUID(),
    jobA: randomUUID(),
    retryJobA: randomUUID(),
    clearJobA: randomUUID(),
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
  const originalFeishuAppId = process.env.FEISHU_APP_ID;
  const feishuAppId = `cli_authorization_overview_${fixture.feishuBindingA}`;
  const feishuOpenId = `ou_authorization_${fixture.feishuBindingA}`;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.FEISHU_APP_ID = feishuAppId;
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
      await tx`insert into plugin_instances (id, tenant_id, team_id, partner_id, device_name, version, access_token_hash, refresh_token_hash, access_expires_at) values (${fixture.pluginA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'fixture-device', '0.1.0', ${createHash("sha256").update(pluginToken).digest("hex")}, ${createHash("sha256").update(`refresh-${fixture.pluginA}`).digest("hex")}, ${new Date(Date.now() + 3_600_000).toISOString()})`;
      await tx`insert into project_scope_policies (plugin_instance_id, tenant_id, team_id, partner_id, version, initialized, initialized_at) values (${fixture.pluginA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 3, true, now())`;
      await tx`insert into project_scope_entries (id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key, display_name, status, effective_from, first_seen_period_key, session_count) values (${fixture.projectScopeAllowedA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, ${"a".repeat(64)}, 'Allowed Fixture Project', 'allowed', now(), 'fixture-current-a', 4), (${fixture.projectScopePendingA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, ${"b".repeat(64)}, 'Pending Fixture Project', 'pending', null, 'fixture-current-a', 2)`;
      await tx`insert into plugin_binding_codes (id, tenant_id, team_id, partner_id, code_hash, code_value, code_prefix, label, created_by) values (${fixture.bindingA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${createHash("sha256").update(bindingCode).digest("hex")}, ${bindingCode}, 'PR-TEST', 'Fixture Codex', ${fixture.userA})`;
      await tx`insert into feishu_partner_bindings (id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at) values (${fixture.feishuBindingA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${feishuAppId}, ${feishuOpenId}, 'active', now())`;
      await tx`insert into feishu_deliveries (id, tenant_id, team_id, partner_id, kind, aggregate_type, aggregate_id, receive_id, receive_id_type, message_id, domain_version, status, idempotency_key, sent_at) values (${fixture.feishuDeliveryA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'review', 'review', ${fixture.reviewA}, ${feishuOpenId}, 'open_id', ${`om_${fixture.feishuDeliveryA}`}, 1, 'sent', ${`review:${feishuAppId}:${fixture.partnerA}:${fixture.reviewA}`}, now())`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, plugin_instance_id, type, status, idempotency_key, input_payload, output_payload, completed_at) values (${fixture.jobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, 'RESCAN_SESSIONS', 'COMPLETED', ${`fixture:${fixture.jobA}`}, '{}'::jsonb, '{"completed":true,"batchIds":[]}'::jsonb, now())`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, plugin_instance_id, type, status, idempotency_key, input_payload, attempt_count, max_attempts, error_code, error_message) values (${fixture.retryJobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, 'RESCAN_SESSIONS', 'FAILED', ${`fixture:${fixture.retryJobA}`}, '{}'::jsonb, 3, 3, 'SCAN_FAILED', 'Fixture scan failed')`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, type, status, idempotency_key, input_payload, attempt_count, max_attempts, error_code, error_message) values (${fixture.clearJobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'GENERATE_TEAM_REPORT', 'RETRY_WAIT', ${`fixture:${fixture.clearJobA}`}, '{}'::jsonb, 1, 3, 'CENTRAL_GENERATION_FAILED', 'Fixture generation failed')`;
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
      await tx`delete from audit_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from outbox_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from feishu_deliveries where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from feishu_partner_bindings where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from agent_jobs where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from team_report_versions where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from team_reports where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from plugin_binding_codes where id = ${fixture.bindingA}`;
      await tx`delete from plugin_diagnostic_events where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from coverage_snapshots where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from sync_batches where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from session_facts where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from session_records where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from collection_runs where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from project_scope_entries where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from project_scope_policies where tenant_id in (${fixture.tenantA}, ${fixture.tenantB})`;
      await tx`delete from plugin_instances where tenant_id = ${fixture.tenantA} and id != ${fixture.pluginA}`;
      await tx`delete from plugin_instances where id = ${fixture.pluginA}`;
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
    if (originalFeishuAppId === undefined) {
      delete process.env.FEISHU_APP_ID;
    } else {
      process.env.FEISHU_APP_ID = originalFeishuAppId;
    }
  });

  const headers = { cookie: `pra_session=${token}` };

  it("claims an Admin-issued binding code into the correct isolated Partner", async () => {
    const claim = await app.inject({
      method: "POST",
      url: "/v1/plugin-bindings/claim",
      payload: {
        bindingCode,
        deviceName: "Fixture Laptop",
        pluginVersion: "0.2.0",
      },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({
      partnerId: fixture.partnerA,
      pluginInstanceId: expect.any(String),
      challenge: expect.any(String),
      challengeExpiresAt: expect.any(String),
      connectivityStatus: "pending",
      capabilityVersion: "1.0",
    });
    const bindingEvents = await sql<any[]>`
      select aggregate_type, aggregate_id, payload
      from outbox_events
      where tenant_id = ${fixture.tenantA}
        and event_type = 'plugin.binding.claimed'
        and aggregate_id = ${fixture.partnerA}
    `;
    expect(bindingEvents).toEqual([
      {
        aggregate_type: "partner",
        aggregate_id: fixture.partnerA,
        payload: {
          teamId: fixture.teamA,
          partnerId: fixture.partnerA,
          pluginInstanceId: claim.json().pluginInstanceId,
        },
      },
    ]);
    const pluginHeaders = {
      authorization: `Bearer ${claim.json().accessToken}`,
    };
    const invalidConnectivity = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/connectivity-test",
      headers: pluginHeaders,
      payload: {
        challenge: "invalid-connectivity-challenge-123456",
        pluginVersion: "0.2.0",
        clientTime: new Date().toISOString(),
        capabilityVersion: "1.0",
      },
    });
    expect(invalidConnectivity.statusCode).toBe(400);
    expect(invalidConnectivity.json().code).toBe("CHALLENGE_INVALID");
    const connectivity = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/connectivity-test",
      headers: pluginHeaders,
      payload: {
        challenge: claim.json().challenge,
        pluginVersion: "0.2.0",
        clientTime: new Date().toISOString(),
        capabilityVersion: "1.0",
      },
    });
    expect(connectivity.statusCode).toBe(200);
    expect(connectivity.json()).toMatchObject({
      ok: true,
      connectivityStatus: "verified",
      alreadyVerified: false,
    });
    const repeatedConnectivity = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/connectivity-test",
      headers: pluginHeaders,
      payload: {
        challenge: claim.json().challenge,
        pluginVersion: "0.2.0",
        clientTime: new Date().toISOString(),
        capabilityVersion: "1.0",
      },
    });
    expect(repeatedConnectivity.statusCode).toBe(200);
    expect(repeatedConnectivity.json().alreadyVerified).toBe(true);
    const diagnosticEventId = randomUUID();
    const diagnosticEvent = {
      eventId: diagnosticEventId,
      stage: "sync",
      errorCode: "SYNC_FAILED",
      occurredAt: new Date().toISOString(),
      retryable: true,
    };
    const diagnostic = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/diagnostics",
      headers: pluginHeaders,
      payload: {
        events: [diagnosticEvent],
      },
    });
    expect(diagnostic.statusCode).toBe(200);
    expect(diagnostic.json()).toMatchObject({ accepted: 1, submitted: 1 });
    const repeatedDiagnostic = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/diagnostics",
      headers: pluginHeaders,
      payload: { events: [diagnosticEvent] },
    });
    expect(repeatedDiagnostic.statusCode).toBe(200);
    expect(repeatedDiagnostic.json()).toMatchObject({
      accepted: 0,
      submitted: 1,
    });
    const policy = await app.inject({
      method: "GET",
      url: "/v1/plugin-bindings/me",
      headers: pluginHeaders,
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json().partnerId).toBe(fixture.partnerA);
    const overview = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().connections).toContainEqual(
      expect.objectContaining({
        partnerId: fixture.partnerA,
        connectionState: "connected",
        deviceName: "Fixture Laptop",
        version: "0.2.0",
        feishu: expect.objectContaining({
          state: "connected",
          bindingState: "connected",
          deliveryState: "healthy",
          verifiedAt: expect.any(String),
          lastDeliveryKind: "review",
          lastDeliveryStatus: "sent",
        }),
      }),
    );
    expect(overview.json().bindingCodes).toContainEqual(
      expect.objectContaining({
        id: fixture.bindingA,
        code_value: bindingCode,
      }),
    );
    expect(overview.json().projects).toContainEqual({
      id: fixture.projectA,
      name: "Fixture Project A",
    });
    const reused = await app.inject({
      method: "POST",
      url: "/v1/plugin-bindings/claim",
      payload: {
        bindingCode,
        deviceName: "Second Device",
        pluginVersion: "0.2.0",
      },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().code).toBe("BINDING_CODE_INVALID");
  });

  it("recovers credentials on the same plugin instance and preserves project scope", async () => {
    const pluginInstanceId = randomUUID();
    const projectScopeId = randomUUID();
    let bindingId: string | null = null;
    await sql.begin(async (tx) => {
      await tx`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${pluginInstanceId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          'Recovery Device', '0.4.1', ${createHash("sha256").update(`old-access-${pluginInstanceId}`).digest("hex")},
          ${createHash("sha256").update(`old-refresh-${pluginInstanceId}`).digest("hex")},
          ${new Date(Date.now() - 60_000).toISOString()}
        )
      `;
      await tx`
        insert into project_scope_policies (
          plugin_instance_id, tenant_id, team_id, partner_id,
          version, initialized, initialized_at
        ) values (
          ${pluginInstanceId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          4, true, now()
        )
      `;
      await tx`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
          display_name, status, effective_from, first_seen_period_key, session_count
        ) values (
          ${projectScopeId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${pluginInstanceId}, ${"c".repeat(64)}, 'Preserved Recovery Project',
          'allowed', now(), 'fixture-current-a', 3
        )
      `;
    });

    try {
      const generated = await app.inject({
        method: "POST",
        url: `/v1/admin/partners/${fixture.partnerA}/binding-codes`,
        headers,
        payload: {
          label: "Recovery Code",
          pluginInstanceId,
        },
      });
      expect(generated.statusCode).toBe(200);
      bindingId = generated.json().id;
      expect(generated.json()).toMatchObject({
        recovery: true,
        code: expect.any(String),
      });

      const claimed = await app.inject({
        method: "POST",
        url: "/v1/plugin-bindings/claim",
        payload: {
          bindingCode: generated.json().code,
          deviceName: "Recovery Device",
          pluginVersion: "0.4.2",
        },
      });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json().pluginInstanceId).toBe(pluginInstanceId);

      const scopes = await sql<
        Array<{ status: string; policy_version: number; initialized: boolean }>
      >`
        select pse.status, psp.version as policy_version, psp.initialized
        from project_scope_entries pse
        join project_scope_policies psp
          on psp.plugin_instance_id = pse.plugin_instance_id
        where pse.plugin_instance_id = ${pluginInstanceId}
          and pse.id = ${projectScopeId}
      `;
      expect(scopes).toEqual([
        { status: "allowed", policy_version: 4, initialized: true },
      ]);

      const refreshToken = claimed.json().refreshToken as string;
      const refreshes = await Promise.all([
        app.inject({
          method: "POST",
          url: "/v1/plugin-bindings/refresh",
          payload: { refreshToken },
        }),
        app.inject({
          method: "POST",
          url: "/v1/plugin-bindings/refresh",
          payload: { refreshToken },
        }),
      ]);
      expect(refreshes.map((response) => response.statusCode).sort()).toEqual([
        200, 401,
      ]);
      const successfulRefresh = refreshes.find(
        (response) => response.statusCode === 200,
      )!;
      const followUp = await app.inject({
        method: "POST",
        url: "/v1/plugin-bindings/refresh",
        payload: { refreshToken: successfulRefresh.json().refreshToken },
      });
      expect(followUp.statusCode).toBe(200);

      const recoveryOutbox = await sql<Array<{ count: number }>>`
        select count(*)::int as count from outbox_events
        where tenant_id = ${fixture.tenantA}
          and event_type = 'plugin.binding.claimed'
          and payload->>'pluginInstanceId' = ${pluginInstanceId}
      `;
      expect(recoveryOutbox[0]?.count).toBe(0);
    } finally {
      await sql.begin(async (tx) => {
        if (bindingId) {
          await tx`delete from plugin_binding_codes where id = ${bindingId}`;
        }
        await tx`delete from project_scope_entries where plugin_instance_id = ${pluginInstanceId}`;
        await tx`delete from project_scope_policies where plugin_instance_id = ${pluginInstanceId}`;
        await tx`delete from audit_events where actor_id = ${pluginInstanceId} or target_id = ${bindingId}`;
        await tx`delete from plugin_instances where id = ${pluginInstanceId}`;
      });
    }
  });

  it("recovers an existing plugin through an approved device authorization", async () => {
    const pluginInstanceId = randomUUID();
    const policyEntryId = randomUUID();
    const deviceCode = `recovery-device-${randomUUID()}`;
    let authorizationId: string | null = null;
    await sql.begin(async (tx) => {
      await tx`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at,
          connectivity_status, connectivity_challenge_hash,
          connectivity_challenge_expires_at, connectivity_challenge_consumed_at
        ) values (
          ${pluginInstanceId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          'Recovery Self Service Device', '0.4.2', ${createHash("sha256").update("old-access").digest("hex")},
          ${createHash("sha256").update("old-refresh").digest("hex")}, now() - interval '1 hour',
          'verified', ${createHash("sha256").update("old-challenge").digest("hex")},
          now() + interval '5 minutes', now()
        )
      `;
      await tx`
        insert into project_scope_policies (
          plugin_instance_id, tenant_id, team_id, partner_id, version, initialized, initialized_at
        ) values (
          ${pluginInstanceId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          8, true, now()
        )
      `;
      await tx`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
          display_name, status, effective_from, first_seen_period_key, session_count
        ) values (
          ${policyEntryId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${pluginInstanceId}, ${"d".repeat(64)}, 'Self Service Preserved Project',
          'allowed', now(), 'fixture-current-a', 5
        )
      `;
    });

    try {
      const started = await app.inject({
        method: "POST",
        url: "/v1/plugin-bindings/recovery-authorizations",
        payload: {
          pluginInstanceId,
          deviceName: "Recovery Self Service Device",
          pluginVersion: "0.4.3",
          deviceCode,
        },
      });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ status: "pending" });
      const authorizations = await sql<Array<{ id: string }>>`
        select id from plugin_device_authorizations
        where plugin_instance_id = ${pluginInstanceId} and status = 'pending'
      `;
      authorizationId = authorizations[0]!.id;
      await sql`
        update plugin_device_authorizations set status = 'approved', approved_at = now()
        where id = ${authorizationId}
      `;

      const exchanged = await app.inject({
        method: "POST",
        url: "/v1/plugin-bindings/device-authorizations/token",
        payload: { deviceCode },
      });
      expect(exchanged.statusCode).toBe(200);
      expect(exchanged.json().pluginInstanceId).toBe(pluginInstanceId);
      const connectivity = await app.inject({
        method: "POST",
        url: "/v1/plugin-instances/me/connectivity-test",
        headers: { authorization: `Bearer ${exchanged.json().accessToken}` },
        payload: {
          challenge: exchanged.json().challenge,
          pluginVersion: "0.4.3",
          clientTime: new Date().toISOString(),
          capabilityVersion: "1.0",
        },
      });
      expect(connectivity.statusCode).toBe(200);
      const scopes = await sql<Array<{ status: string; version: number }>>`
        select pse.status, psp.version from project_scope_entries pse
        join project_scope_policies psp
          on psp.plugin_instance_id = pse.plugin_instance_id
        where pse.id = ${policyEntryId}
      `;
      expect(scopes).toEqual([{ status: "allowed", version: 8 }]);
    } finally {
      if (authorizationId)
        await sql`delete from feishu_deliveries where aggregate_id = ${authorizationId}`;
      await sql`delete from outbox_events where aggregate_id = ${authorizationId}`;
      await sql`delete from plugin_device_authorizations where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from project_scope_entries where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from project_scope_policies where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from audit_events where actor_id = ${pluginInstanceId}`;
      await sql`delete from plugin_instances where id = ${pluginInstanceId}`;
    }
  });

  it("queues Feishu binding after device authorization token exchange", async () => {
    const authorizationId = randomUUID();
    const deviceCode = `device-authorization-${randomUUID()}`;
    await sql`
      insert into plugin_device_authorizations (
        id, device_code_hash, user_code, device_name, plugin_version,
        tenant_id, team_id, partner_id, status, approved_at, expires_at
      ) values (
        ${authorizationId}, ${createHash("sha256").update(deviceCode).digest("hex")},
        ${`DEVICE-${randomUUID()}`}, 'integration-device', '0.4.0',
        ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, 'approved',
        now(), now() + interval '15 minutes'
      )
    `;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/plugin-bindings/device-authorizations/token",
        payload: { deviceCode },
      });
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json();
      const events = await sql<any[]>`
        select event_type, aggregate_type, aggregate_id, payload
        from outbox_events
        where tenant_id = ${fixture.tenantA}
          and event_type = 'plugin.binding.claimed'
          and payload->>'pluginInstanceId' = ${result.pluginInstanceId}
      `;
      expect(events).toEqual([
        {
          event_type: "plugin.binding.claimed",
          aggregate_type: "partner",
          aggregate_id: fixture.partnerA,
          payload: {
            teamId: fixture.teamA,
            partnerId: fixture.partnerA,
            pluginInstanceId: result.pluginInstanceId,
          },
        },
      ]);
    } finally {
      await sql`
        delete from outbox_events
        where tenant_id = ${fixture.tenantA}
          and payload->>'pluginInstanceId' in (
            select id::text from plugin_instances
            where device_name = 'integration-device'
              and tenant_id = ${fixture.tenantA}
          )
      `;
      await sql`
        delete from plugin_instances
        where device_name = 'integration-device'
          and tenant_id = ${fixture.tenantA}
      `;
      await sql`
        delete from plugin_device_authorizations where id = ${authorizationId}
      `;
    }
  });

  it("keeps an unresolved Feishu delivery visible after a newer success", async () => {
    const failedDeliveryId = randomUUID();
    try {
      await sql`
        insert into feishu_deliveries (
          id, tenant_id, team_id, partner_id, kind, aggregate_type,
          aggregate_id, receive_id, receive_id_type, status,
          idempotency_key, last_error_code, next_retry_at, updated_at
        ) values (
          ${failedDeliveryId}, ${fixture.tenantA}, ${fixture.teamA},
          ${fixture.partnerA}, 'report', 'individual_report',
          ${failedDeliveryId}, ${feishuOpenId}, 'open_id', 'retry_wait',
          ${`report:${feishuAppId}:${fixture.partnerA}:${failedDeliveryId}`},
          'TEST_RETRY', now() + interval '5 minutes',
          now() - interval '10 minutes'
        )
      `;
      const overview = await app.inject({
        method: "GET",
        url: "/v1/admin/overview",
        headers,
      });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().connections).toContainEqual(
        expect.objectContaining({
          partnerId: fixture.partnerA,
          feishu: expect.objectContaining({
            state: "delivery_error",
            deliveryState: "retrying",
            lastDeliveryKind: "report",
            lastDeliveryStatus: "retry_wait",
            lastErrorCode: "TEST_RETRY",
          }),
        }),
      );
    } finally {
      await sql`delete from feishu_deliveries where id = ${failedDeliveryId}`;
    }
  });

  it("removes a Partner and revokes both Plugin and Feishu bindings", async () => {
    const partnerId = randomUUID();
    const pluginId = randomUUID();
    const bindingCodeId = randomUUID();
    const feishuBindingId = randomUUID();
    const feishuDeliveryId = randomUUID();
    const historicalDeliveryId = randomUUID();
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
        await tx`
          insert into feishu_partner_bindings (
            id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
          ) values (
            ${feishuBindingId}, ${fixture.tenantA}, ${fixture.teamA}, ${partnerId},
            ${feishuAppId}, ${`ou_${partnerId}`}, 'active', now()
          )
        `;
        await tx`
          insert into feishu_deliveries (
            id, tenant_id, team_id, partner_id, kind, aggregate_type,
            aggregate_id, receive_id, receive_id_type, domain_version,
            status, idempotency_key
          ) values (
            ${feishuDeliveryId}, ${fixture.tenantA}, ${fixture.teamA}, ${partnerId},
            'binding', 'partner', ${partnerId}, ${`ou_${partnerId}`}, 'open_id',
            1, 'pending', ${`binding:${feishuAppId}:${partnerId}:${partnerId}`}
          )
        `;
        await tx`
          insert into feishu_deliveries (
            id, tenant_id, team_id, partner_id, kind, aggregate_type,
            aggregate_id, receive_id, receive_id_type, message_id,
            domain_version, status, idempotency_key, sent_at
          ) values (
            ${historicalDeliveryId}, ${fixture.tenantA}, ${fixture.teamA},
            ${partnerId}, 'review', 'review', ${fixture.reviewA},
            ${`ou_${partnerId}`}, 'open_id', ${`om_${historicalDeliveryId}`},
            1, 'sent', ${`review:${feishuAppId}:${partnerId}:${fixture.reviewA}`},
            now()
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
        revokedFeishuBindingCount: 1,
        cancelledFeishuDeliveryCount: 1,
      });
      const state = await sql<any[]>`
        select p.status as partner_status, pi.status as plugin_status,
          pbc.status as binding_code_status, fb.status as feishu_binding_status,
          fb.open_id, fd.status as feishu_delivery_status,
          fd.last_error_code
        from partners p
        join plugin_instances pi on pi.partner_id = p.id
        join plugin_binding_codes pbc on pbc.partner_id = p.id
        join feishu_partner_bindings fb on fb.partner_id = p.id
        join feishu_deliveries fd on fd.partner_id = p.id
          and fd.id = ${feishuDeliveryId}
        where p.id = ${partnerId} and p.tenant_id = ${fixture.tenantA}
      `;
      expect(state).toEqual([
        {
          partner_status: "suspended",
          plugin_status: "revoked",
          binding_code_status: "revoked",
          feishu_binding_status: "revoked",
          open_id: null,
          feishu_delivery_status: "cancelled",
          last_error_code: "PARTNER_REMOVED",
        },
      ]);
      const historicalDeliveries = await sql<any[]>`
        select status, last_error_code from feishu_deliveries
        where id = ${historicalDeliveryId}
      `;
      expect(historicalDeliveries).toEqual([
        { status: "sent", last_error_code: null },
      ]);
      const pluginRequest = await app.inject({
        method: "GET",
        url: "/v1/plugin-bindings/me",
        headers: { authorization: `Bearer ${pluginAccessToken}` },
      });
      expect(pluginRequest.statusCode).toBe(401);
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
      await sql`delete from feishu_deliveries where partner_id = ${partnerId}`;
      await sql`delete from feishu_partner_bindings where partner_id = ${partnerId}`;
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
          deviceName: "fixture-device",
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
        plugin_device_name: "fixture-device",
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

  it("ingests one Session Contribution idempotently and replaces changed content", async () => {
    const pluginHeaders = { authorization: `Bearer ${pluginToken}` };
    const baseStatus = {
      pluginVersion: "0.3.0",
      deviceName: "fixture-device",
      periodKey: "fixture-current-a",
      sessionCount: 0,
      factCount: 0,
      pendingLocalJobs: 0,
      discoveredCount: 1,
      eligibleCount: 1,
      deferredCount: 0,
      excludedCount: 0,
    };
    const started = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/collection-status",
      headers: pluginHeaders,
      payload: { ...baseStatus, phase: "started" },
    });
    expect(started.statusCode).toBe(200);

    const rejectedCompletion = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/collection-status",
      headers: pluginHeaders,
      payload: { ...baseStatus, phase: "completed", pendingLocalJobs: 1 },
    });
    expect(rejectedCompletion.statusCode).toBe(409);
    expect(rejectedCompletion.json().code).toBe("COLLECTION_NOT_DRAINED");

    const sessionKey = "d".repeat(64);
    const contribution = {
      schemaVersion: "1.0",
      periodKey: "fixture-period-a",
      sessionKey,
      contentHash: "a".repeat(64),
      project: {
        id: null,
        name: "automatic-project",
        matchMethod: "path_discovered",
        rootFingerprint: "c".repeat(64),
        rootName: "automatic-project",
      },
      activity: {
        startedAt: "2026-08-03T08:00:00.000Z",
        endedAt: "2026-08-03T08:55:00.000Z",
      },
      title: "完成结构化采集验证",
      summary: "完成 Session Contribution 上传链路验证。",
      status: "in_progress",
      contributions: [
        {
          kind: "outcome",
          text: "中台已接收结构化 Session Contribution。",
          confidence: "high",
        },
      ],
      observedAt: "2026-08-03T09:00:00.000Z",
      production: {
        skillVersion: "partner-report-sync/0.3.0",
        promptVersion: "2026-08-04.session-value.v1",
        schemaVersion: "1.0",
        producer: "codex-skill",
      },
    };
    const contributionHeaders = {
      ...pluginHeaders,
      "idempotency-key": "fixture-contribution-key",
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/session-contributions",
      headers: contributionHeaders,
      payload: contribution,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: "accepted",
      sessionKey,
      contentHash: contribution.contentHash,
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/session-contributions",
      headers: contributionHeaders,
      payload: contribution,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/session-contributions",
      headers: contributionHeaders,
      payload: { ...contribution, summary: "不同的 Payload" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");

    const changed = await app.inject({
      method: "POST",
      url: "/v1/session-contributions",
      headers: {
        ...pluginHeaders,
        "idempotency-key": "fixture-contribution-revision-two",
      },
      payload: {
        ...contribution,
        contentHash: "b".repeat(64),
        summary: "Session 内容变化后重新生成完整贡献。",
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      status: "accepted",
      sessionKey,
      contentHash: "b".repeat(64),
    });
    expect(changed.json().contributionId).toBe(first.json().contributionId);

    const state = await app.inject({
      method: "GET",
      url: "/v1/session-contributions/state?periodKey=fixture-current-a",
      headers: pluginHeaders,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      periodKey: "fixture-current-a",
      sessions: [{ sessionKey, contentHash: "b".repeat(64) }],
    });

    const discoveredProjects = await sql<any[]>`
      select id, name, allowed_paths, external_ids from projects
      where tenant_id = ${fixture.tenantA} and team_id = ${fixture.teamA}
        and name = 'automatic-project'
    `;
    expect(discoveredProjects).toHaveLength(1);
    expect(discoveredProjects[0]).toMatchObject({
      name: "automatic-project",
      allowed_paths: [],
      external_ids: [`path-sha256:${"c".repeat(64)}`],
    });

    const factPreview = await app.inject({
      method: "GET",
      url: `/v1/admin/session-facts?partnerId=${fixture.partnerA}`,
      headers,
    });
    expect(factPreview.statusCode).toBe(200);
    expect(factPreview.json()).toMatchObject({
      total: 1,
      items: [
        {
          external_fact_id: `${sessionKey}:contribution`,
          period_id: fixture.currentPeriodA,
          payload: {
            recordType: "session_contribution",
            periodKey: "fixture-current-a",
            contentHash: "b".repeat(64),
            projectId: discoveredProjects[0].id,
            projectMatchMethod: "path_discovered",
          },
        },
      ],
    });
    expect(JSON.stringify(factPreview.json())).not.toContain("userPrompt");
    const matchingSessionDate = await app.inject({
      method: "GET",
      url: `/v1/admin/session-facts?sessionDate=2026-08-03`,
      headers,
    });
    expect(matchingSessionDate.statusCode).toBe(200);
    expect(matchingSessionDate.json().total).toBe(1);
    const differentSessionDate = await app.inject({
      method: "GET",
      url: `/v1/admin/session-facts?sessionDate=2026-08-04`,
      headers,
    });
    expect(differentSessionDate.statusCode).toBe(200);
    expect(differentSessionDate.json().total).toBe(0);
    const invalidSessionDate = await app.inject({
      method: "GET",
      url: `/v1/admin/session-facts?sessionDate=2026-02-30`,
      headers,
    });
    expect(invalidSessionDate.statusCode).toBe(400);
    const records = await sql<any[]>`
      select session_id, source_hash, collection_run_id
      from session_records where tenant_id = ${fixture.tenantA}
    `;
    expect(records).toEqual([
      {
        session_id: sessionKey,
        source_hash: "b".repeat(64),
        collection_run_id: null,
      },
    ]);

    const completed = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/collection-status",
      headers: pluginHeaders,
      payload: {
        ...baseStatus,
        phase: "completed",
        sessionCount: 1,
        factCount: 1,
      },
    });
    expect(completed.statusCode).toBe(200);
    const runs = await sql<any[]>`
      select id from collection_runs where tenant_id = ${fixture.tenantA}
    `;
    expect(runs).toEqual([]);
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
          '{"missingPartnerIds":[],"qualityWarnings":[]}'::jsonb,
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

  it("regenerates a personal Report by replacing its current content", async () => {
    const snapshotId = randomUUID();
    const reportId = randomUUID();
    const secondWorkItemId = randomUUID();
    let autoTeamReportId = "";
    await sql.begin(async (tx) => {
      await tx`
        insert into work_item_snapshots (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          review_version, checksum, payload, approved_by, approved_at
        ) values (
          ${snapshotId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.periodA}, ${fixture.reviewA}, 1, 'fixture-personal-source',
          ${JSON.stringify({
            workItems: [
              {
                id: fixture.workItemA,
                title: "Fixture Project A",
                status: "completed",
                review_status: "approved",
                fact_ids: [],
                payload: { overview: "完成项目进展。" },
              },
              {
                id: secondWorkItemId,
                title: "Independent work",
                status: "completed",
                review_status: "approved",
                fact_ids: [],
                payload: { overview: "完成独立工作。" },
              },
            ],
            coverage: { discovered: 1, extracted: 1 },
          })}::jsonb,
          ${fixture.userA}, now()
        )
      `;
      await tx`
        insert into individual_reports (
          id, tenant_id, team_id, partner_id, period_id, snapshot_id,
          status, content_revision, title, summary, markdown, payload,
          preferences, source_checksum, generator_version
        ) values (
          ${reportId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.periodA}, ${snapshotId}, 'REPORT_REVIEW', 1, '个人周报',
          '初始摘要', '# 个人周报\n\n初始内容。',
          ${JSON.stringify({ sections: [] })}::jsonb, '{}'::jsonb,
          'fixture-personal-source', 'synthetic-test/1.0'
        )
      `;
    });

    try {
      const detail = await app.inject({
        method: "GET",
        url: `/v1/individual-reports/${reportId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        report: { id: reportId, content_revision: 1 },
        current: { id: reportId, title: "个人周报" },
      });
      expect(detail.json()).not.toHaveProperty("versions");
      expect(detail.json().current).not.toHaveProperty("version");

      const staleRegenerate = await app.inject({
        method: "POST",
        url: `/v1/individual-reports/${reportId}/regenerate`,
        headers,
        payload: {
          instruction: "这是过期卡片上的修改意见。",
          contentRevision: 2,
        },
      });
      expect(staleRegenerate.statusCode).toBe(409);
      expect(staleRegenerate.json()).toMatchObject({
        code: "REPORT_CONTENT_CHANGED",
      });

      const regenerate = await app.inject({
        method: "POST",
        url: `/v1/individual-reports/${reportId}/regenerate`,
        headers,
        payload: {
          instruction: "突出项目结果，减少过程描述。",
          contentRevision: 1,
        },
      });
      expect(regenerate.statusCode).toBe(200);
      const jobs = await sql<any[]>`
        select input_payload from agent_jobs
        where tenant_id = ${fixture.tenantA}
          and input_payload->>'reportId' = ${reportId}
          and type = 'REGENERATE_INDIVIDUAL_REPORT'
      `;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].input_payload).toMatchObject({
        reviewInstruction: "突出项目结果，减少过程描述。",
        currentReport: { title: "个人周报" },
        workItems: [{ id: fixture.workItemA }, { id: secondWorkItemId }],
      });

      await sql`
        update individual_reports set status = 'REPORT_REVIEW' where id = ${reportId}
      `;
      const accepted = await app.inject({
        method: "POST",
        url: `/v1/individual-reports/${reportId}/submit`,
        headers,
        payload: { contentRevision: 1 },
      });
      expect(accepted.statusCode).toBe(200);
      const autoTeamReports = await sql<any[]>`
        select tr.id, tr.status, aj.type, aj.input_payload
        from team_reports tr
        join agent_jobs aj on aj.tenant_id = tr.tenant_id
          and aj.input_payload->>'reportId' = tr.id::text
        where tr.tenant_id = ${fixture.tenantA}
          and tr.team_id = ${fixture.teamA}
          and tr.period_id = ${fixture.periodA}
      `;
      expect(autoTeamReports).toMatchObject([
        {
          id: expect.any(String),
          status: "AGGREGATING",
          type: "GENERATE_TEAM_REPORT",
          input_payload: {
            individualReports: [{ reportId }],
            missingPartnerIds: [],
          },
        },
      ]);
      autoTeamReportId = autoTeamReports[0].id;

      const archive = await app.inject({
        method: "GET",
        url: "/v1/admin/individual-reports",
        headers,
      });
      expect(archive.statusCode).toBe(200);
      expect(archive.json()).toContainEqual(
        expect.objectContaining({
          id: reportId,
          status: "LOCKED",
          partner_name: "Fixture A",
          title: "个人周报",
        }),
      );
      const workItemArchive = await app.inject({
        method: "GET",
        url: "/v1/admin/work-item-archives",
        headers,
      });
      expect(workItemArchive.statusCode).toBe(200);
      const matchingWorkItemArchives = workItemArchive
        .json()
        .filter((item: any) => item.report_id === reportId);
      expect(matchingWorkItemArchives).toEqual([
        expect.objectContaining({
          id: reportId,
          report_id: reportId,
          partner_id: fixture.partnerA,
          period_id: fixture.periodA,
          work_item_count: 2,
          included_work_item_count: 2,
        }),
      ]);
      const integratedArchive = await app.inject({
        method: "GET",
        url: "/v1/admin/report-archive",
        headers,
      });
      expect(integratedArchive.statusCode).toBe(200);
      const personalPeriod = integratedArchive
        .json()
        .periods.find((period: any) => period.id === fixture.periodA);
      expect(personalPeriod).toMatchObject({
        periodKey: "fixture-period-a",
        people: [
          {
            id: fixture.partnerA,
            name: "Fixture A",
            individualReport: {
              id: reportId,
              title: "个人周报",
            },
          },
        ],
      });
      expect(personalPeriod.people[0].workItems).toHaveLength(2);
      expect(personalPeriod.people[0].workItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: fixture.workItemA,
            title: "Fixture Project A",
            reviewStatus: "approved",
            includedInReport: true,
          }),
          expect.objectContaining({
            id: secondWorkItemId,
            title: "Independent work",
            includedInReport: true,
          }),
        ]),
      );
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from agent_jobs where tenant_id = ${fixture.tenantA} and input_payload->>'reportId' = ${autoTeamReportId || null}`;
        await tx`delete from team_reports where id = ${autoTeamReportId || null}`;
        await tx`delete from agent_jobs where tenant_id = ${fixture.tenantA} and input_payload->>'reportId' = ${reportId}`;
        await tx`delete from individual_reports where id = ${reportId}`;
        await tx`delete from work_item_snapshots where id = ${snapshotId}`;
      });
    }
  });

  it("generates a Team Report on demand from the selected period", async () => {
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const snapshotId = randomUUID();
    const individualReportId = randomUUID();
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
      await tx`
        insert into individual_reports (
          id, tenant_id, team_id, partner_id, period_id, snapshot_id,
          status, content_revision, title, summary, markdown, payload,
          source_checksum, generator_version, submitted_at, locked_at
        ) values (
          ${individualReportId}, ${fixture.tenantA}, ${fixture.teamA},
          ${fixture.partnerA}, ${periodId}, ${snapshotId}, 'LOCKED', 1,
          '最终个人报告', '最终摘要', '# 最终个人报告',
          '{"sections":[]}'::jsonb, 'manual-team-source', 'synthetic-test/1.0',
          now(), now()
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
        individualReportCount: 1,
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
            individualReports: [{ reportId: individualReportId }],
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
        await tx`delete from individual_reports where id = ${individualReportId}`;
        await tx`delete from work_item_snapshots where id = ${snapshotId}`;
        await tx`delete from reviews where id = ${reviewId}`;
        await tx`delete from report_periods where id = ${periodId}`;
      });
    }
  });

  it("replaces the personal Report when approved work cards change", async () => {
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    const coverageId = randomUUID();
    let reportId = "";

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
      reportId = first.json().reportId;
      expect(reportId).toEqual(expect.any(String));

      await sql`
        update individual_reports set
          status = 'REPORT_REVIEW', content_revision = 1,
          title = '旧个人报告', summary = '旧摘要', markdown = '# 旧个人报告',
          payload = '{"sections":[]}'::jsonb
        where id = ${reportId}
      `;
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
      expect(second.json().reportId).toBe(reportId);

      const reports = await sql<any[]>`
        select id, status, content_revision, title, summary, markdown, payload
        from individual_reports
        where tenant_id = ${fixture.tenantA} and partner_id = ${fixture.partnerA}
          and period_id = ${periodId}
      `;
      expect(reports).toEqual([
        {
          id: reportId,
          status: "REPORT_DRAFT",
          content_revision: 1,
          title: null,
          summary: null,
          markdown: null,
          payload: null,
        },
      ]);
    } finally {
      await sql.begin(async (tx) => {
        await tx`
          delete from agent_jobs
          where tenant_id = ${fixture.tenantA}
            and input_payload->>'reportId' in (
              select id::text from individual_reports where period_id = ${periodId}
            )
        `;
        await tx`delete from individual_reports where period_id = ${periodId}`;
        await tx`delete from work_item_snapshots where review_id = ${reviewId}`;
        await tx`delete from work_items where review_id = ${reviewId}`;
        await tx`delete from coverage_snapshots where id = ${coverageId}`;
        await tx`delete from reviews where id = ${reviewId}`;
        await tx`delete from report_periods where id = ${periodId}`;
      });
    }
  });

  it("does not let return or reopen overwrite a concurrently locked Report", async () => {
    const verifyLockedReportWins = async (action: "return" | "reopen") => {
      const periodId = randomUUID();
      const reviewId = randomUUID();
      const snapshotId = randomUUID();
      const reportId = randomUUID();
      let releaseReportLock!: () => void;
      let reportLockAcquired!: () => void;
      const releaseReportLockPromise = new Promise<void>((resolve) => {
        releaseReportLock = resolve;
      });
      const reportLockAcquiredPromise = new Promise<void>((resolve) => {
        reportLockAcquired = resolve;
      });
      let lockingTransaction: Promise<unknown> | undefined;

      try {
        await sql.begin(async (tx) => {
          await tx`
            insert into report_periods (
              id, tenant_id, team_id, period_key, starts_at, ends_at,
              cutoff_at, submission_deadline_at, timezone, status
            ) values (
              ${periodId}, ${fixture.tenantA}, ${fixture.teamA},
              ${`report-lock-race-${periodId}`}, '2099-03-01T00:00:00Z',
              '2099-03-07T23:59:59Z', '2099-03-07T12:00:00Z',
              '2099-03-08T12:00:00Z', 'Asia/Shanghai', 'closed'
            )
          `;
          await tx`
            insert into reviews (
              id, tenant_id, team_id, partner_id, period_id, state, version
            ) values (
              ${reviewId}, ${fixture.tenantA}, ${fixture.teamA},
              ${fixture.partnerA}, ${periodId}, 'ITEMS_APPROVED', 1
            )
          `;
          await tx`
            insert into work_item_snapshots (
              id, tenant_id, team_id, partner_id, period_id, review_id,
              review_version, checksum, payload, approved_by_actor_type,
              approved_by_actor_id, approved_at
            ) values (
              ${snapshotId}, ${fixture.tenantA}, ${fixture.teamA},
              ${fixture.partnerA}, ${periodId}, ${reviewId}, 1,
              ${`report-lock-race-${snapshotId}`},
              '{"workItems":[],"coverage":{}}'::jsonb, 'user',
              ${fixture.userA}, now()
            )
          `;
          await tx`
            insert into individual_reports (
              id, tenant_id, team_id, partner_id, period_id, snapshot_id,
              status, content_revision, title, summary, markdown, payload,
              preferences, source_checksum, generator_version
            ) values (
              ${reportId}, ${fixture.tenantA}, ${fixture.teamA},
              ${fixture.partnerA}, ${periodId}, ${snapshotId},
              'REPORT_REVIEW', 1, '并发锁定测试', '并发锁定摘要',
              '# 并发锁定测试', '{"sections":[]}'::jsonb, '{}'::jsonb,
              ${`report-lock-race-${snapshotId}`}, 'synthetic-test/1.0'
            )
          `;
        });

        lockingTransaction = sql.begin(async (tx) => {
          await tx`
            select id from individual_reports
            where id = ${reportId} and tenant_id = ${fixture.tenantA}
            for update
          `;
          reportLockAcquired();
          await releaseReportLockPromise;
          await tx`
            update individual_reports set
              status = 'LOCKED', submitted_at = now(), locked_at = now(),
              updated_at = now()
            where id = ${reportId} and tenant_id = ${fixture.tenantA}
          `;
        });
        await reportLockAcquiredPromise;

        const responsePromise = app.inject(
          action === "return"
            ? {
                method: "POST",
                url: `/v1/individual-reports/${reportId}/return-to-items`,
                headers,
              }
            : {
                method: "POST",
                url: `/v1/reviews/${reviewId}/reopen`,
                headers,
                payload: { baseVersion: 1 },
              },
        );
        await waitForBlockedReportMutation();
        releaseReportLock();
        await lockingTransaction;
        lockingTransaction = undefined;

        const response = await responsePromise;
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: "REPORT_LOCKED" });
        const [reports, reviews] = await Promise.all([
          sql<Array<{ status: string }>>`
            select status from individual_reports where id = ${reportId}
          `,
          sql<Array<{ state: string; version: number }>>`
            select state, version from reviews where id = ${reviewId}
          `,
        ]);
        expect(reports).toEqual([{ status: "LOCKED" }]);
        expect(reviews).toEqual([{ state: "ITEMS_APPROVED", version: 1 }]);
      } finally {
        releaseReportLock?.();
        await lockingTransaction?.catch(() => undefined);
        await sql.begin(async (tx) => {
          await tx`delete from audit_events where tenant_id = ${fixture.tenantA} and target_id in (${reportId}, ${reviewId})`;
          await tx`delete from outbox_events where tenant_id = ${fixture.tenantA} and aggregate_id in (${reportId}, ${reviewId})`;
          await tx`delete from individual_reports where id = ${reportId}`;
          await tx`delete from work_item_snapshots where id = ${snapshotId}`;
          await tx`delete from reviews where id = ${reviewId}`;
          await tx`delete from report_periods where id = ${periodId}`;
        });
      }
    };

    await verifyLockedReportWins("return");
    await verifyLockedReportWins("reopen");
  });

  it("automatically queues an individual Report after the final Work Card decision", async () => {
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    const coverageId = randomUUID();
    let reportId: string | undefined;
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
          '自动生成个人报告', 'in_progress', 'pending', '[]'::jsonb,
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
        reportId: expect.any(String),
      });
      const createdReportId = String(decision.json().reportId);
      reportId = createdReportId;
      const [reports, jobs, snapshots] = await Promise.all([
        sql<any[]>`
          select id, status, snapshot_id from individual_reports
          where id = ${createdReportId}
        `,
        sql<any[]>`
          select type, input_payload from agent_jobs
          where tenant_id = ${fixture.tenantA}
            and input_payload->>'reportId' = ${createdReportId}
        `,
        sql<any[]>`
          select payload from work_item_snapshots
          where id = ${decision.json().snapshotId}
        `,
      ]);
      expect(reports).toMatchObject([{ id: reportId, status: "REPORT_DRAFT" }]);
      expect(jobs).toMatchObject([
        {
          type: "GENERATE_INDIVIDUAL_REPORT",
          input_payload: {
            workItems: [
              {
                id: workItemId,
                title: "自动生成个人报告",
                review_status: "approved",
              },
            ],
          },
        },
      ]);
      expect(snapshots[0].payload.workItems[0]).toMatchObject({
        id: workItemId,
        title: "自动生成个人报告",
        status: "in_progress",
        review_status: "approved",
        payload: {
          overview: "最后一张工作卡片完成审核。",
        },
      });
    } finally {
      await sql.begin(async (tx) => {
        await tx`
          delete from agent_jobs where tenant_id = ${fixture.tenantA}
            and input_payload->>'reportId' = ${reportId ?? null}
        `;
        await tx`delete from individual_reports where id = ${reportId ?? null}`;
        await tx`delete from work_item_snapshots where review_id = ${reviewId}`;
        await tx`delete from coverage_snapshots where id = ${coverageId}`;
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
