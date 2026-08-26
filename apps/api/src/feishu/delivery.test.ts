import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { FeishuDeliveryService } from "./delivery.js";

class RollbackSmokeTest extends Error {}

describe("FeishuDeliveryService PostgreSQL path", () => {
  it("keeps one delivery and advances domainVersion only after a successful patch", async () => {
    const rollback = new RollbackSmokeTest();

    try {
      await sql.begin(async (tx) => {
        const tenantId = randomUUID();
        const teamId = randomUUID();
        const partnerId = randomUUID();
        const periodId = randomUUID();
        const reviewId = randomUUID();
        const workItemId = randomUUID();
        const bindingId = randomUUID();
        const messageId = `om_${randomUUID()}`;
        const appId = `cli_delivery_test_${randomUUID()}`;

        await tx`
          insert into tenants (id, name)
          values (${tenantId}, 'Feishu delivery test')
        `;
        await tx`
          insert into teams (id, tenant_id, name)
          values (${teamId}, ${tenantId}, 'Feishu delivery test')
        `;
        await tx`
          insert into partners (
            id, tenant_id, team_id, email, display_name
          ) values (
            ${partnerId}, ${tenantId}, ${teamId},
            ${`delivery-${partnerId}@example.com`}, 'Delivery Test'
          )
        `;
        await tx`
          insert into report_periods (
            id, tenant_id, team_id, period_key, starts_at, ends_at,
            cutoff_at, submission_deadline_at, timezone
          ) values (
            ${periodId}, ${tenantId}, ${teamId}, '2099-W01',
            '2099-01-01T00:00:00Z', '2099-01-07T23:59:59Z',
            '2099-01-07T12:00:00Z', '2099-01-08T12:00:00Z',
            'Asia/Shanghai'
          )
        `;
        await tx`
          insert into reviews (
            id, tenant_id, team_id, partner_id, period_id, state,
            version, approved_count, excluded_count, pending_count
          ) values (
            ${reviewId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
            'IN_PROGRESS', 4, 0, 0, 1
          )
        `;
        await tx`
          insert into work_items (
            id, tenant_id, team_id, partner_id, period_id, review_id,
            title, status, review_status, fact_ids, payload
          ) values (
            ${workItemId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
            ${reviewId}, 'Delivery SQL smoke test', 'in_progress', 'pending',
            '[]'::jsonb,
            '{"overview":"Validate the delivery SQL.","dailyProgress":[]}'::jsonb
          )
        `;
        await tx`
          insert into feishu_partner_bindings (
            id, tenant_id, team_id, partner_id, app_id, open_id, status,
            verified_at
          ) values (
            ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
            ${`ou_${partnerId}`}, 'active', now()
          )
        `;

        const sendInteractiveCard = vi.fn(async () => ({ messageId }));
        const updateInteractiveCard = vi.fn(async () => undefined);
        const service = new FeishuDeliveryService({
          appId,
          messageClient: { sendInteractiveCard, updateInteractiveCard },
          database: tx as unknown as typeof sql,
        });
        const scope = { tenantId, teamId, partnerId, reviewId };

        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "sent",
          messageId,
          domainVersion: 4,
        });
        expect(sendInteractiveCard).toHaveBeenCalledTimes(1);

        await tx`
          update reviews set version = 5
          where id = ${reviewId} and tenant_id = ${tenantId}
            and team_id = ${teamId} and partner_id = ${partnerId}
        `;
        updateInteractiveCard.mockRejectedValueOnce(
          new Error("simulated transport failure"),
        );
        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "deferred",
          reason: "delivery_failed",
        });

        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "deferred",
          reason: "retry_not_due",
        });

        const afterFailure = await tx<
          Array<{
            count: number;
            domain_version: number | null;
            status: string;
          }>
        >`
          select count(*) over ()::int as count, domain_version, status
          from feishu_deliveries
          where tenant_id = ${tenantId} and team_id = ${teamId}
            and partner_id = ${partnerId} and kind = 'review'
            and aggregate_id = ${reviewId}
        `;
        expect(afterFailure).toEqual([
          expect.objectContaining({
            count: 1,
            domain_version: 4,
            status: "retry_wait",
          }),
        ]);

        await tx`
          update feishu_deliveries set next_retry_at = now() - interval '1 second'
          where tenant_id = ${tenantId} and team_id = ${teamId}
            and partner_id = ${partnerId} and kind = 'review'
            and aggregate_id = ${reviewId}
        `;
        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "updated",
          messageId,
          domainVersion: 5,
        });
        expect(updateInteractiveCard).toHaveBeenCalledTimes(2);

        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "skipped",
          reason: "already_current",
          domainVersion: 5,
        });
        expect(updateInteractiveCard).toHaveBeenCalledTimes(2);

        await tx`
          update reviews set version = 6
          where id = ${reviewId} and tenant_id = ${tenantId}
            and team_id = ${teamId} and partner_id = ${partnerId}
        `;
        let markPatchStarted!: () => void;
        let releasePatch!: () => void;
        const patchStarted = new Promise<void>((resolve) => {
          markPatchStarted = resolve;
        });
        const patchBlocked = new Promise<void>((resolve) => {
          releasePatch = resolve;
        });
        updateInteractiveCard.mockImplementationOnce(async () => {
          markPatchStarted();
          await patchBlocked;
        });

        const versionSixDelivery = service.deliverReview(scope);
        await patchStarted;
        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "deferred",
          reason: "delivery_in_progress",
        });
        releasePatch();
        await expect(versionSixDelivery).resolves.toMatchObject({
          outcome: "updated",
          messageId,
          domainVersion: 6,
        });

        await tx`
          update reviews set version = 5
          where id = ${reviewId} and tenant_id = ${tenantId}
            and team_id = ${teamId} and partner_id = ${partnerId}
        `;
        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "skipped",
          reason: "already_current",
          domainVersion: 6,
        });
        expect(updateInteractiveCard).toHaveBeenCalledTimes(3);

        const delivered = await tx<
          Array<{ count: number; domain_version: number; status: string }>
        >`
          select count(*) over ()::int as count, domain_version, status
          from feishu_deliveries
          where tenant_id = ${tenantId} and team_id = ${teamId}
            and partner_id = ${partnerId} and kind = 'review'
            and aggregate_id = ${reviewId}
        `;
        expect(delivered).toEqual([
          expect.objectContaining({
            count: 1,
            domain_version: 6,
            status: "sent",
          }),
        ]);

        await tx`
          update partners set feishu_delivery_enabled = false
          where id = ${partnerId} and tenant_id = ${tenantId}
        `;
        await tx`
          update reviews set version = 7
          where id = ${reviewId} and tenant_id = ${tenantId}
            and team_id = ${teamId} and partner_id = ${partnerId}
        `;
        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "skipped",
          deliveryId: null,
          reason: "channel_disabled",
        });
        expect(updateInteractiveCard).toHaveBeenCalledTimes(3);

        await tx`
          update partners set feishu_delivery_enabled = true
          where id = ${partnerId} and tenant_id = ${tenantId}
        `;
        await tx`
          update reviews set version = 8
          where id = ${reviewId} and tenant_id = ${tenantId}
            and team_id = ${teamId} and partner_id = ${partnerId}
        `;
        await expect(service.deliverReview(scope)).resolves.toMatchObject({
          outcome: "updated",
          messageId,
          domainVersion: 8,
        });
        expect(updateInteractiveCard).toHaveBeenCalledTimes(4);

        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
