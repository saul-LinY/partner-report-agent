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
    expect(overview.json().plugins).toContainEqual(
      expect.objectContaining({
        id: claim.json().pluginInstanceId,
        connectivityStatus: "verified",
        runStatus: "waiting_first_run",
        last_diagnostic_error_code: "SYNC_FAILED",
        last_diagnostic_message: "结构化 Fact 同步失败。",
      }),
    );
    expect(overview.json().bindingCodes).toContainEqual(
      expect.objectContaining({
        id: fixture.bindingA,
        code_value: bindingCode,
      }),
    );
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

  it("ingests a drained collection run idempotently and exposes safe Fact lineage", async () => {
    const runId = randomUUID();
    const pluginHeaders = { authorization: `Bearer ${pluginToken}` };
    const baseStatus = {
      pluginVersion: "0.2.0",
      deviceName: "fixture-device",
      collectionRunId: runId,
      periodKey: "fixture-current-a",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-04T00:00:00.000Z",
      initialLookback: true,
      sessionCount: 0,
      factCount: 0,
      pendingLocalJobs: 0,
      discoveredCount: 2,
      eligibleCount: 2,
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

    const sourceHash = "a".repeat(64);
    const factId = "fixture-fact-late";
    const upload = {
      schemaVersion: "1.0",
      producerVersion: "partner-report-sync/0.2.0",
      batchId: "fixture-batch-run",
      pluginInstanceId: fixture.pluginA,
      collectionRunId: runId,
      periodKey: "fixture-period-a",
      collectionWindow: {
        startsAt: baseStatus.windowStartsAt,
        endsAt: baseStatus.windowEndsAt,
        initialLookback: true,
      },
      periodCandidates: ["fixture-period-a"],
      sessions: [
        {
          sessionId: "fixture-zero-fact-session",
          project: {
            id: null,
            matchMethod: "unassigned",
            rootFingerprint: "b".repeat(64),
          },
          sourceRevision: 1,
          sourceHash,
          fromTurnId: "turn-zero",
          toTurnId: "turn-zero",
          observedAt: "2026-08-03T08:00:00.000Z",
          sourceOccurredAt: "2026-08-03T07:55:00.000Z",
          status: "extracted",
          facts: [],
        },
        {
          sessionId: "fixture-one-fact-session",
          project: {
            id: null,
            matchMethod: "path_discovered",
            rootFingerprint: "c".repeat(64),
            rootName: "automatic-project",
          },
          sourceRevision: 1,
          sourceHash,
          fromTurnId: "turn-one",
          toTurnId: "turn-one",
          observedAt: "2026-08-03T09:00:00.000Z",
          sourceOccurredAt: "2026-08-03T08:55:00.000Z",
          status: "extracted",
          facts: [
            {
              schemaVersion: "1.0",
              factId,
              sessionId: "fixture-one-fact-session",
              sourceRevision: 1,
              sourceHash,
              fromTurnId: "turn-one",
              toTurnId: "turn-one",
              title: "完成结构化采集验证",
              status: "in_progress",
              actions: ["验证上传链路"],
              outcomes: ["中台确认批次"],
              impact: [],
              decisions: [],
              blockers: [],
              nextSteps: ["完成端到端验收"],
              timeline: [
                {
                  status: "in_progress",
                  occurredAt: "2026-08-03T08:55:00.000Z",
                  summary: "已上传结构化测试 Fact",
                  evidenceTurnIds: ["turn-one"],
                },
              ],
              evidence: [],
              completionSupport: "uncertain",
              factOrigin: "ai_extracted",
              redactionSummary: {},
              production: {
                skillVersion: "partner-report-sync/0.2.0",
                promptVersion: "2026-08-03.v3",
                schemaVersion: "1.0",
                producer: "codex-skill",
              },
            },
          ],
        },
      ],
    };
    const batchHeaders = {
      ...pluginHeaders,
      "idempotency-key": "fixture-batch-run-key",
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/session-facts/batch",
      headers: batchHeaders,
      payload: upload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 2, rejected: 0 });
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/session-facts/batch",
      headers: batchHeaders,
      payload: upload,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/session-facts/batch",
      headers: batchHeaders,
      payload: { ...upload, batchId: "changed-batch" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");

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
    await sql`
      update session_facts set payload = payload ||
        '{"projectId":null,"projectMatchMethod":"unassigned"}'::jsonb
      where tenant_id = ${fixture.tenantA} and external_fact_id = ${factId}
    `;
    const discovery = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/project-discoveries",
      headers: pluginHeaders,
      payload: {
        discoveries: [
          {
            sessionId: "fixture-one-fact-session",
            rootName: "automatic-project",
            rootFingerprint: "c".repeat(64),
          },
        ],
      },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      submitted: 1,
      mappings: [
        {
          sessionId: "fixture-one-fact-session",
          projectId: discoveredProjects[0].id,
          projectName: "automatic-project",
        },
      ],
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
          external_fact_id: factId,
          period_id: fixture.currentPeriodA,
          late_from_period_key: "fixture-period-a",
          payload: {
            projectId: discoveredProjects[0].id,
            projectMatchMethod: "path_discovered",
          },
        },
      ],
    });
    expect(JSON.stringify(factPreview.json())).not.toContain("userPrompt");
    const records = await sql<any[]>`
      select session_id from session_records
      where tenant_id = ${fixture.tenantA} and collection_run_id is not null
      order by session_id
    `;
    expect(records.map((record) => record.session_id)).toEqual([
      "fixture-one-fact-session",
      "fixture-zero-fact-session",
    ]);

    const completed = await app.inject({
      method: "POST",
      url: "/v1/plugin-instances/me/collection-status",
      headers: pluginHeaders,
      payload: {
        ...baseStatus,
        phase: "completed",
        sessionCount: 2,
        factCount: 1,
      },
    });
    expect(completed.statusCode).toBe(200);
    const runs = await sql<any[]>`
      select status, synced_session_count, synced_fact_count, pending_local_jobs
      from collection_runs where external_run_id = ${runId}
    `;
    expect(runs).toEqual([
      {
        status: "COMPLETED",
        synced_session_count: 2,
        synced_fact_count: 1,
        pending_local_jobs: 0,
      },
    ]);
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
