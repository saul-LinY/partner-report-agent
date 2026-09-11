import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { loadPreviousProjectStatus } from "./generation.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("project status history for generation", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    partner = randomUUID(),
    project = randomUUID();
  const periods = [randomUUID(), randomUUID(), randomUUID()];
  const job = {
    tenant_id: tenant,
    team_id: team,
    partner_id: partner,
    input_payload: { period: { id: periods[2] } },
  } as any;
  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${tenant}, 'Status tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Status tests')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${tenant}, ${team}, ${`${partner}@test.local`}, 'Status reviewer')`;
    await sql`insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids) values (${project}, ${tenant}, ${team}, 'Status project', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
    for (const [index, period] of periods.entries()) {
      const review = randomUUID();
      const date = `2026-09-${String(index * 7 + 1).padStart(2, "0")}`;
      await sql`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone)
        values (${period!}, ${tenant}, ${team}, ${`week-${index}`}, ${date}::timestamptz, ${date}::timestamptz + interval '7 days', ${date}, ${date}, 'Asia/Shanghai')`;
      await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state)
        values (${review}, ${tenant}, ${team}, ${partner}, ${period!}, 'IN_PROGRESS')`;
      await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, review_status, fact_ids, payload, updated_at)
        values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${period!}, ${review}, ${project}, 'Status card', 'in_progress', 'approved', '[]'::jsonb,
          ${JSON.stringify({ projectStatus: ["research", "delivery", "paused"][index], projectStatusConfirmedAt: "2026-09-14T00:00:00.000Z" })}::jsonb,
          ${index === 0 ? "2026-09-16" : "2026-09-14"})`;
      // A newer unconfirmed card must never become the next period's baseline.
      await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, project_id, title, status, review_status, fact_ids, payload)
        values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${period!}, ${review}, ${project}, 'Pending card', 'in_progress', 'pending', '[]'::jsonb, '{"projectStatus":"development"}'::jsonb)`;
    }
  });
  afterAll(async () => {
    await sql`delete from project_participations where tenant_id = ${tenant}`;
    await sql`delete from work_items where tenant_id = ${tenant}`;
    await sql`delete from reviews where tenant_id = ${tenant}`;
    await sql`delete from report_periods where tenant_id = ${tenant}`;
    await sql`delete from projects where tenant_id = ${tenant}`;
    await sql`delete from partners where tenant_id = ${tenant}`;
    await sql`delete from teams where tenant_id = ${tenant}`;
    await sql`delete from tenants where id = ${tenant}`;
  });
  it("uses the last prior reporting period, ignoring drafts, the current period and late old approvals", async () => {
    expect(
      await loadPreviousProjectStatus(job, { projectId: project }),
    ).toMatchObject({ value: "delivery", periodKey: "week-1" });
    expect(
      await loadPreviousProjectStatus(
        { ...job, partner_id: randomUUID() },
        { projectId: project },
      ),
    ).toBeNull();
    expect(
      await loadPreviousProjectStatus(job, { projectId: randomUUID() }),
    ).toBeNull();
  });
  it("includes a newer manual confirmation without changing the work card lifecycle status", async () => {
    await sql`insert into project_participations (id, tenant_id, team_id, partner_id, project_id, events)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${project}, ${JSON.stringify(
        [
          {
            type: "milestone",
            date: "2026-09-16",
            projectStatus: "paused",
            statusConfirmedAt: "2026-09-16T00:00:00.000Z",
            reason: "用户确认暂缓",
          },
        ],
      )}::jsonb)`;
    expect(
      await loadPreviousProjectStatus(job, { projectId: project }),
    ).toMatchObject({ value: "paused", reason: "用户确认暂缓" });
  });
});
