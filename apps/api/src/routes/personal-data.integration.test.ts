import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  addProgressDays,
  progressToday,
} from "@partner-report/contracts/project-progress";
import type { PersonalData } from "@partner-report/contracts/member-overview";
import { emptyProfileNote } from "@partner-report/contracts/project-profile";
import { buildApp } from "../server.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("personal data API", () => {
  const f = Object.fromEntries(
    [
      "tenant",
      "team",
      "user",
      "period",
      "alice",
      "bob",
      "projectA",
      "projectB",
    ].map((key) => [key, randomUUID()]),
  ) as Record<string, string>;
  const today = progressToday("Asia/Shanghai");
  const tokens = { alice: `alice-${randomUUID()}`, bob: `bob-${randomUUID()}` };
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${f.tenant!}, 'Personal Data Test')`;
      await tx`insert into teams (id, tenant_id, name, timezone) values (${f.team!}, ${f.tenant!}, 'Team', 'Asia/Shanghai')`;
      await tx`insert into users (id, email, display_name, password_hash) values (${f.user!}, ${`${f.user}@personal.test`}, 'Creator', 'unused')`;
      await tx`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone) values (${f.period!}, ${f.tenant!}, ${f.team!}, 'business-week', ${`${addProgressDays(today, -7)}T00:00:00+08:00`}, ${`${today}T23:59:59+08:00`}, ${`${today}T23:59:59+08:00`}, ${`${today}T23:59:59+08:00`}, 'Asia/Shanghai')`;
      for (const [who, project, name] of [
        ["alice", "projectA", "Alice 的项目"],
        ["bob", "projectB", "Bob 的项目"],
      ] as const) {
        const partner = f[who]!;
        const instance = randomUUID();
        const binding = randomUUID();
        const review = randomUUID();
        await tx`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${f.tenant!}, ${f.team!}, ${`${partner}@personal.test`}, ${who})`;
        await tx`insert into plugin_instances (id, tenant_id, team_id, partner_id, device_name, version, status, access_token_hash, refresh_token_hash, access_expires_at)
          values (${instance}, ${f.tenant!}, ${f.team!}, ${partner}, 'Legacy', '2', 'collector', ${sha256(randomUUID())}, ${sha256(randomUUID())}, now() + interval '1 day')`;
        await tx`insert into plugin_binding_codes (id, tenant_id, team_id, partner_id, code_hash, code_prefix, plugin_instance_id, created_by, status)
          values (${binding}, ${f.tenant!}, ${f.team!}, ${partner}, ${sha256(randomUUID())}, 'PR-PD', ${instance}, ${f.user!}, 'claimed')`;
        await tx`insert into collector_devices (id, tenant_id, team_id, partner_id, scope_instance_id, binding_code_id, device_name, version, token_hash)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${instance}, ${binding}, 'Mac', '0.3', ${sha256(tokens[who])})`;
        await tx`insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids) values (${f[project]!}, ${f.tenant!}, ${f.team!}, ${name}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
        await tx`insert into project_scope_entries (id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key, display_name, status, first_seen_period_key)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${instance}, ${`scope-${who}`}, ${name}, 'allowed', 'business-week')`;
        await tx`insert into project_profiles (id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key, note)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${instance}, ${`scope-${who}`},
            ${JSON.stringify({ ...emptyProfileNote, oneLine: { text: who === "alice" ? "甲的一句话" : "乙的一句话", refs: [] } })}::jsonb)`;
        await tx`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state) values (${review}, ${f.tenant!}, ${f.team!}, ${partner}, ${f.period!}, 'IN_PROGRESS')`;
        await tx`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, review_status, fact_ids, payload)
          values (${randomUUID()}, ${f.tenant!}, ${f.team!}, ${partner}, ${f.period!}, ${review}, ${f[project]!}, ${name}, 'completed', 'approved', '[]'::jsonb,
            ${JSON.stringify({ dailyProgress: [{ date: today, summary: `${who} 今天的进展` }] })}::jsonb)`;
      }
    });
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await sql.begin(async (tx) => {
      for (const table of [
        "project_profiles",
        "project_scope_entries",
        "work_items",
        "reviews",
        "collector_devices",
        "plugin_binding_codes",
        "plugin_instances",
        "report_periods",
        "partners",
        "projects",
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

  it("returns only the bound member's own projects and nothing about teammates", async () => {
    for (const [who, name] of [
      ["alice", "Alice 的项目"],
      ["bob", "Bob 的项目"],
    ] as const) {
      const response = await get(who);
      expect(response.statusCode).toBe(200);
      const data = response.json<PersonalData>();
      expect(data.member).toEqual({ id: f[who], name: who });
      expect(data.projects.map((item) => item.project.projectName)).toEqual([
        name,
      ]);
      expect(data.projects[0]!.project.partnerId).toBe(f[who]);
      expect(data.headline.projectCount).toBe(1);
      expect(data.projects[0]!.profile?.note.oneLine.text).toBe(
        who === "alice" ? "甲的一句话" : "乙的一句话",
      );
      expect(JSON.stringify(data)).not.toContain(
        who === "alice" ? "bob 今天" : "alice 今天",
      );
      expect(JSON.stringify(data)).not.toContain(
        who === "alice" ? f.bob! : f.alice!,
      );
    }
  });

  it("carries the daily progress the calendar draws for the requested month", async () => {
    const data = (await get("alice")).json<PersonalData>();
    expect(data.calendar.month).toBe(today.slice(0, 7));
    expect(data.calendar.from).toBe(`${today.slice(0, 7)}-01`);
    expect(data.calendar.to).toBe(today);
    expect(
      data.projects[0]!.project.days.find((day) => day.date === today)
        ?.entries[0]?.summary,
    ).toBe("alice 今天的进展");
    const past = addProgressDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const earlier = (await get("alice", `?month=${past}`)).json<PersonalData>();
    expect(earlier.calendar).toEqual({
      month: past,
      from: `${past}-01`,
      to: addProgressDays(`${today.slice(0, 7)}-01`, -1),
    });
  });

  it("cannot be pointed at another member or a future month", async () => {
    expect((await get("alice", `?partnerId=${f.bob}`)).statusCode).toBe(400);
    expect((await get("alice", "?month=2999-01")).statusCode).toBe(400);
    expect((await get("alice", "?month=2026-13")).statusCode).toBe(400);
  });
});
