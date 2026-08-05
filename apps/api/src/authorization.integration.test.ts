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
    currentPeriodA: randomUUID(),
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
      await tx`insert into plugin_binding_codes (id, tenant_id, team_id, partner_id, code_hash, code_value, code_prefix, label, created_by) values (${fixture.bindingA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${createHash("sha256").update(bindingCode).digest("hex")}, ${bindingCode}, 'PR-TEST', 'Fixture Codex', ${fixture.userA})`;
      await tx`insert into agent_jobs (id, tenant_id, team_id, partner_id, plugin_instance_id, type, status, idempotency_key, input_payload, output_payload, completed_at) values (${fixture.jobA}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA}, ${fixture.pluginA}, 'RESCAN_SESSIONS', 'COMPLETED', ${`fixture:${fixture.jobA}`}, '{}'::jsonb, '{"completed":true,"batchIds":[]}'::jsonb, now())`;
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

  it("ingests one Session Contribution idempotently and versions changed content", async () => {
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
      revision: 1,
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
      revision: 2,
    });

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
          source_revision: 2,
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
      select session_id, latest_source_revision, collection_run_id
      from session_records where tenant_id = ${fixture.tenantA}
    `;
    expect(records).toEqual([
      {
        session_id: sessionKey,
        latest_source_revision: 2,
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

  it("regenerates a personal Report from natural-language review and archives the accepted version", async () => {
    const snapshotId = randomUUID();
    const reportId = randomUUID();
    const versionId = randomUUID();
    const workItemVersionId = randomUUID();
    const secondWorkItemVersionId = randomUUID();
    const secondWorkItemId = randomUUID();
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
                payload: { overview: "完成项目进展。" },
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
          status, current_version
        ) values (
          ${reportId}, ${fixture.tenantA}, ${fixture.teamA}, ${fixture.partnerA},
          ${fixture.periodA}, ${snapshotId}, 'REPORT_REVIEW', 1
        )
      `;
      await tx`
        insert into individual_report_versions (
          id, tenant_id, report_id, version, title, summary, markdown, payload,
          preferences, source_checksum, generator_version
        ) values (
          ${versionId}, ${fixture.tenantA}, ${reportId}, 1, '个人周报',
          '初始摘要', '# 个人周报\n\n初始内容。',
          ${JSON.stringify({ sections: [] })}::jsonb, '{}'::jsonb,
          'fixture-personal-source', 'synthetic-test/1.0'
        )
      `;
      await tx`
        insert into work_item_versions (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          work_item_id, project_id, version, title, status, review_status,
          fact_ids, payload, lineage, change_type, created_by
        ) values (
          ${workItemVersionId}, ${fixture.tenantA}, ${fixture.teamA},
          ${fixture.partnerA}, ${fixture.periodA}, ${fixture.reviewA},
          ${fixture.workItemA}, ${fixture.projectA}, 1, 'Fixture Project A',
          'completed', 'approved', '[]'::jsonb,
          '{"overview":"完成项目进展。"}'::jsonb, '{}'::jsonb,
          'review_completed', ${fixture.userA}
        )
      `;
      await tx`
        insert into individual_report_version_work_items (
          report_version_id, work_item_version_id
        ) values (${versionId}, ${workItemVersionId})
      `;
      await tx`
        insert into work_item_versions (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          work_item_id, project_id, version, title, status, review_status,
          fact_ids, payload, lineage, change_type, created_by
        ) values (
          ${secondWorkItemVersionId}, ${fixture.tenantA}, ${fixture.teamA},
          ${fixture.partnerA}, ${fixture.periodA}, ${fixture.reviewA},
          ${secondWorkItemId}, null, 1, 'Independent work', 'completed',
          'approved', '[]'::jsonb, '{"overview":"完成独立工作。"}'::jsonb,
          '{}'::jsonb, 'review_completed', ${fixture.userA}
        )
      `;
      await tx`
        insert into individual_report_version_work_items (
          report_version_id, work_item_version_id
        ) values (${versionId}, ${secondWorkItemVersionId})
      `;
    });

    try {
      const regenerate = await app.inject({
        method: "POST",
        url: `/v1/individual-reports/${reportId}/regenerate`,
        headers,
        payload: { instruction: "突出项目结果，减少过程描述。" },
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
        currentReport: { version: 1, title: "个人周报" },
        workItems: [{ id: fixture.workItemA }],
      });

      await sql`
        update individual_reports set status = 'REPORT_REVIEW' where id = ${reportId}
      `;
      const accepted = await app.inject({
        method: "POST",
        url: `/v1/individual-reports/${reportId}/submit`,
        headers,
        payload: { baseVersion: 1 },
      });
      expect(accepted.statusCode).toBe(200);

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
          work_item_version_count: 2,
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
              version: 1,
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
            version: 1,
            title: "Fixture Project A",
            reviewStatus: "approved",
            includedInReport: true,
          }),
          expect.objectContaining({
            id: secondWorkItemId,
            version: 1,
            title: "Independent work",
            includedInReport: true,
          }),
        ]),
      );
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from agent_jobs where tenant_id = ${fixture.tenantA} and input_payload->>'reportId' = ${reportId}`;
        await tx`delete from individual_report_versions where report_id = ${reportId}`;
        await tx`delete from individual_reports where id = ${reportId}`;
        await tx`delete from work_item_snapshots where id = ${snapshotId}`;
        await tx`delete from work_item_versions where id in (${workItemVersionId}, ${secondWorkItemVersionId})`;
      });
    }
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
      const [reports, jobs, snapshots, workItemVersions] = await Promise.all([
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
        sql<any[]>`
          select id, version, change_type from work_item_versions
          where work_item_id = ${workItemId}
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
                version: 2,
                versionId: expect.any(String),
              },
            ],
          },
        },
      ]);
      expect(snapshots[0].payload.workItems[0]).toMatchObject({
        id: workItemId,
        version: 2,
        versionId: workItemVersions[0].id,
      });
      expect(workItemVersions).toMatchObject([
        { version: 2, change_type: "approve" },
      ]);
    } finally {
      await sql.begin(async (tx) => {
        await tx`
          delete from agent_jobs where tenant_id = ${fixture.tenantA}
            and input_payload->>'reportId' = ${reportId ?? null}
        `;
        await tx`delete from individual_report_versions where report_id = ${reportId ?? null}`;
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
