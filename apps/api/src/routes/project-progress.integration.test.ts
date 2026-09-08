import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  addProgressDays,
  progressToday,
} from "@partner-report/contracts/project-progress";
import { buildApp } from "../server.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("project participation API", () => {
  const f = Object.fromEntries(
    [
      "tenant",
      "team",
      "otherTeam",
      "admin",
      "memberUser",
      "member",
      "otherMember",
      "foreignMember",
      "project",
      "parallelProject",
      "foreignProject",
      "period",
      "review",
      "card",
      "fact",
    ].map((key) => [key, randomUUID()]),
  ) as Record<string, string>;
  const today = progressToday("Asia/Shanghai");
  const first = addProgressDays(today, -7);
  const adminToken = `progress-admin-${f.admin}`;
  const memberToken = `progress-member-${f.memberUser}`;
  const headers = { cookie: `pra_session=${adminToken}` };
  const memberHeaders = { cookie: `pra_session=${memberToken}` };
  const path = (member = f.member!, project = f.project!) =>
    `/v1/project-progress/participations/${member}/${project}`;
  const start = [{ date: first, type: "start", reason: "开始业务开发" }];
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${f.tenant!}, 'Progress Test')`;
      for (const team of [f.team!, f.otherTeam!])
        await tx`insert into teams (id, tenant_id, name, timezone) values (${team}, ${f.tenant!}, 'Progress Team', 'Asia/Shanghai')`;
      for (const [user, token, roles] of [
        [f.admin!, adminToken, ["admin"]],
        [f.memberUser!, memberToken, ["partner"]],
      ] as const) {
        await tx`insert into users (id, email, display_name, password_hash) values (${user}, ${`${user}@progress.test`}, 'Fixture User', 'unused')`;
        await tx`insert into memberships (id, tenant_id, team_id, user_id, roles) values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${user}, ${JSON.stringify([...roles])}::jsonb)`;
        await tx`insert into web_sessions (id, user_id, token_hash, expires_at) values (${randomUUID()}, ${user}, ${createHash("sha256").update(token).digest("hex")}, ${new Date(Date.now() + 3600000).toISOString()})`;
      }
      for (const member of [f.member!, f.otherMember!, f.foreignMember!])
        await tx`insert into partners (id, tenant_id, team_id, email, display_name) values (${member}, ${f.tenant!}, ${member === f.foreignMember ? f.otherTeam! : f.team!}, ${`${member}@progress.test`}, 'Fixture Member')`;
      await tx`update memberships set partner_id = ${f.member!} where user_id = ${f.memberUser!}`;
      for (const project of [f.project!, f.parallelProject!, f.foreignProject!])
        await tx`insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids) values (${project}, ${f.tenant!}, ${project === f.foreignProject ? f.otherTeam! : f.team!}, ${project === f.project ? "项目 A" : "项目 B"}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone) values (${f.period!}, ${f.tenant!}, ${f.team!}, 'business-week', ${`${first}T00:00:00+08:00`}, ${`${today}T23:59:59+08:00`}, ${`${today}T23:59:59+08:00`}, ${`${today}T23:59:59+08:00`}, 'Asia/Shanghai')`;
      await tx`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state) values (${f.review!}, ${f.tenant!}, ${f.team!}, ${f.member!}, ${f.period!}, 'IN_PROGRESS')`;
      await tx`insert into session_facts (id, tenant_id, team_id, partner_id, period_id, session_id, external_fact_id, source_revision, source_hash, source_occurred_at, payload) values (${f.fact!}, ${f.tenant!}, ${f.team!}, ${f.member!}, ${f.period!}, 'session', 'external', 1, 'hash', ${`${first}T12:00:00+08:00`}, ${JSON.stringify({ projectId: f.project!, summary: "最新采集贡献" })}::jsonb)`;
      await tx`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, review_status, fact_ids, payload) values (${f.card!}, ${f.tenant!}, ${f.team!}, ${f.member!}, ${f.period!}, ${f.review!}, ${f.project!}, '项目 A', 'completed', 'approved', ${JSON.stringify([f.fact!])}::jsonb, ${JSON.stringify({ dailyProgress: [{ date: first, summary: "已核查进展" }] })}::jsonb)`;
    });
    // Raw revisions and an unrelated project upload must never become calendar entries.
    await sql`update session_facts set updated_at = now() + interval '1 minute' where id = ${f.fact!}`;
    await sql`insert into session_facts (id, tenant_id, team_id, partner_id, period_id, session_id, external_fact_id, source_revision, source_hash, source_occurred_at, payload) values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${f.member!}, ${f.period!}, 'raw-only-session', 'raw-only', 1, 'raw-only', ${`${today}T12:00:00+08:00`}, ${JSON.stringify({ projectId: f.parallelProject!, summary: "尚未审核的新采集" })}::jsonb)`;
    for (const status of ["pending", "excluded"]) {
      await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, review_status, fact_ids, payload) values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${f.member!}, ${f.period!}, ${f.review!}, ${f.parallelProject!}, '未通过的项目 B', 'completed', ${status}, '[]'::jsonb, ${JSON.stringify({ dailyProgress: [{ date: today, summary: "未经审核通过的每日内容" }] })}::jsonb)`;
    }
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app?.close();
    await sql.begin(async (tx) => {
      await tx`delete from project_participation_versions where participation_id in (select id from project_participations where tenant_id = ${f.tenant!})`;
      for (const table of [
        "project_participations",
        "audit_events",
        "work_items",
        "session_facts",
        "reviews",
        "report_periods",
        "memberships",
        "partners",
        "projects",
      ])
        await tx`delete from ${tx(table)} where tenant_id = ${f.tenant!}`;
      await tx`delete from web_sessions where user_id in (${f.admin!}, ${f.memberUser!})`;
      await tx`delete from users where id in (${f.admin!}, ${f.memberUser!})`;
      await tx`delete from teams where tenant_id = ${f.tenant!}`;
      await tx`delete from tenants where id = ${f.tenant!}`;
    });
  });
  it("requires authentication and restricts the team dashboard to admins", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/v1/admin/project-progress" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/project-progress",
          headers: memberHeaders,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("reads only approved daily card content and does not infer project completion from weekly status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/project-progress",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.members).toHaveLength(2);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      contributionDays: 1,
      version: 0,
      metrics: { state: "unknown", elapsedDays: null },
      days: [
        {
          date: first,
          entries: [
            {
              summary: "已核查进展",
              source: "reviewed",
              periodKey: "business-week",
            },
          ],
        },
      ],
    });
  });
  it("reflects card approval, edited daily content and exclusion on the next refresh", async () => {
    const read = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/project-progress",
          headers,
        })
      ).json();
    try {
      await sql`update work_items set review_status = 'pending' where id = ${f.card!}`;
      expect((await read()).projects).toEqual([]);
      const summary = "用户核对后的每日进展\n完整保留第二行";
      await sql`update work_items set review_status = 'approved', payload = ${JSON.stringify({ dailyProgress: [{ date: today, summary }] })}::jsonb where id = ${f.card!}`;
      const project = (await read()).projects[0];
      expect(project.days).toEqual([
        {
          date: today,
          entries: [
            {
              id: `${f.card!}:0`,
              summary,
              source: "reviewed",
              reviewId: f.review,
              periodKey: "business-week",
            },
          ],
        },
      ]);
      expect(project.latestProgress.summary).toBe(summary);
      await sql`update work_items set review_status = 'excluded' where id = ${f.card!}`;
      expect((await read()).projects).toEqual([]);
    } finally {
      await sql`update work_items set review_status = 'approved', payload = ${JSON.stringify({ dailyProgress: [{ date: first, summary: "已核查进展" }] })}::jsonb where id = ${f.card!}`;
    }
  });
  it("rejects cross-member and cross-team reads and writes", async () => {
    for (const method of ["GET", "POST"] as const) {
      const payload =
        method === "POST"
          ? { payload: { baseVersion: 0, events: start, note: "测试核查" } }
          : {};
      expect(
        (
          await app.inject({
            method,
            url: path(f.otherMember!),
            headers: memberHeaders,
            ...payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method,
            url: path(f.foreignMember!, f.foreignProject!),
            headers,
            ...payload,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method,
            url: path(f.member!, f.foreignProject!),
            headers,
            ...payload,
          })
        ).statusCode,
      ).toBe(404);
    }
  });
  it("rejects invalid transitions, future dates and unrelated review links without writing", async () => {
    for (const events of [
      [{ date: first, type: "resume", reason: "" }],
      [{ date: addProgressDays(today, 1), type: "start", reason: "" }],
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: path(),
            headers,
            payload: { baseVersion: 0, events, note: "错误核查" },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(f.otherMember!),
          headers,
          payload: {
            baseVersion: 0,
            events: start,
            note: "错误关联",
            reviewId: f.review,
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: path(), headers })).json()
        .version,
    ).toBe(0);
  });
  it("atomically saves weekly corrections and rejects stale concurrent writers", async () => {
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: path(),
          headers: memberHeaders,
          payload: {
            baseVersion: 0,
            events: start,
            note: "本周核对开始时间",
            reviewId: f.review,
          },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    let read = (
      await app.inject({ method: "GET", url: path(), headers })
    ).json();
    expect(read.version).toBe(1);
    expect(read.history).toHaveLength(1);
    expect(read.history[0].reviewId).toBe(f.review);
    const events = [
      ...start,
      {
        date: addProgressDays(first, 2),
        type: "pause",
        reason: "临时支援另一个项目",
      },
      { date: addProgressDays(first, 5), type: "resume", reason: "支援结束" },
    ];
    const response = await app.inject({
      method: "POST",
      url: path(),
      headers,
      payload: { baseVersion: 1, events, note: "补充暂停及恢复时间" },
    });
    expect(response.statusCode).toBe(200);
    read = (await app.inject({ method: "GET", url: path(), headers })).json();
    expect(read.history).toHaveLength(2);
    expect(read.history[1].events).toEqual(start);
    const dashboard = (
      await app.inject({
        method: "GET",
        url: "/v1/admin/project-progress",
        headers,
      })
    ).json();
    expect(dashboard.projects[0].metrics).toMatchObject({
      elapsedDays: 8,
      pausedDays: 3,
      activeDays: 5,
    });
    const audit =
      await sql`select id from audit_events where tenant_id = ${f.tenant!} and action = 'project_participation.updated'`;
    expect(audit).toHaveLength(2);
  });
  it("supports overlapping projects independently and validates the date window", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(f.member!, f.parallelProject!),
          headers,
          payload: { baseVersion: 0, events: start, note: "并行开发项目 B" },
        })
      ).statusCode,
    ).toBe(200);
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/admin/project-progress",
        headers,
      })
    ).json();
    expect(body.projects).toHaveLength(2);
    expect(
      body.projects.find((p: any) => p.projectId === f.parallelProject).metrics,
    ).toMatchObject({ activeDays: 8, pausedDays: 0 });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/project-progress?from=${today}&to=${first}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/project-progress?from=2026-02-30`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("persists project stage confirmations without inventing an overall start date", async () => {
    const events = [
      {
        date: today,
        type: "milestone",
        stage: "validation",
        reason: "核心功能完成，进入联调",
      },
    ];
    const saved = await app.inject({
      method: "POST",
      url: path(f.otherMember!),
      headers,
      payload: { baseVersion: 0, events, note: "确认当前项目阶段" },
    });
    expect(saved.statusCode).toBe(200);
    const read = (
      await app.inject({ method: "GET", url: path(f.otherMember!), headers })
    ).json();
    expect(read.events).toEqual(events);
    expect(read.history[0].events).toEqual(events);
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/admin/project-progress",
        headers,
      })
    ).json();
    expect(
      body.projects.find((p: any) => p.partnerId === f.otherMember).metrics
        .elapsedDays,
    ).toBeNull();
  });
});
