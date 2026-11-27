import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { autoApproveExpiredReviews } from "./review-timeout.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("review deadline at Monday 12:00", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    partner = randomUUID(),
    period = randomUUID(),
    review = randomUUID(),
    item = randomUUID();
  // Cutoff Friday 2026-10-09 16:00 Shanghai; deadline Monday 2026-10-12 12:00 Shanghai = 04:00Z.
  const now = new Date("2026-10-12T04:00:00Z");

  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${tenant}, 'Timeout tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Timeout tests')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${tenant}, ${team}, ${`${partner}@test.local`}, 'Timeout reviewer')`;
    await sql`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone)
      values (${period}, ${tenant}, ${team}, 'timeout-week', '2026-10-02T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', 'Asia/Shanghai')`;
    await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state, pending_count)
      values (${review}, ${tenant}, ${team}, ${partner}, ${period}, 'IN_PROGRESS', 1)`;
    await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, title, status, review_status, fact_ids, payload)
      values (${item}, ${tenant}, ${team}, ${partner}, ${period}, ${review}, 'Timeout item', 'in_progress', 'pending', '[]'::jsonb, '{}'::jsonb)`;
    await sql`insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${period}, '{}'::jsonb)`;
  });

  afterAll(async () => {
    for (const table of [
      "audit_events",
      "outbox_events",
      "work_item_snapshots",
      "coverage_snapshots",
      "app_notifications",
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

  it("does not approve before the Monday deadline", async () => {
    await autoApproveExpiredReviews(new Date(now.getTime() - 1));
    expect(await sql`select state from reviews where id = ${review}`).toEqual([
      { state: "IN_PROGRESS" },
    ]);
  });
  it("approves at the deadline and marks the cards auto-approved", async () => {
    await autoApproveExpiredReviews(now);
    expect(await sql`select state from reviews where id = ${review}`).toEqual([
      { state: "ITEMS_APPROVED" },
    ]);
    expect(
      (await sql`select payload from work_items where id = ${item}`)[0]!.payload
        .autoApproved,
    ).toBe(true);
    expect(
      (
        await sql`select actor_id, action from audit_events where tenant_id = ${tenant}`
      )[0],
    ).toEqual({
      actor_id: "review-deadline-monday",
      action: "review.auto_approved_at_deadline",
    });
  });
  it("leaves a review reopened after approval open for the member", async () => {
    const reopenedPartner = randomUUID(),
      reopenedReview = randomUUID(),
      reopenedItem = randomUUID();
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${reopenedPartner}, ${tenant}, ${team}, ${`${reopenedPartner}@test.local`}, 'Reopened reviewer')`;
    await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state, pending_count, approved_count, version)
      values (${reopenedReview}, ${tenant}, ${team}, ${reopenedPartner}, ${period}, 'IN_PROGRESS', 0, 1, 2)`;
    await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id, title, status, review_status, fact_ids, payload)
      values (${reopenedItem}, ${tenant}, ${team}, ${reopenedPartner}, ${period}, ${reopenedReview}, 'Reopened item', 'in_progress', 'approved', '[]'::jsonb, '{}'::jsonb)`;
    await sql`insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
      values (${randomUUID()}, ${tenant}, ${team}, ${reopenedPartner}, ${period}, '{}'::jsonb)`;

    await autoApproveExpiredReviews(now);
    expect(
      await sql`select state, version, pending_count from reviews where id = ${reopenedReview}`,
    ).toEqual([{ state: "IN_PROGRESS", version: 2, pending_count: 0 }]);
  });
});
