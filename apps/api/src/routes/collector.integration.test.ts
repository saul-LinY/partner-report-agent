import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { sqlClient as sql, dispatchAppNotifications, loadInspectionInput } from "@partner-report/db";
import { sha256 } from "../common.js";
import {
  loadProjectScopePolicy,
  registerProjectScopeCandidates,
} from "../project-scope.js";
import { buildApp } from "../server.js";
import { signSessionToken } from "../auth-security.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("collector end-to-end persistence and privacy boundary", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    partner = randomUUID(),
    user = randomUUID(),
    instance = randomUUID(),
    bindingId = randomUUID();
  const code = `PR-${randomUUID()}`.toUpperCase();
  const identity = {
    tenantId: tenant,
    teamId: team,
    partnerId: partner,
    pluginInstanceId: instance,
  };
  const scopeKey = "a".repeat(64),
    denied = "b".repeat(64);
  const periodKey = `collector-${randomUUID()}`;
  const webToken = randomUUID();
  const start = new Date(Date.now() - 86400_000).toISOString(),
    end = new Date().toISOString();
  let app: Awaited<ReturnType<typeof buildApp>>,
    token: string,
    deviceId: string,
    policyVersion: number;
  let completedID: string;
  const headers = () => ({ authorization: `Bearer ${token}` });
  const claim = (name = "Collector Member") =>
    app.inject({
      method: "POST",
      url: "/v1/collector/bindings/claim",
      payload: {
        bindingCode: code,
        name,
        deviceName: "Test Mac",
        version: "0.2",
      },
    });
  const session = (id: string, key = scopeKey) => ({
    id,
    scopeKey: key,
    agent: "codex",
    title: "Full session",
    modifiedAt: end,
    turns: [
      {
        id: "turn",
        prompt: "full question",
        answer: "full answer",
        questionTime: "12:00",
      },
    ],
  });
  const pack = (sessions: unknown[]) => {
    const data = Buffer.from(JSON.stringify(sessions));
    return {
      data: data.toString("base64"),
      checksum: sha256(data),
      partIndex: 0,
    };
  };
  async function create(sessions: unknown[], count = sessions.length) {
    const part = pack(sessions),
      id = randomUUID();
    const manifest = {
      id,
      periodKey,
      startsAt: start,
      endsAt: end,
      policyVersion,
      sessionCount: count,
      partDigests: [part.checksum],
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/collector/uploads",
      headers: headers(),
      payload: manifest,
    });
    expect(response.statusCode, response.body).toBe(200);
    return { id, part, manifest };
  }
  const send = (id: string, part: object) =>
    app.inject({
      method: "POST",
      url: `/v1/collector/uploads/${id}/parts`,
      headers: headers(),
      payload: part,
    });
  const finish = (id: string) =>
    app.inject({
      method: "POST",
      url: `/v1/collector/uploads/${id}/complete`,
      headers: headers(),
      payload: {},
    });
  beforeAll(async () => {
    await sql`insert into tenants (id,name) values (${tenant},'Collector Test')`;
    await sql`insert into teams (id,tenant_id,name) values (${team},${tenant},'Collector Team')`;
    await sql`insert into users (id,email,display_name,password_hash) values (${user},${`${user}@test.local`},'Admin','test-only')`;
    await sql`insert into memberships (id,tenant_id,team_id,user_id,roles) values (${randomUUID()},${tenant},${team},${user},'["admin"]'::jsonb)`;
    await sql`insert into web_sessions (id,user_id,token_hash,expires_at) values (${randomUUID()},${user},${sha256(webToken)},now()+interval '1 day')`;
    await sql`insert into partners (id,tenant_id,team_id,email,display_name) values (${partner},${tenant},${team},${`${partner}@test.local`},'Collector Member')`;
    await sql`insert into plugin_instances (id,tenant_id,team_id,partner_id,device_name,version,access_token_hash,refresh_token_hash,access_expires_at)
      values (${instance},${tenant},${team},${partner},'Legacy','2',${sha256(randomUUID())},${sha256(randomUUID())},now()+interval '1 day')`;
    await sql`insert into plugin_binding_codes (id,tenant_id,team_id,partner_id,code_hash,code_prefix,plugin_instance_id,created_by,status)
      values (${bindingId},${tenant},${team},${partner},${sha256(code)},'PR-TEST',${instance},${user},'claimed')`;
    await sql`insert into report_periods (id,tenant_id,team_id,period_key,starts_at,ends_at,cutoff_at,submission_deadline_at,timezone,status)
      values (${randomUUID()},${tenant},${team},${periodKey},${start},${new Date(Date.now() + 86400_000).toISOString()},${end},${end},'Asia/Shanghai','open')`;
    await registerProjectScopeCandidates(identity, {
      periodKey,
      candidates: [
        { scopeKey, displayName: "Allowed", sessionCount: 1 },
        { scopeKey: denied, displayName: "Denied", sessionCount: 1 },
      ],
    });
    await sql`update project_scope_entries set status=case when scope_key=${scopeKey} then 'allowed' else 'denied' end, decided_at=now() where plugin_instance_id=${instance}`;
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app?.close();
    await sql`delete from collector_upload_parts where upload_id in (select id from collector_uploads where device_id in (select id from collector_devices where tenant_id=${tenant}))`;
    await sql`delete from collector_uploads where device_id in (select id from collector_devices where tenant_id=${tenant})`;
    await sql`delete from collector_logs where device_id in (select id from collector_devices where tenant_id=${tenant})`;
    await sql`delete from app_notifications where tenant_id=${tenant}`;
    await sql`delete from team_reports where tenant_id=${tenant}`;
    await sql`delete from reviews where tenant_id=${tenant}`;
    await sql`delete from collector_devices where tenant_id=${tenant}`;
    await sql`delete from outbox_events where tenant_id=${tenant}`;
    await sql`delete from agent_jobs where tenant_id=${tenant}`;
    await sql`delete from audit_events where tenant_id=${tenant}`;
    await sql`delete from project_scope_entries where tenant_id=${tenant}`;
    await sql`delete from project_scope_policies where tenant_id=${tenant}`;
    await sql`delete from plugin_binding_codes where tenant_id=${tenant}`;
    await sql`delete from plugin_instances where tenant_id=${tenant}`;
    await sql`delete from report_periods where tenant_id=${tenant}`;
    await sql`delete from partners where tenant_id=${tenant}`;
    await sql`delete from web_sessions where user_id=${user}`;
    await sql`delete from memberships where tenant_id=${tenant}`;
    await sql`delete from users where id=${user}`;
    await sql`delete from teams where tenant_id=${tenant}`;
    await sql`delete from tenants where id=${tenant}`;
  });
  it("requires both name and code and preserves old permissions without rotating plugin credentials", async () => {
    expect((await claim("Wrong Name")).statusCode).toBe(400);
    const result = await claim();
    expect(result.statusCode, result.body).toBe(200);
    ({ token, deviceId } = result.json());
    const policy = result.json().policy;
    policyVersion = policy.version;
    expect(policy.entries.map((e: any) => e.status).sort()).toEqual([
      "allowed",
      "denied",
    ]);
    expect(policy.pluginInstanceId).toBe(instance);
    expect(
      (await sql`select status from plugin_instances where id=${instance}`)[0]!
        .status,
    ).toBe("active");
    expect(
      (await app.inject({ method: "GET", url: "/v1/collector/project-scope" }))
        .statusCode,
    ).toBe(401);
  });
  it("rejects denied projects, invalid checksums, and incomplete batches", async () => {
    const run = await create([session("blocked", denied)]);
    expect((await send(run.id, run.part)).statusCode).toBe(403);
    expect((await finish(run.id)).statusCode).toBe(409);
    expect(
      (await send(run.id, { ...run.part, checksum: "c".repeat(64) })).json()
        .code,
    ).toBe("CHECKSUM_MISMATCH");
  });
  it("accepts full sessions exactly once and persists a verifiable receipt", async () => {
    const values = [
      session("first"),
      {
        ...session("question-only"),
        turns: [
          { id: "t", prompt: "not a contribution", questionTime: "12:00" },
        ],
      },
    ];
    const run = await create(values);
    completedID = run.id;
    expect((await send(run.id, run.part)).statusCode).toBe(200);
    expect((await send(run.id, run.part)).statusCode).toBe(200);
    expect((await finish(run.id)).json()).toEqual({
      id: run.id,
      status: "completed",
      sessionCount: 2,
    });
    expect((await finish(run.id)).statusCode).toBe(200);
    expect(
      (
        await sql`select sessions from collector_upload_parts where upload_id=${run.id}`
      )[0]!.sessions,
    ).toEqual(values);
    expect(
      (
        await sql`select count(*)::int as n from session_facts where tenant_id=${tenant}`
      )[0]!.n,
    ).toBe(0);
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/collector/uploads",
      headers: headers(),
      payload: { ...run.manifest, sessionCount: 3 },
    });
    expect(conflict.statusCode).toBe(409);
  });
  it("retains unsent sessions older than the period but analyses only in-period ones", async () => {
    const day = 86400_000;
    const older = {
      ...session("older-than-period"),
      modifiedAt: new Date(Date.parse(start) - 20 * day).toISOString(),
    };
    const values = [older, session("in-period")];
    const part = pack(values),
      id = randomUUID();
    const manifest = {
      id,
      periodKey,
      startsAt: older.modifiedAt,
      endsAt: end,
      policyVersion,
      sessionCount: values.length,
      partDigests: [part.checksum],
    };
    const tooOld = await app.inject({
      method: "POST",
      url: "/v1/collector/uploads",
      headers: headers(),
      payload: {
        ...manifest,
        id: randomUUID(),
        startsAt: new Date(Date.parse(start) - 63 * day).toISOString(),
      },
    });
    expect(tooOld.json().code).toBe("INVALID_COLLECTION_PERIOD");
    const created = await app.inject({
      method: "POST",
      url: "/v1/collector/uploads",
      headers: headers(),
      payload: manifest,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect((await send(id, part)).statusCode).toBe(200);
    expect((await finish(id)).json().sessionCount).toBe(2);
    const queued = await sql`select input_payload->>'sessionId' as session_id from agent_jobs j
      join collector_upload_jobs l on l.job_id=j.id where l.upload_id=${id}`;
    expect(queued.map((row) => row.session_id)).toEqual(["in-period"]);
  });
  it("deduplicates App logs, rejects arbitrary text, and records server receipt time", async () => {
    const event = {
      eventId: randomUUID(),
      occurredAt: end,
      stage: "upload",
      level: "error",
      code: "UPLOAD_FAILED",
      sessionCount: 2,
    };
    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/v1/collector/logs",
        headers: headers(),
        payload,
      });
    expect((await post({ events: [event] })).statusCode).toBe(200);
    expect((await post({ events: [event] })).statusCode).toBe(200);
    expect(
      (await post({ events: [{ ...event, text: "secret" }] })).statusCode,
    ).toBe(400);
    const rows =
      await sql`select * from collector_logs where device_id=${deviceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.received_at).toBeTruthy();
    expect(rows[0]!.message).toBeNull();
    expect(rows[0]!.details).toEqual({});
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/user-logs",
          headers: headers(),
        })
      ).statusCode,
    ).toBe(401);
    const userLogs = await app.inject({
      method: "GET",
      url: "/v1/admin/user-logs",
      headers: {
        cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
      },
    });
    expect(userLogs.statusCode, userLogs.body).toBe(200);
    const member = userLogs
      .json()
      .members.find((m: any) => m.partnerId === partner);
    expect(member.devices).toHaveLength(1);
    expect(member.severity).toBe("critical");
    expect(member.errorCount).toBeGreaterThanOrEqual(1);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/admin/user-logs/${partner}`,
      headers: {
        cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
      },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().events[0].code).toBe("UPLOAD_FAILED");
    expect(
      detail.json().uploads.some((u: any) => u.status === "completed"),
    ).toBe(true);
  });
  it("stores whitelisted details with server-side redaction and exposes them to admins", async () => {
    const eventId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/collector/logs",
      headers: headers(),
      payload: {
        events: [
          {
            eventId,
            occurredAt: new Date().toISOString(),
            stage: "upload",
            level: "error",
            code: "UPLOAD_PART_FAILED",
            sessionCount: 1,
            details: {
              message: "failed Bearer abcdefghijk under /Users/alice/proj",
              httpStatus: 503,
              errorKind: "server",
              partIndex: 1,
            },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const [row] =
      await sql`select message,details from collector_logs where device_id=${deviceId} and event_id=${eventId}`;
    expect(row!.message).not.toContain("abcdefghijk");
    expect(row!.message).not.toContain("/Users/alice");
    expect(row!.details).toEqual({
      httpStatus: 503,
      errorKind: "server",
      partIndex: 1,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collector/logs",
          headers: headers(),
          payload: {
            events: [
              {
                eventId: randomUUID(),
                occurredAt: new Date().toISOString(),
                stage: "upload",
                level: "error",
                code: "UPLOAD_FAILED",
                sessionCount: 0,
                details: { path: "/Users/alice/proj" },
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(400);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/admin/user-logs/${partner}`,
      headers: {
        cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
      },
    });
    const stored = detail
      .json()
      .events.find((event: any) => event.eventId === eventId);
    expect(stored.details).toEqual({
      httpStatus: 503,
      errorKind: "server",
      partIndex: 1,
    });
    expect(stored.message).toContain("<USER_HOME>");
  });
  it("accepts bounded device state, rejects arbitrary state fields and ignores an older observation", async () => {
    const state = {
      startupStage: "ready",
      projectCount: 3,
      allowedProjectCount: 2,
      sessionCount: 20,
      unreadableSessionCount: 1,
      pendingSessionCount: 4,
      isScanning: false,
      isUploading: false,
      scanProcessed: 20,
      scanTotal: 20,
      uploadProcessed: 0,
      uploadTotal: 0,
      autoUpload: true,
      frequency: "daily",
      uploadHour: 17,
      uploadMinute: 0,
    };
    const post = (value: object, occurredAt = new Date().toISOString()) =>
      app.inject({
        method: "POST",
        url: "/v1/collector/logs",
        headers: headers(),
        payload: {
          events: [
            {
              eventId: randomUUID(),
              occurredAt,
              stage: "heartbeat",
              level: "info",
              code: "ALIVE",
              sessionCount: 20,
              state: value,
            },
          ],
        },
      });
    expect((await post(state)).statusCode).toBe(200);
    expect(
      (await post({ ...state, folder: "/private/project" })).statusCode,
    ).toBe(400);
    expect((await post({ ...state, sessionCount: 1 }, start)).statusCode).toBe(
      200,
    );
    const [device] =
      await sql`select client_state,state_observed_at from collector_devices where id=${deviceId}`;
    expect(device!.client_state).toEqual(state);
    expect(device!.state_observed_at).toBeTruthy();
  });
  it("starts new members empty, supports their first App approval, and isolates another member's uploads", async () => {
    const freshPartner = randomUUID(),
      freshCode = `PR-${randomUUID()}`.toUpperCase();
    await sql`insert into partners (id,tenant_id,team_id,email,display_name) values (${freshPartner},${tenant},${team},${`${freshPartner}@test.local`},'New Member')`;
    await sql`insert into plugin_binding_codes (id,tenant_id,team_id,partner_id,code_hash,code_prefix,created_by)
      values (${randomUUID()},${tenant},${team},${freshPartner},${sha256(freshCode)},'PR-NEW',${user})`;
    const result = await app.inject({
      method: "POST",
      url: "/v1/collector/bindings/claim",
      payload: {
        bindingCode: freshCode,
        name: "New Member",
        deviceName: "New Mac",
        version: "0.2",
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().policy.entries).toEqual([]);
    const ownHeaders = { authorization: `Bearer ${result.json().token}` };
    const privateMessage = randomUUID();
    await sql`insert into app_notifications (id,tenant_id,team_id,partner_id,source_event_id,kind,title,body,target_type)
      values (${privateMessage},${tenant},${team},${partner},${randomUUID()},'test','Private','Private','app')`;
    const inbox = await app.inject({
      method: "GET",
      url: "/v1/collector/notifications",
      headers: ownHeaders,
    });
    expect(
      inbox.json().notifications.some((n: any) => n.id === privateMessage),
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collector/notifications/delivered",
          headers: ownHeaders,
          payload: { ids: [privateMessage] },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await sql`select delivered_at from app_notifications where id=${privateMessage}`
      )[0]!.delivered_at,
    ).toBeNull();
    const reviewID = randomUUID();
    await sql`insert into reviews (id,tenant_id,team_id,partner_id,period_id,state) select ${reviewID},${tenant},${team},${partner},id,'IN_PROGRESS' from report_periods where team_id=${team} and period_key=${periodKey}`;
    const reviews = await app.inject({
      method: "GET",
      url: "/v1/partner/reviews",
      headers: headers(),
    });
    expect(reviews.statusCode, reviews.body).toBe(200);
    expect(reviews.json().reviews.some((r: any) => r.id === reviewID)).toBe(
      true,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/reviews/${reviewID}`,
          headers: ownHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/collector/uploads/${completedID}/complete`,
          headers: ownHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const registered = await app.inject({
      method: "POST",
      url: "/v1/collector/project-scope/candidates",
      headers: ownHeaders,
      payload: {
        periodKey,
        candidates: [
          { scopeKey, displayName: "Fresh Project", sessionCount: 1 },
        ],
      },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const decided = await app.inject({
      method: "POST",
      url: "/v1/collector/project-scope/decisions",
      headers: ownHeaders,
      payload: {
        baseVersion: registered.json().version,
        decisions: [{ scopeKey, decision: "allow" }],
      },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().entries[0].status).toBe("allowed");
    const adminHeaders = {
      cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
    };
    const scopes = await app.inject({
      method: "GET",
      url: `/v1/admin/partners/${freshPartner}/project-scopes`,
      headers: adminHeaders,
    });
    expect(scopes.statusCode, scopes.body).toBe(200);
    expect(scopes.json().summary.allowed).toBe(1);
    expect(scopes.json().instances[0].projects[0].name).toBe("Fresh Project");
    const recovery = await app.inject({
      method: "POST",
      url: `/v1/admin/partners/${freshPartner}/binding-codes`,
      headers: adminHeaders,
      payload: { pluginInstanceId: result.json().policy.pluginInstanceId },
    });
    expect(recovery.statusCode, recovery.body).toBe(200);
    expect(recovery.json().recovery).toBe(true);
    const deniedOrigin = await app.inject({
      method: "POST",
      url: "/v1/collector/logs",
      headers: { ...ownHeaders, origin: "https://untrusted.example" },
      payload: { events: [] },
    });
    expect(deniedOrigin.statusCode).toBe(403);
  });
  it("durably queues outbox messages once and only acknowledges an explicit App receipt", async () => {
    const review = (
      await sql`select id from reviews where tenant_id=${tenant}`
    )[0]!;
    const eventID = randomUUID();
    await sql`insert into outbox_events (id,tenant_id,event_type,aggregate_type,aggregate_id,payload)
      values (${eventID},${tenant},'work_items.draft.created','review',${review.id},'{}'::jsonb)`;
    await dispatchAppNotifications(100, tenant);
    await dispatchAppNotifications(100, tenant);
    const queued =
      await sql`select * from app_notifications where source_event_id=${eventID}`;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.delivered_at).toBeNull();
    const get = () =>
      app.inject({
        method: "GET",
        url: "/v1/collector/notifications",
        headers: headers(),
      });
    const inbox = (await get()).json().notifications;
    expect(inbox.some((n: any) => n.id === queued[0]!.id)).toBe(true);
    for (const notification of inbox) {
      expect(notification.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(notification.createdAt).toBe(
        new Date(notification.createdAt).toISOString(),
      );
    }
    expect(
      (
        await sql`select delivered_at from app_notifications where id=${queued[0]!.id}`
      )[0]!.delivered_at,
    ).toBeNull();
    const ack = () =>
      app.inject({
        method: "POST",
        url: "/v1/collector/notifications/delivered",
        headers: headers(),
        payload: { ids: [queued[0]!.id] },
      });
    expect((await ack()).statusCode).toBe(200);
    expect((await ack()).statusCode).toBe(200);
    expect(
      (await get())
        .json()
        .notifications.some((n: any) => n.id === queued[0]!.id),
    ).toBe(false);
    expect(
      (
        await sql`select delivered_device_id from app_notifications where id=${queued[0]!.id}`
      )[0]!.delivered_device_id,
    ).toBe(deviceId);
    const test = await app.inject({
      method: "POST",
      url: `/v1/admin/partners/${partner}/notifications/test`,
      headers: {
        cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
      },
      payload: {},
    });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json().status).toBe("queued");
    const logs = await app.inject({
      method: "GET",
      url: "/v1/admin/system-logs",
      headers: {
        cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
      },
    });
    expect(logs.statusCode, logs.body).toBe(200);
  });
  it("notifies once when a running collector registers a newly discovered pending project", async () => {
    const key = sha256(randomUUID());
    const register = () => app.inject({
      method: "POST",
      url: "/v1/collector/project-scope/candidates",
      headers: headers(),
      payload: { periodKey, candidates: [{ scopeKey: key, displayName: "New runtime project", sessionCount: 1 }] },
    });
    const registered = await register();
    expect(registered.statusCode, registered.body).toBe(200);
    policyVersion = registered.json().version;
    expect(registered.json().entries.find((e: any) => e.scopeKey === key)?.status).toBe("pending");
    const events = await sql`select id from outbox_events where tenant_id=${tenant}
      and aggregate_id=${instance} and event_type='project_scope.candidates.changed'
      and payload->>'version'=${String(registered.json().version)}`;
    expect(events).toHaveLength(1);
    const inbox = await app.inject({ method: "GET", url: "/v1/collector/notifications", headers: headers() });
    expect(inbox.statusCode).toBe(200);
    const notices = await sql`select id,kind,target_type,title,body from app_notifications where source_event_id=${events[0]!.id}`;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "project_scope.candidates.changed", target_type: "projects", title: "新项目采集审批", body: "发现新项目，请确认是否允许采集会话。" });
    expect(inbox.json().notifications.some((n: any) => n.id === notices[0]!.id)).toBe(true);
    const repeated = await register();
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().version).toBe(registered.json().version);
    await dispatchAppNotifications(100, tenant);
    expect(await sql`select id from outbox_events where tenant_id=${tenant}
      and aggregate_id=${instance} and event_type='project_scope.candidates.changed'
      and payload->>'version'=${String(registered.json().version)}`).toHaveLength(1);
    expect(await sql`select id from app_notifications where source_event_id=${events[0]!.id}`).toHaveLength(1);
    await sql`delete from project_scope_entries where plugin_instance_id=${instance} and scope_key=${key}`;
  });
  it("consumes report events without notifying and suppresses queued notices while preserving receipts", async () => {
    const report = randomUUID();
    await sql`insert into team_reports (id,tenant_id,team_id,period_id)
      select ${report},${tenant},${team},id from report_periods where tenant_id=${tenant} and period_key=${periodKey}`;
    const eventIds = [randomUUID(), randomUUID()];
    const futureEventIds = [randomUUID(), randomUUID()];
    for (const [index, kind] of ["team_report.ready", "team_report.locked"].entries()) {
      await sql`insert into outbox_events (id,tenant_id,event_type,aggregate_type,aggregate_id,payload)
        values (${eventIds[index]!},${tenant},${kind},'team_report',${report},'{}'::jsonb)`;
      await sql`insert into app_notifications (id,tenant_id,team_id,partner_id,source_event_id,kind,title,body,target_type)
        values (${randomUUID()},${tenant},${team},${partner},${eventIds[index]!},${kind},'Old report notice','Body','report')`;
      await sql`insert into outbox_events (id,tenant_id,event_type,aggregate_type,aggregate_id,payload)
        values (${futureEventIds[index]!},${tenant},${kind},'team_report',${report},'{}'::jsonb)`;
    }
    const deliveredId = randomUUID();
    await sql`insert into app_notifications (id,tenant_id,team_id,partner_id,source_event_id,kind,title,body,target_type,delivered_at)
      values (${deliveredId},${tenant},${team},${partner},${randomUUID()},'team_report.ready','Delivered report','Body','report',now())`;
    await dispatchAppNotifications(100, tenant);
    await dispatchAppNotifications(100, tenant);
    const queuedNotices = await sql`select id from app_notifications where source_event_id in ${sql(eventIds)}`;
    expect(queuedNotices).toHaveLength(2);
    expect(await sql`select id from app_notifications where source_event_id in ${sql(futureEventIds)}`).toHaveLength(0);
    const inbox = await app.inject({ method: "GET", url: "/v1/collector/notifications", headers: headers() });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().notifications.some((n: any) => n.kind.startsWith("team_report."))).toBe(false);
    const inspection = await loadInspectionInput(sql, { tenantId: tenant, teamId: team }, new Date());
    expect(inspection.notifications.some((n) => queuedNotices.some((queued) => queued.id === n.id))).toBe(false);
    const lateReceipt = await app.inject({
      method: "POST", url: "/v1/collector/notifications/delivered", headers: headers(),
      payload: { ids: queuedNotices.map((n) => n.id) },
    });
    expect(lateReceipt.statusCode).toBe(200);
    expect(await sql`select id from app_notifications where id=${deliveredId}`).toHaveLength(1);
    const events = await sql`select published_at from outbox_events where id in ${sql([...eventIds, ...futureEventIds])}`;
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.published_at !== null)).toBe(true);
  });
  it("reports notification permission, offline and receipt states without leaking another member's messages", async () => {
    const adminHeaders = {
      cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
    };
    const queued = await app.inject({
      method: "POST",
      url: `/v1/admin/partners/${partner}/notifications/test`,
      headers: adminHeaders,
      payload: {},
    });
    const id = queued.json().id;
    const url = `/v1/admin/partners/${partner}/notifications/${id}`;
    const status = async () =>
      (await app.inject({ method: "GET", url, headers: adminHeaders })).json()
        .status;
    const report = async (code: string) => {
      const result = await app.inject({
        method: "POST",
        url: "/v1/collector/logs",
        headers: headers(),
        payload: {
          events: [
            {
              eventId: randomUUID(),
              occurredAt: new Date().toISOString(),
              stage: "notification",
              level: "info",
              code,
              sessionCount: 0,
            },
          ],
        },
      });
      expect(result.statusCode, result.body).toBe(200);
    };
    await report("NOTIFICATIONS_NOT_CONFIGURED");
    expect(await status()).toBe("permission_required");
    await report("NOTIFICATIONS_DENIED");
    expect(await status()).toBe("permission_denied");
    expect(
      (await sql`select delivered_at from app_notifications where id=${id}`)[0]!
        .delivered_at,
    ).toBeNull();
    await report("NOTIFICATIONS_ALLOWED");
    expect(await status()).toBe("queued");
    await sql`update collector_devices set last_log_at=now()-interval '10 minutes' where id=${deviceId}`;
    expect(await status()).toBe("app_offline");
    expect(
      (await app.inject({ method: "GET", url, headers: headers() })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/partners/${randomUUID()}/notifications/${id}`,
          headers: adminHeaders,
        })
      ).statusCode,
    ).toBe(404);
    const ack = await app.inject({
      method: "POST",
      url: "/v1/collector/notifications/delivered",
      headers: headers(),
      payload: { ids: [id] },
    });
    expect(ack.statusCode).toBe(200);
    expect(await status()).toBe("delivered");
  });
  it("lists one user-log entry per member and never mixes member events in the detail view", async () => {
    const otherPartner = randomUUID(),
      otherInstance = randomUUID(),
      otherBinding = randomUUID(),
      otherDevice = randomUUID(),
      secondDevice = randomUUID();
    await sql`insert into partners (id,tenant_id,team_id,email,display_name) values (${otherPartner},${tenant},${team},${`${otherPartner}@test.local`},'Log Member B')`;
    await sql`insert into plugin_instances (id,tenant_id,team_id,partner_id,device_name,version,status,access_token_hash,refresh_token_hash,access_expires_at)
      values (${otherInstance},${tenant},${team},${otherPartner},'Legacy B','2','collector',${sha256(randomUUID())},${sha256(randomUUID())},now()+interval '1 day')`;
    await sql`insert into plugin_binding_codes (id,tenant_id,team_id,partner_id,code_hash,code_prefix,plugin_instance_id,created_by,status)
      values (${otherBinding},${tenant},${team},${otherPartner},${sha256(randomUUID())},'PR-LOGB',${otherInstance},${user},'claimed')`;
    for (const id of [otherDevice, secondDevice])
      await sql`insert into collector_devices (id,tenant_id,team_id,partner_id,scope_instance_id,binding_code_id,device_name,version,token_hash,last_log_at)
        values (${id},${tenant},${team},${otherPartner},${otherInstance},${otherBinding},${id === otherDevice ? "B Mac" : "B Mac 2"},'0.3',${sha256(randomUUID())},now())`;
    const eventIds = {
      bUpload: randomUUID(),
      bScan: randomUUID(),
      bSecondDevice: randomUUID(),
      aMarker: randomUUID(),
    };
    const insertLog = (
      device: string,
      eventId: string,
      stage: string,
      level: string,
      code: string,
    ) =>
      sql`insert into collector_logs (device_id,event_id,occurred_at,stage,level,code,session_count,message,details)
        values (${device},${eventId},now(),${stage},${level},${code},0,${`message ${code}`},'{"httpStatus":500}'::jsonb)`;
    await insertLog(otherDevice, eventIds.bUpload, "upload", "error", "UPLOAD_FAILED");
    await insertLog(otherDevice, eventIds.bScan, "scan", "info", "SCAN_COMPLETED");
    await insertLog(secondDevice, eventIds.bSecondDevice, "heartbeat", "info", "ALIVE");
    await insertLog(deviceId, eventIds.aMarker, "app", "warning", "APP_LAUNCHED");
    const admin = {
      cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
    };
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: admin });
    try {
      const list = await get("/v1/admin/user-logs");
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json()).toMatchObject({
        onlineWindowMinutes: 5,
        windowHours: 24,
      });
      const members = list.json().members as any[];
      expect(members.filter((m) => m.partnerId === otherPartner)).toHaveLength(
        1,
      );
      expect(members.filter((m) => m.partnerId === partner)).toHaveLength(1);
      const memberB = members.find((m) => m.partnerId === otherPartner);
      expect(memberB.devices.map((d: any) => d.id).sort()).toEqual(
        [otherDevice, secondDevice].sort(),
      );
      expect(memberB.errorCount).toBe(1);
      expect(memberB.online).toBe(true);

      const detail = await get(`/v1/admin/user-logs/${otherPartner}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().partner).toEqual({
        id: otherPartner,
        name: "Log Member B",
      });
      const detailEvents = detail.json().events as any[];
      expect(detailEvents.map((e) => e.eventId).sort()).toEqual(
        [eventIds.bUpload, eventIds.bScan, eventIds.bSecondDevice].sort(),
      );
      expect(detailEvents.some((e) => e.eventId === eventIds.aMarker)).toBe(
        false,
      );
      expect(
        detailEvents.find((e) => e.eventId === eventIds.bUpload),
      ).toMatchObject({
        deviceId: otherDevice,
        deviceName: "B Mac",
        stage: "upload",
        level: "error",
        code: "UPLOAD_FAILED",
        message: "message UPLOAD_FAILED",
        details: { httpStatus: 500 },
      });
      expect(detail.json().window).toMatchObject({ mode: "recent" });
      expect(detail.json().devices).toHaveLength(2);
      expect(detail.json().uploads).toEqual([]);

      const errors = await get(
        `/v1/admin/user-logs/${otherPartner}?level=error`,
      );
      expect(errors.json().events.map((e: any) => e.eventId)).toEqual([
        eventIds.bUpload,
      ]);
      const scans = await get(
        `/v1/admin/user-logs/${otherPartner}?stage=scan`,
      );
      expect(scans.json().events.map((e: any) => e.eventId)).toEqual([
        eventIds.bScan,
      ]);
      const byDevice = await get(
        `/v1/admin/user-logs/${otherPartner}?deviceId=${secondDevice}`,
      );
      expect(byDevice.json().events.map((e: any) => e.eventId)).toEqual([
        eventIds.bSecondDevice,
      ]);

      const mine = await get(`/v1/admin/user-logs/${partner}`);
      expect(
        (mine.json().events as any[]).some((e) =>
          Object.values(eventIds).slice(0, 3).includes(e.eventId),
        ),
      ).toBe(false);
      expect(
        (mine.json().events as any[]).some((e) => e.eventId === eventIds.aMarker),
      ).toBe(true);

      expect((await get(`/v1/admin/user-logs/${otherPartner}?level=fatal`)).statusCode).toBe(400);
      expect((await get(`/v1/admin/user-logs/${otherPartner}?stage=bogus`)).statusCode).toBe(400);
      expect((await get(`/v1/admin/user-logs/${otherPartner}?date=2026-02-31`)).statusCode).toBe(400);
      const day = await get(`/v1/admin/user-logs/${otherPartner}?date=2020-01-01`);
      expect(day.statusCode).toBe(200);
      expect(day.json().window).toMatchObject({ mode: "day", date: "2020-01-01" });
      expect(day.json().events).toEqual([]);
      expect((await get(`/v1/admin/user-logs/${randomUUID()}`)).statusCode).toBe(404);
      expect((await get("/v1/admin/user-logs/not-a-uuid")).statusCode).toBe(400);
    } finally {
      await sql`delete from collector_logs where device_id in (${otherDevice},${secondDevice})`;
      await sql`delete from collector_devices where id in (${otherDevice},${secondDevice})`;
    }
  });
  it("applies native decisions with version checks and blocks a previously prepared batch after revocation", async () => {
    const run = await create([session("revoked")]);
    expect((await send(run.id, run.part)).statusCode).toBe(200);
    const decision = await app.inject({
      method: "POST",
      url: "/v1/collector/project-scope/decisions",
      headers: headers(),
      payload: {
        baseVersion: policyVersion,
        decisions: [{ scopeKey, decision: "deny" }],
      },
    });
    expect(decision.statusCode, decision.body).toBe(200);
    expect((await finish(run.id)).json().code).toBe("VERSION_CONFLICT");
    expect(
      (await loadProjectScopePolicy(identity)).entries.every(
        (e) => e.status === "denied",
      ),
    ).toBe(true);
    await sql`update plugin_binding_codes set status='revoked' where id=${bindingId}`;
    for (const url of ["/v1/collector/notifications", "/v1/partner/reviews"])
      expect(
        (await app.inject({ method: "GET", url, headers: headers() }))
          .statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collector/project-scope",
          headers: headers(),
        })
      ).statusCode,
    ).toBe(401);
  });
});
