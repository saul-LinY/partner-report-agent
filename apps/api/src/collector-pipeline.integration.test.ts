import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchAppNotifications, sqlClient as sql } from "@partner-report/db";
import { buildApp } from "./server.js";
import { sha256 } from "./common.js";
import { signSessionToken } from "./auth-security.js";
import {
  loadProjectScopePolicy,
  registerProjectScopeCandidates,
} from "./project-scope.js";
import { processNextGenerationJob } from "../../worker/src/generation.js";
import { scheduleCollectorCards } from "../../worker/src/collector-pipeline.js";
import { scheduleDueTeamReports } from "../../worker/src/weekly.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("native upload to reviewed report pipeline", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    partner = randomUUID(),
    user = randomUUID(),
    instance = randomUUID(),
    binding = randomUUID(),
    device = randomUUID();
  const period = randomUUID(),
    token = randomUUID(),
    webToken = randomUUID(),
    scopeKey = "d".repeat(64),
    periodKey = `pipeline-${randomUUID()}`;
  const start = new Date(Date.now() - 86_400_000).toISOString(),
    end = new Date(Date.now() + 4 * 86_400_000).toISOString();
  const bearer = { authorization: `Bearer ${token}` };
  const identity = {
    tenantId: tenant,
    teamId: team,
    partnerId: partner,
    pluginInstanceId: instance,
  };
  const production = {
    skillVersion: "partner-report-platform/0.3.0",
    promptVersion: "integration-test",
    schemaVersion: "1.0",
    producer: "data-platform",
  };
  let app: Awaited<ReturnType<typeof buildApp>>,
    policyVersion: number,
    failSecondChunk = true;
  const calls: Array<{ name: string; input: any }> = [];
  const admin = () => ({
    cookie: `pra_session=${signSessionToken(webToken, process.env.SESSION_SECRET?.trim())}`,
  });
  const session = (answer = "Implemented upload receipts. ".repeat(2200)) => ({
    id: "meaningful",
    scopeKey,
    agent: "codex",
    title: "Receipt work",
    modifiedAt: new Date().toISOString(),
    turns: [
      {
        id: "turn",
        prompt: "Implement receipts",
        answer,
        questionTime: new Date().toISOString(),
      },
    ],
  });
  async function upload(sessions: any[]) {
    const id = randomUUID(),
      data = Buffer.from(JSON.stringify(sessions)),
      checksum = sha256(data);
    const create = await app.inject({
      method: "POST",
      url: "/v1/collector/uploads",
      headers: bearer,
      payload: {
        id,
        periodKey,
        startsAt: start,
        endsAt: new Date().toISOString(),
        policyVersion,
        sessionCount: sessions.length,
        partDigests: [checksum],
      },
    });
    expect(create.statusCode, create.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/collector/uploads/${id}/parts`,
          headers: bearer,
          payload: { partIndex: 0, checksum, data: data.toString("base64") },
        })
      ).statusCode,
    ).toBe(200);
    const complete = await app.inject({
      method: "POST",
      url: `/v1/collector/uploads/${id}/complete`,
      headers: bearer,
      payload: {},
    });
    expect(complete.statusCode, complete.body).toBe(200);
    return id;
  }
  async function drain() {
    for (let i = 0; i < 15; i++) {
      const result = await processNextGenerationJob(tenant);
      if (!result.processed) return;
    }
    throw new Error("Pipeline did not drain");
  }
  async function row(table: "reviews" | "work_items" | "team_reports") {
    return (
      await sql`select * from ${sql(table)} where tenant_id=${tenant} order by created_at limit 1`
    )[0]!;
  }
  beforeAll(async () => {
    vi.stubEnv("MODEL_API_KEY", "test-only");
    vi.stubEnv("MODEL_API_BASE_URL", "http://pipeline-model.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const input = JSON.parse(
          body.input[1].content[0].text
            .split("<partner_report_data>\n")[1]
            .split("\n</partner_report_data>")[0],
        );
        const name = body.text.format.name;
        calls.push({ name, input });
        let output: any;
        if (name === "partner_collector_extraction") {
          if (input.chunk === 2 && failSecondChunk) {
            failSecondChunk = false;
            return new Response("{}", { status: 401 });
          }
          const evidence = input.evidence.find(
            (e: any) => e.role === "assistant",
          );
          output = evidence
            ? {
                decision: "include",
                reason: "Implemented",
                title: "上传回执",
                summary: "完成整包回执校验",
                contributions: [
                  {
                    kind: "outcome",
                    text: "完成上传回执校验，连接中断后可安全续传。",
                    confidence: "high",
                    date: evidence.date,
                    evidenceRefs: [evidence.ref],
                  },
                ],
              }
            : {
                decision: "ignore",
                reason: "Only a request",
                title: "",
                summary: "",
                contributions: [],
              };
        } else if (name === "partner_project_outcomes")
          output = {
            projectPurpose: "可靠上传",
            weeklyFocus: ["上传回执"],
            daily: [
              {
                date: input.facts[0].date,
                outcomes: [
                  {
                    done: "完成回执校验",
                    purpose: "防止误报上传成功",
                    unfinished: [],
                    evidenceRefs: [input.facts[0].ref],
                  },
                ],
              },
            ],
          };
        else if (name === "partner_team_project_progress")
          output = { progress: "本周完成上传回执校验。" };
        else if (name === "partner_team_report")
          output = {
            summary: "完成上传可靠性改进。",
            partnerSummaries: Object.fromEntries(
              input.people.map((p: any) => [p.ref, "完成上传回执校验。"]),
            ),
            blockers: [],
          };
        else
          output = {
            schemaVersion: "1.0",
            groups: input.projectBuckets.map((b: any) => ({
              projectKey: b.projectKey,
              status: "in_progress",
              projectStatus: "development",
              projectStatusReason: "已实现回执",
              overview: "完成整包回执校验，避免上传状态误报。",
              dailyProgress: b.outcomeMaterial.daily.map((d: any) => ({
                date: d.date,
                summary: "完成回执校验。",
              })),
            })),
            qualityWarnings: [],
            production,
          };
        return new Response(
          JSON.stringify({ output_text: JSON.stringify(output) }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    await sql`insert into tenants(id,name) values(${tenant},'Pipeline test')`;
    await sql`insert into teams(id,tenant_id,name,timezone,report_type) values(${team},${tenant},'Pipeline team','Asia/Shanghai','weekly')`;
    await sql`insert into users(id,email,display_name,password_hash) values(${user},${`${user}@test.local`},'Test','unused')`;
    await sql`insert into memberships(id,tenant_id,team_id,user_id,roles) values(${randomUUID()},${tenant},${team},${user},'["admin"]'::jsonb)`;
    await sql`insert into partners(id,tenant_id,team_id,user_id,email,display_name) values(${partner},${tenant},${team},${user},${`${partner}@test.local`},'Pipeline member')`;
    await sql`insert into web_sessions(id,user_id,token_hash,expires_at) values(${randomUUID()},${user},${sha256(webToken)},now()+interval '1 hour')`;
    await sql`insert into plugin_instances(id,tenant_id,team_id,partner_id,access_token_hash,refresh_token_hash,access_expires_at,version,device_name) values(${instance},${tenant},${team},${partner},${randomUUID()},${randomUUID()},now()+interval '1 day','test','Test Mac')`;
    await sql`insert into plugin_binding_codes(id,tenant_id,team_id,partner_id,code_hash,code_prefix,plugin_instance_id,created_by,status) values(${binding},${tenant},${team},${partner},${randomUUID()},'TEST',${instance},${user},'claimed')`;
    await sql`insert into collector_devices(id,tenant_id,team_id,partner_id,scope_instance_id,binding_code_id,device_name,version,token_hash) values(${device},${tenant},${team},${partner},${instance},${binding},'Test Mac','test',${sha256(token)})`;
    await sql`insert into report_periods(id,tenant_id,team_id,period_key,starts_at,ends_at,cutoff_at,submission_deadline_at,timezone,status) values(${period},${tenant},${team},${periodKey},${start},${end},${end},${end},'Asia/Shanghai','open')`;
    await registerProjectScopeCandidates(identity, {
      periodKey,
      candidates: [
        { scopeKey, displayName: "Receipt project", sessionCount: 2 },
      ],
    });
    await sql`update project_scope_entries set status='allowed',decided_at=now() where plugin_instance_id=${instance}`;
    policyVersion = (await loadProjectScopePolicy(identity)).version;
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await sql`delete from collector_upload_parts where upload_id in (select id from collector_uploads where device_id=${device})`;
    await sql`delete from collector_uploads where device_id=${device}`;
    await sql`delete from collector_logs where device_id=${device}`;
    for (const table of [
      "app_notifications",
      "work_item_facts",
      "work_item_versions",
      "project_outcome_drafts",
      "work_item_snapshots",
      "work_items",
      "fact_snapshots",
      "coverage_snapshots",
      "session_facts",
      "session_records",
      "reviews",
      "team_report_versions",
      "team_reports",
      "agent_jobs",
      "outbox_events",
      "audit_events",
      "project_description_candidates",
      "project_scope_aliases",
      "project_scope_entries",
      "project_scope_policies",
      "projects",
      "collector_devices",
      "plugin_binding_codes",
      "plugin_instances",
      "report_periods",
      "partners",
      "memberships",
    ]) {
      if (table === "work_item_facts")
        await sql`delete from work_item_facts where work_item_id in(select id from work_items where tenant_id=${tenant})`;
      else if (table === "project_scope_aliases")
        await sql`delete from project_scope_aliases where plugin_instance_id=${instance}`;
      else await sql`delete from ${sql(table)} where tenant_id=${tenant}`;
    }
    await sql`delete from web_sessions where user_id=${user}`;
    await sql`delete from users where id=${user}`;
    await sql`delete from teams where id=${team}`;
    await sql`delete from tenants where id=${tenant}`;
  });
  it("checkpoints failed analysis, retries, deduplicates, generates cards and reopens review on changed evidence", async () => {
    const meaningful = session(),
      questionOnly = { ...session(""), id: "question-only" };
    const uploadId = await upload([meaningful, questionOnly]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collector/pipeline",
          headers: bearer,
        })
      ).json().uploads[0].stage,
    ).toBe("analyzing");
    await drain();
    const [failed] =
      await sql`select * from agent_jobs where tenant_id=${tenant} and status='FAILED'`;
    expect(failed!.error_code).toBe("MODEL_AUTH_FAILED");
    expect(failed!.output_payload.chunks).toHaveLength(1);
    const retry = await app.inject({
      method: "POST",
      url: `/v1/admin/collector-uploads/${uploadId}/retry`,
      headers: admin(),
    });
    expect(retry.statusCode, retry.body).toBe(200);
    await drain();
    expect(
      calls.filter(
        (c) =>
          c.name === "partner_collector_extraction" &&
          c.input.chunk === 1 &&
          c.input.evidence.some((e: any) => e.role === "assistant"),
      ),
    ).toHaveLength(1);
    expect(await scheduleCollectorCards(tenant)).toBe(1);
    await drain();
    const card = await row("work_items");
    expect(card.review_status).toBe("pending");
    expect(
      (await sql`select id from coverage_snapshots where tenant_id=${tenant}`)
        .length,
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/partner/reviews",
          headers: bearer,
        })
      ).json().reviews,
    ).toHaveLength(1);
    const jobCount = (
      await sql`select count(*)::int as n from agent_jobs where tenant_id=${tenant}`
    )[0]!.n;
    await upload([meaningful, questionOnly]);
    await drain();
    expect(await scheduleCollectorCards(tenant)).toBe(0);
    expect(
      (
        await sql`select count(*)::int as n from agent_jobs where tenant_id=${tenant}`
      )[0]!.n,
    ).toBe(jobCount);
    await dispatchAppNotifications(100, tenant);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collector/notifications",
          headers: bearer,
        })
      ).json().notifications.length,
    ).toBeGreaterThan(0);
    await sql`update work_items set review_status='approved' where id=${card.id}`;
    await sql`update reviews set state='ITEMS_APPROVED',pending_count=0,approved_count=1 where tenant_id=${tenant}`;
    await upload([session("Implemented amended upload receipt checks.")]);
    await drain();
    expect(await scheduleCollectorCards(tenant)).toBe(1);
    await drain();
    const updated = await row("work_items");
    expect(updated.id).toBe(card.id);
    expect(updated.review_status).toBe("pending");
    expect(updated.payload.outcomeDraftId).not.toBe(
      card.payload.outcomeDraftId,
    );
    expect((await row("reviews")).state).toBe("IN_PROGRESS");
  });
  it("finishes native review commands and generates a report from approved snapshots only", async () => {
    const review = await row("reviews"),
      card = await row("work_items");
    const decide = await app.inject({
      method: "POST",
      url: `/v1/reviews/${review.id}/items/${card.id}/decision`,
      headers: bearer,
      payload: { baseVersion: review.version, decision: "approve" },
    });
    expect(decide.statusCode, decide.body).toBe(200);
    expect((await row("reviews")).state).toBe("ITEMS_APPROVED");
    const generated = await app.inject({
      method: "POST",
      url: "/v1/admin/team-reports/generate",
      headers: admin(),
      payload: { periodId: period },
    });
    expect(generated.statusCode, generated.body).toBe(200);
    const interruptedAnalysis = randomUUID();
    await sql`insert into agent_jobs(id,tenant_id,team_id,partner_id,type,status,idempotency_key,input_payload)
      values(${interruptedAnalysis},${tenant},${team},${partner},'EXTRACT_COLLECTOR_SESSION','FAILED',
        ${interruptedAnalysis},${JSON.stringify({ period: { id: period } })}::jsonb)`;
    await drain();
    expect((await row("team_reports")).status).toBe("WAITING_SUBMISSIONS");
    expect(
      (await sql`select id from team_report_versions where tenant_id=${tenant}`)
        .length,
    ).toBe(0);
    await sql`delete from agent_jobs where id=${interruptedAnalysis}`;
    expect(await scheduleDueTeamReports(period)).toBe(1);
    await drain();
    const [report] =
      await sql`select * from team_reports where tenant_id=${tenant}`;
    expect(report!.status).toBe("LOCKED");
    expect(report!.current_version).toBe(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collector/pipeline",
          headers: bearer,
        })
      ).json().uploads[0].stage,
    ).toBe("archived");
    const [version] =
      await sql`select * from team_report_versions where tenant_id=${tenant}`;
    expect(version!.markdown).toContain("Receipt project");
  });
});
