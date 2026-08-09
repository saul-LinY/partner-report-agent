import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql, weeklyPeriodAt } from "@partner-report/db";
import { buildApp } from "../server.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("Admin aggregation schedule", () => {
  const fixture = {
    tenant: randomUUID(),
    team: randomUUID(),
    user: randomUUID(),
    membership: randomUUID(),
    session: randomUUID(),
    period: randomUUID(),
  };
  const token = `admin-schedule-${fixture.user}`;
  const startsAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenant}, 'Schedule Fixture')`;
      await tx`
        insert into teams (id, tenant_id, name, timezone, report_type)
        values (${fixture.team}, ${fixture.tenant}, 'Schedule Team', 'Asia/Shanghai', 'weekly')
      `;
      await tx`
        insert into users (id, email, display_name, password_hash)
        values (${fixture.user}, ${`schedule-${fixture.user}@local.test`}, 'Schedule Admin', 'not-used')
      `;
      await tx`
        insert into memberships (id, tenant_id, team_id, user_id, roles)
        values (${fixture.membership}, ${fixture.tenant}, ${fixture.team}, ${fixture.user}, '["admin"]'::jsonb)
      `;
      await tx`
        insert into web_sessions (id, user_id, token_hash, expires_at)
        values (${fixture.session}, ${fixture.user}, ${createHash("sha256").update(token).digest("hex")}, ${new Date(Date.now() + 3_600_000).toISOString()})
      `;
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone, status
        ) values (
          ${fixture.period}, ${fixture.tenant}, ${fixture.team}, 'legacy-rule-period',
          ${startsAt.toISOString()}, ${new Date(Date.now() + 5 * 86_400_000).toISOString()},
          ${new Date(Date.now() + 5 * 86_400_000).toISOString()},
          ${new Date(Date.now() + 5 * 86_400_000).toISOString()},
          'Asia/Shanghai', 'open'
        )
      `;
    });
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await sql.begin(async (tx) => {
      await tx`delete from audit_events where tenant_id = ${fixture.tenant}`;
      await tx`delete from report_periods where team_id = ${fixture.team}`;
      await tx`delete from web_sessions where id = ${fixture.session}`;
      await tx`delete from memberships where id = ${fixture.membership}`;
      await tx`delete from users where id = ${fixture.user}`;
      await tx`delete from teams where id = ${fixture.team}`;
      await tx`delete from tenants where id = ${fixture.tenant}`;
    });
  });

  it("updates the actual open-period cutoff regardless of its existing key", async () => {
    const periodRule = {
      frequency: "weekly" as const,
      weekStartsOn: 1,
      factCutoffWeekday: 7,
      factCutoffTime: "23:55",
    };
    const expected = weeklyPeriodAt(new Date(), "Asia/Shanghai", periodRule);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/admin/team",
      headers: { cookie: `pra_session=${token}` },
      payload: { periodRule },
    });
    expect(response.statusCode).toBe(200);

    const [team] = await sql<any[]>`
      select period_rule from teams where id = ${fixture.team}
    `;
    const [period] = await sql<any[]>`
      select period_key, starts_at, ends_at, cutoff_at
      from report_periods where id = ${fixture.period}
    `;
    expect(team.period_rule).toMatchObject(periodRule);
    expect(period.period_key).toBe("legacy-rule-period");
    expect(new Date(period.starts_at).toISOString()).toBe(
      startsAt.toISOString(),
    );
    expect(new Date(period.ends_at).toISOString()).toBe(
      expected.endsAt.toISOString(),
    );
    expect(new Date(period.cutoff_at).toISOString()).toBe(
      expected.cutoffAt.toISOString(),
    );
  });
});
