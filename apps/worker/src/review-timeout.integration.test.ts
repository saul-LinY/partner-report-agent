import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { autoApproveExpiredReviews } from "./review-timeout.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("review timeout after regeneration", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    partner = randomUUID(),
    period = randomUUID(),
    review = randomUUID(),
    item = randomUUID();
  const now = new Date("2026-10-12T12:00:00Z");

  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${tenant}, 'Timeout tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Timeout tests')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${tenant}, ${team}, ${`${partner}@test.local`}, 'Timeout reviewer')`;
    await sql`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone)
      values (${period}, ${tenant}, ${team}, 'timeout-week', '2026-10-02', '2026-10-09', '2026-10-09', '2026-10-09', 'Asia/Shanghai')`;
    await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state, pending_count)
      values (${review}, ${tenant}, ${team}, ${partner}, ${period}, 'IN_PROGRESS', 1)`;
    await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, title, status, review_status, fact_ids, payload)
      values (${item}, ${tenant}, ${team}, ${partner}, ${period}, ${review}, 'Timeout item', 'in_progress', 'pending', '[]'::jsonb, '{}'::jsonb)`;
    await sql`insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${period}, '{}'::jsonb)`;
    // First card went out four days ago, before the content was regenerated.
    await sql`insert into feishu_deliveries (id, tenant_id, team_id, partner_id, kind, aggregate_type, aggregate_id, receive_id, receive_id_type, message_id, status, idempotency_key, sent_at)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, 'review', 'review', ${review}, 'ou_old', 'open_id', 'om_old', 'expired', ${`old:${review}`}, ${new Date(now.getTime() - 4 * 86_400_000).toISOString()})`;
    await sql`insert into work_item_versions (id, tenant_id, team_id, partner_id, period_id, review_id, work_item_id, version, title, status, payload, source, created_at)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${period}, ${review}, ${item}, 1, 'Timeout item', 'in_progress', '{}'::jsonb, 'generated', ${new Date(now.getTime() - 2 * 86_400_000 - 60_000).toISOString()})`;
    await sql`insert into feishu_deliveries (id, tenant_id, team_id, partner_id, kind, aggregate_type, aggregate_id, receive_id, receive_id_type, message_id, status, idempotency_key, sent_at)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, 'review', 'review', ${review}, 'ou_new', 'open_id', 'om_new', 'sent', ${`new:${review}`}, ${new Date(now.getTime() - 2 * 86_400_000).toISOString()})`;
  });

  afterAll(async () => {
    for (const table of [
      "audit_events",
      "outbox_events",
      "work_item_snapshots",
      "coverage_snapshots",
      "feishu_deliveries",
      "work_item_versions",
      "work_items",
      "reviews",
      "report_periods",
      "partners",
      "teams",
    ])
      await sql`delete from ${sql(table)} where tenant_id = ${tenant}`;
    await sql`delete from tenants where id = ${tenant}`;
  });

  it("counts three days from the message carrying the regenerated content", async () => {
    await autoApproveExpiredReviews(now);
    expect(await sql`select state from reviews where id = ${review}`).toEqual([
      { state: "IN_PROGRESS" },
    ]);

    await autoApproveExpiredReviews(new Date(now.getTime() + 86_400_000));
    expect(await sql`select state from reviews where id = ${review}`).toEqual([
      { state: "ITEMS_APPROVED" },
    ]);
  });
});
