import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import type { DomainActor } from "../common.js";
import {
  completeReview,
  setReviewProjectStatus,
  decideReviewWorkItem,
} from "../routes/reviews.js";
import { FeishuDeliveryService } from "./delivery.js";
import { FeishuGateway } from "./gateway.js";

function ids() {
  return {
    tenant: randomUUID(),
    team: randomUUID(),
    partner: randomUUID(),
    period: randomUUID(),
    review: randomUUID(),
    item: randomUUID(),
    otherPeriod: randomUUID(),
    otherReview: randomUUID(),
    otherItem: randomUUID(),
    delivery: randomUUID(),
    event: randomUUID(),
    appId: `cli_completion_${randomUUID()}`,
    openId: `ou_${randomUUID()}`,
    messageId: `om_${randomUUID()}`,
  };
}

describe("review completion across Feishu cards", () => {
  let f: ReturnType<typeof ids>;
  const updateInteractiveCard = vi.fn(async (_input: unknown) => undefined);

  function actor(): DomainActor {
    return {
      tenantId: f.tenant,
      teamId: f.team,
      partnerId: f.partner,
      actorType: "feishu",
      actorId: f.openId,
      userId: null,
    };
  }

  function gateway() {
    const messageClient = {
      updateInteractiveCard,
      sendInteractiveCard: vi.fn(),
    };
    return new FeishuGateway(
      { appId: f.appId, appSecret: "test-secret" },
      messageClient,
      new FeishuDeliveryService({ appId: f.appId, messageClient }),
      { tenantIdFilter: f.tenant },
    );
  }

  function callback(baseVersion = 1) {
    return {
      event_id: f.event,
      app_id: f.appId,
      event_type: "card.action.trigger",
      operator: { open_id: f.openId },
      context: { open_message_id: f.messageId },
      action: {
        value: {
          action: "review_approve",
          deliveryId: f.delivery,
          aggregateId: f.review,
          itemId: f.item,
          baseVersion,
        },
      },
    };
  }

  async function job(
    payload: object,
    type = "AGGREGATE_WORK_ITEMS",
    key?: string,
  ) {
    const id = randomUUID();
    await sql`
      insert into agent_jobs (id, tenant_id, team_id, partner_id, type, idempotency_key, input_payload)
      values (${id}, ${f.tenant}, ${f.team}, ${f.partner}, ${type}, ${key ?? id}, ${JSON.stringify(payload)}::jsonb)
    `;
    return id;
  }

  async function reviewed() {
    await sql`update work_items set review_status = 'approved' where id = ${f.item}`;
    await sql`update reviews set approved_count = 1, pending_count = 0, version = 2 where id = ${f.review}`;
  }

  async function expectCompleted() {
    const reviews =
      await sql`select state, approved_count, pending_count from reviews where id = ${f.review}`;
    expect(reviews).toEqual([
      { state: "ITEMS_APPROVED", approved_count: 1, pending_count: 0 },
    ]);
    const snapshots =
      await sql`select approved_by_actor_id from work_item_snapshots where review_id = ${f.review}`;
    expect(snapshots).toEqual([{ approved_by_actor_id: f.openId }]);
  }

  beforeEach(async () => {
    f = ids();
    updateInteractiveCard.mockClear();
    await sql`insert into tenants (id, name) values (${f.tenant}, 'Completion tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${f.team}, ${f.tenant}, 'Completion tests')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name)
      values (${f.partner}, ${f.tenant}, ${f.team}, ${`${f.partner}@example.test`}, 'Reviewer')`;
    for (const [period, review, item] of [
      [f.period, f.review, f.item],
      [f.otherPeriod, f.otherReview, f.otherItem],
    ]) {
      await sql`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at,
        cutoff_at, submission_deadline_at, timezone, status)
        values (${period!}, ${f.tenant}, ${f.team}, ${period!}, '2099-01-01', '2099-01-07',
          '2099-01-07', '2099-01-08', 'Asia/Shanghai', 'completed')`;
      await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state, version, pending_count)
        values (${review!}, ${f.tenant}, ${f.team}, ${f.partner}, ${period!}, 'IN_PROGRESS', 1, 1)`;
      await sql`insert into work_items (id, tenant_id, team_id, partner_id, period_id, review_id,
        title, status, review_status, fact_ids, payload)
        values (${item!}, ${f.tenant}, ${f.team}, ${f.partner}, ${period!}, ${review!},
          'Review item', 'in_progress', 'pending', '[]'::jsonb, '{"overview":"Original content"}'::jsonb)`;
      await sql`insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
        values (${randomUUID()}, ${f.tenant}, ${f.team}, ${f.partner}, ${period!}, '{}'::jsonb)`;
    }
    await sql`insert into feishu_partner_bindings (id, tenant_id, team_id, partner_id, app_id, open_id, status)
      values (${randomUUID()}, ${f.tenant}, ${f.team}, ${f.partner}, ${f.appId}, ${f.openId}, 'active')`;
    await sql`insert into feishu_deliveries (id, tenant_id, team_id, partner_id, kind, aggregate_type,
      aggregate_id, receive_id, receive_id_type, message_id, domain_version, status, idempotency_key, sent_at)
      values (${f.delivery}, ${f.tenant}, ${f.team}, ${f.partner}, 'review', 'review',
        ${f.review}, ${f.openId}, 'open_id', ${f.messageId}, 1, 'sent',
        ${`review:${f.appId}:${f.partner}:${f.review}`}, now())`;
  });

  afterEach(async () => {
    await sql`delete from feishu_inbox_events where sanitized_payload->>'appId' = ${f.appId}`;
    await sql`delete from audit_events where tenant_id = ${f.tenant}`;
    await sql`delete from outbox_events where tenant_id = ${f.tenant}`;
    await sql`delete from feishu_deliveries where tenant_id = ${f.tenant}`;
    await sql`delete from feishu_partner_bindings where tenant_id = ${f.tenant}`;
    await sql`delete from agent_jobs where tenant_id = ${f.tenant}`;
    await sql`delete from work_item_snapshots where tenant_id = ${f.tenant}`;
    await sql`delete from coverage_snapshots where tenant_id = ${f.tenant}`;
    await sql`delete from work_item_versions where tenant_id = ${f.tenant}`;
    await sql`delete from work_items where tenant_id = ${f.tenant}`;
    await sql`delete from reviews where tenant_id = ${f.tenant}`;
    await sql`delete from report_periods where tenant_id = ${f.tenant}`;
    await sql`delete from partners where tenant_id = ${f.tenant}`;
    await sql`delete from teams where tenant_id = ${f.tenant}`;
    await sql`delete from tenants where id = ${f.tenant}`;
  });

  it("changes the preset on the same Feishu card and confirms it only on approval", async () => {
    const g = gateway();
    const selection = {
      ...callback(),
      action: {
        value: {
          ...callback().action.value,
          action: "review_project_status",
          projectStatus: "paused",
          page: 0,
        },
      },
    };
    await g.acceptCardAction(selection);
    await expect(g.drainInbox()).resolves.toBe(1);
    const [draft] =
      await sql`select payload, review_status, status from work_items where id = ${f.item}`;
    expect(draft).toMatchObject({
      review_status: "pending",
      status: "in_progress",
      payload: { projectStatus: "paused", projectStatusSource: "user" },
    });
    expect(draft!.payload.projectStatusConfirmedAt).toBeUndefined();
    expect(updateInteractiveCard.mock.calls.at(-1)?.[0]).toMatchObject({
      messageId: f.messageId,
    });
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1))).toContain(
      "✓ 已暂停",
    );
    // A callback retry must not increment the review version again.
    expect(
      await setReviewProjectStatus(actor(), {
        reviewId: f.review,
        workItemId: f.item,
        baseVersion: 1,
        projectStatus: "paused",
      }),
    ).toEqual({ version: 2, changed: false });
    await expect(
      setReviewProjectStatus(actor(), {
        reviewId: f.review,
        workItemId: f.item,
        baseVersion: 1,
        projectStatus: "research",
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await g.acceptCardAction({ ...callback(2), event_id: randomUUID() });
    await expect(g.drainInbox()).resolves.toBe(1);
    await expectCompleted();
    const [approved] =
      await sql`select payload, status from work_items where id = ${f.item}`;
    expect(approved!.payload.projectStatus).toBe("paused");
    expect(approved!.payload.projectStatusConfirmedAt).toMatch(/^\d{4}-/);
    expect(approved!.status).toBe("in_progress");
    const [snapshot] =
      await sql`select payload from work_item_snapshots where review_id = ${f.review}`;
    expect(JSON.stringify(snapshot!.payload)).toContain(
      '"projectStatus":"paused"',
    );
  });

  it("does not confirm a status when the work card is excluded", async () => {
    await setReviewProjectStatus(actor(), {
      reviewId: f.review,
      workItemId: f.item,
      baseVersion: 1,
      projectStatus: "delivery",
    });
    await decideReviewWorkItem(actor(), {
      reviewId: f.review,
      workItemId: f.item,
      baseVersion: 2,
      decision: "exclude",
    });
    const [item] =
      await sql`select payload, review_status from work_items where id = ${f.item}`;
    expect(item!.review_status).toBe("excluded");
    expect(item!.payload.projectStatusConfirmedAt).toBeUndefined();
  });

  it("rejects another partner and status edits during regeneration", async () => {
    await expect(
      setReviewProjectStatus(
        { ...actor(), partnerId: randomUUID() },
        {
          reviewId: f.review,
          workItemId: f.item,
          baseVersion: 1,
          projectStatus: "paused",
        },
      ),
    ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    await job({ reviewId: f.review, targetWorkItemId: f.item });
    await expect(
      setReviewProjectStatus(actor(), {
        reviewId: f.review,
        workItemId: f.item,
        baseVersion: 1,
        projectStatus: "paused",
      }),
    ).rejects.toMatchObject({ code: "REGENERATION_PENDING" });
  });

  it.each(["AGGREGATE_WORK_ITEMS", "REANALYZE_SESSIONS"])(
    "completes one card while another review has a pending %s job",
    async (type) => {
      const otherJob = await job(
        { reviewId: f.otherReview, period: { id: f.otherPeriod } },
        type,
      );
      const g = gateway();
      await g.acceptCardAction(callback());
      await expect(g.drainInbox()).resolves.toBe(1);
      await expectCompleted();
      expect(
        await sql`select status from agent_jobs where id = ${otherJob}`,
      ).toEqual([{ status: "PENDING" }]);
      expect(JSON.stringify(updateInteractiveCard.mock.calls)).toContain(
        "项目卡片审核已完成",
      );
    },
  );

  it.each(["review", "period", "item", "legacy_reanalysis"])(
    "still waits for a related job identified by %s",
    async (association) => {
      await reviewed();
      const payload =
        association === "review"
          ? { reviewId: f.review }
          : association === "period"
            ? { period: { id: f.period } }
            : association === "item"
              ? { targetWorkItemId: f.item }
              : {};
      const relatedJob = await job(
        payload,
        association === "legacy_reanalysis"
          ? "REANALYZE_SESSIONS"
          : "AGGREGATE_WORK_ITEMS",
        association === "legacy_reanalysis"
          ? `reanalysis:${f.review}:${randomUUID()}`
          : undefined,
      );
      await expect(completeReview(actor(), f.review, 2)).rejects.toMatchObject({
        code: "AGENT_JOB_PENDING",
      });
      expect(
        await sql`select id from work_item_snapshots where review_id = ${f.review}`,
      ).toHaveLength(0);
      await sql`update agent_jobs set status = 'COMPLETED' where id = ${relatedJob}`;
      await completeReview(actor(), f.review, 2);
      await expectCompleted();
    },
  );

  it.each([false, true])(
    "resumes completion after restart, legacyInbox=%s",
    async (legacyInbox) => {
      const relatedJob = await job({ reviewId: f.review });
      const g = gateway();
      await g.acceptCardAction(callback());
      await expect(g.drainInbox()).resolves.toBe(1);
      expect(
        await sql`select status, error_code from feishu_inbox_events where event_id = ${f.event}`,
      ).toEqual([{ status: "failed", error_code: "AGENT_JOB_PENDING" }]);
      expect(JSON.stringify(updateInteractiveCard.mock.calls)).toContain(
        "等待当前审核任务完成",
      );
      await expect(g.drainInbox()).resolves.toBe(0);
      if (legacyInbox) {
        await sql`update feishu_inbox_events set status = 'processed' where event_id = ${f.event}`;
      }
      await sql`update agent_jobs set status = 'COMPLETED' where id = ${relatedJob}`;
      await sql`update feishu_inbox_events set updated_at = now() - interval '31 seconds' where event_id = ${f.event}`;
      const restarted = gateway();
      await expect(restarted.drainInbox()).resolves.toBe(1);
      await expectCompleted();
      expect(
        await sql`select status, error_code from feishu_inbox_events where event_id = ${f.event}`,
      ).toEqual([{ status: "processed", error_code: null }]);
      await expect(restarted.drainInbox()).resolves.toBe(0);
      await g.acceptCardAction(callback());
      await expect(g.drainInbox()).resolves.toBe(0);
      await expectCompleted();
    },
  );

  it("never reuses an old approval for freshly regenerated content", async () => {
    const relatedJob = await job({
      reviewId: f.review,
      targetWorkItemId: f.item,
    });
    const g = gateway();
    await g.acceptCardAction(callback());
    await g.drainInbox();
    // Reproduce the state the generation worker persists when replacing an item.
    await sql`update work_items set review_status = 'pending', payload = '{"overview":"New generated content"}'::jsonb where id = ${f.item}`;
    await sql`update reviews set version = 3, approved_count = 0, pending_count = 1 where id = ${f.review}`;
    await sql`update agent_jobs set status = 'COMPLETED' where id = ${relatedJob}`;
    await sql`update feishu_inbox_events set updated_at = now() - interval '31 seconds' where event_id = ${f.event}`;
    await expect(g.drainInbox()).resolves.toBe(1);
    expect(
      await sql`select state, pending_count from reviews where id = ${f.review}`,
    ).toEqual([{ state: "IN_PROGRESS", pending_count: 1 }]);
    expect(
      await sql`select id from work_item_snapshots where review_id = ${f.review}`,
    ).toHaveLength(0);
    expect(
      await sql`select error_code from feishu_inbox_events where event_id = ${f.event}`,
    ).toEqual([{ error_code: "VERSION_CONFLICT" }]);
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1))).toContain(
      "New generated content",
    );
    await g.acceptCardAction({ ...callback(3), event_id: randomUUID() });
    await g.drainInbox();
    await expectCompleted();
  });

  it("creates only one snapshot when completion is attempted concurrently", async () => {
    await reviewed();
    const results = await Promise.all([
      completeReview(actor(), f.review, 2),
      completeReview(actor(), f.review, 2),
    ]);
    expect(results[0]!.snapshotId).toBe(results[1]!.snapshotId);
    await expectCompleted();
  });
});
