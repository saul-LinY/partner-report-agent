import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { progressToday } from "@partner-report/contracts/project-progress";
import type { PersonalData } from "@partner-report/contracts/member-overview";
import { emptyProfileNote } from "@partner-report/contracts/project-profile";
import { buildApp } from "../server.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("personal data API", () => {
  const f = Object.fromEntries(
    ["tenant", "team", "user", "period", "alice", "bob"].map((key) => [
      key,
      randomUUID(),
    ]),
  ) as Record<string, string>;
  const DAY = 86_400_000;
  const startsAt = new Date(Date.now() - 3 * DAY);
  const cutoffAt = new Date(Date.now() + 3 * DAY);
  const tokens = { alice: `alice-${randomUUID()}`, bob: `bob-${randomUUID()}` };
  const day = (offset: number) =>
    progressToday("Asia/Shanghai", new Date(Date.now() + offset * DAY));
  let app: FastifyInstance;

  const contribution = (
    kind: string,
    text: string,
    offset: number,
    plain?: string,
  ) => ({
    kind,
    text,
    ...(plain ? { plain } : {}),
    confidence: "high",
    date: day(offset),
    evidenceRefs: ["T1:assistant:0"],
  });
  const fact = (
    partner: string,
    project: string,
    session: string,
    offset: number,
    contributions: unknown[],
    flags: { current?: boolean; excluded?: boolean } = {},
  ) =>
    sql`insert into session_facts (id, tenant_id, team_id, partner_id, period_id, session_id, external_fact_id, source_revision, source_hash, source_occurred_at, payload, current, excluded)
      values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${f.period!}, ${session}, ${`${session}:${offset}`}, 1, 'hash',
        ${new Date(Date.now() + offset * DAY).toISOString()},
        ${JSON.stringify({ recordType: "session_contribution", project: { id: randomUUID(), name: project }, contributions })}::jsonb,
        ${flags.current ?? true}, ${flags.excluded ?? false})`;

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${f.tenant!}, 'Personal Data Test')`;
      await tx`insert into teams (id, tenant_id, name, timezone) values (${f.team!}, ${f.tenant!}, 'Team', 'Asia/Shanghai')`;
      await tx`insert into users (id, email, display_name, password_hash) values (${f.user!}, ${`${f.user}@personal.test`}, 'Creator', 'unused')`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone) values (${f.period!}, ${f.tenant!}, ${f.team!}, 'business-week', ${startsAt.toISOString()}, ${cutoffAt.toISOString()}, ${cutoffAt.toISOString()}, ${cutoffAt.toISOString()}, 'Asia/Shanghai')`;
      for (const [who, name] of [
        ["alice", "Alice 的项目"],
        ["bob", "Bob 的项目"],
      ] as const) {
        const partner = f[who]!;
        const instance = randomUUID();
        const binding = randomUUID();
        await tx`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${f.tenant!}, ${f.team!}, ${`${partner}@personal.test`}, ${who})`;
        await tx`insert into plugin_instances (id, tenant_id, team_id, partner_id, device_name, version, status, access_token_hash, refresh_token_hash, access_expires_at)
          values (${instance}, ${f.tenant!}, ${f.team!}, ${partner}, 'Legacy', '2', 'collector', ${sha256(randomUUID())}, ${sha256(randomUUID())}, now() + interval '1 day')`;
        await tx`insert into plugin_binding_codes (id, tenant_id, team_id, partner_id, code_hash, code_prefix, plugin_instance_id, created_by, status)
          values (${binding}, ${f.tenant!}, ${f.team!}, ${partner}, ${sha256(randomUUID())}, 'PR-PD', ${instance}, ${f.user!}, 'claimed')`;
        await tx`insert into collector_devices (id, tenant_id, team_id, partner_id, scope_instance_id, binding_code_id, device_name, version, token_hash)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${instance}, ${binding}, 'Mac', '0.3', ${sha256(tokens[who])})`;
        await tx`insert into project_scope_entries (id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key, display_name, status, first_seen_period_key)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${instance}, ${`scope-${who}`}, ${name}, 'allowed', 'business-week')`;
        await tx`insert into project_profiles (id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key, note)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${instance}, ${`scope-${who}`},
            ${JSON.stringify({ ...emptyProfileNote, oneLine: { text: who === "alice" ? "甲的一句话" : "乙的一句话", refs: [] } })}::jsonb)`;
      }
    });
    // Alice: an old fact without `plain` (falls back to text), a newer one with it, and two facts that must not count.
    await fact(f.alice!, "Alice 的项目", "alice-s1", -2, [
      contribution("outcome", "旧成果原文", -2),
      contribution("outcome", "成果二原文", -2, "成果二"),
      contribution("decision", "决定一原文", -2, "决定一"),
      contribution("blocker", "卡点一原文", -2, "卡点一"),
      contribution("progress", "进行中不展示", -2, "不展示"),
    ]);
    await fact(f.alice!, "Alice 的项目", "alice-s2", -1, [
      contribution("outcome", "成果三原文", -1, "成果三"),
      contribution("outcome", "成果四原文", -1, "成果四"),
      contribution("decision", "决定二原文", -1, "决定二"),
      contribution("decision", "决定三原文", -1, "决定三"),
    ]);
    await fact(
      f.alice!,
      "Alice 的项目",
      "alice-s3",
      0,
      [contribution("outcome", "已被取代", 0, "已被取代")],
      { current: false },
    );
    await fact(
      f.alice!,
      "Alice 的项目",
      "alice-s4",
      0,
      [contribution("outcome", "已被排除", 0, "已被排除")],
      { excluded: true },
    );
    await fact(f.bob!, "Bob 的项目", "bob-s1", -1, [
      contribution("outcome", "bob 的成果", -1, "bob 的成果"),
    ]);
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await sql.begin(async (tx) => {
      for (const table of [
        "session_facts",
        "project_profiles",
        "project_scope_entries",
        "collector_devices",
        "plugin_binding_codes",
        "plugin_instances",
        "report_periods",
        "partners",
      ])
        await tx`delete from ${tx(table)} where tenant_id = ${f.tenant!}`;
      await tx`delete from users where id = ${f.user!}`;
      await tx`delete from teams where tenant_id = ${f.tenant!}`;
      await tx`delete from tenants where id = ${f.tenant!}`;
    });
  });

  const get = (who: keyof typeof tokens, query = "") =>
    app.inject({
      method: "GET",
      url: `/v1/collector/personal-data${query}`,
      headers: { authorization: `Bearer ${tokens[who]}` },
    });

  it("requires an App binding", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collector/personal-data",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collector/personal-data",
          headers: { authorization: "Bearer not-a-device" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("returns the open period and only the bound member's own projects", async () => {
    for (const [who, name] of [
      ["alice", "Alice 的项目"],
      ["bob", "Bob 的项目"],
    ] as const) {
      const response = await get(who);
      expect(response.statusCode).toBe(200);
      const data = response.json<PersonalData>();
      expect(data.member).toEqual({ id: f[who], name: who });
      expect(data.timezone).toBe("Asia/Shanghai");
      expect(data.period).toMatchObject({
        periodKey: "business-week",
        startsAt: startsAt.toISOString(),
        cutoffAt: cutoffAt.toISOString(),
      });
      expect(Date.parse(data.period.autoApproveAt)).toBeGreaterThan(
        cutoffAt.getTime(),
      );
      expect(Date.parse(data.period.publishAt)).toBeGreaterThan(
        Date.parse(data.period.autoApproveAt),
      );
      expect(data.lastUpload).toBeNull();
      expect(data.projects.map((item) => item.name)).toEqual([name]);
      expect(data.projects[0]!.oneLine).toBe(
        who === "alice" ? "甲的一句话" : "乙的一句话",
      );
      expect(JSON.stringify(data)).not.toContain(
        who === "alice" ? "bob 的成果" : "成果二",
      );
      expect(JSON.stringify(data)).not.toContain(
        who === "alice" ? f.bob! : f.alice!,
      );
    }
  });

  it("lists the newest items per kind, preferring plain over text, from current facts only", async () => {
    const data = (await get("alice")).json<PersonalData>();
    expect(data.totals).toMatchObject({ sessions: 2, turns: 0, activeDays: 0 });
    expect(data.totals.elapsedDays).toBeGreaterThanOrEqual(3);
    expect(data.events).toEqual([]);
    const [project] = data.projects;
    expect(project).toMatchObject({
      name: "Alice 的项目",
      sessions: 2,
      turns: 0,
      lastAt: null,
      outcomes: { items: ["成果四", "成果三", "成果二"], total: 4 },
      decisions: { items: ["决定三", "决定二"], total: 3 },
      problems: { items: ["卡点一"], total: 1 },
    });
    expect(JSON.stringify(data)).not.toMatch(/已被取代|已被排除|不展示/);
  });

  it("falls back to text for facts stored before plain existed", async () => {
    await sql`update session_facts set payload = jsonb_set(payload, '{contributions}', ${JSON.stringify([contribution("outcome", "没有通俗句的原文", -1)])}::jsonb)
      where tenant_id = ${f.tenant!} and session_id = 'alice-s2'`;
    const data = (await get("alice")).json<PersonalData>();
    expect(data.projects[0]!.outcomes.items).toContain("没有通俗句的原文");
  });

  it("no longer takes a month, another member, or blocker marks", async () => {
    expect((await get("alice", `?partnerId=${f.bob}`)).statusCode).toBe(400);
    expect((await get("alice", "?month=2026-11")).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/collector/personal-data/blockers/${randomUUID()}`,
          headers: { authorization: `Bearer ${tokens.alice}` },
          payload: { date: day(-1), title: "x", resolved: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});
