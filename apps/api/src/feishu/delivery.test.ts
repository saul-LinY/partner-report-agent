import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import type { SendInteractiveCardInput } from "./client.js";
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

        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });

  it("invalidates a pending binding card when the partner email changes", async () => {
    const rollback = new RollbackSmokeTest();

    try {
      await sql.begin(async (tx) => {
        const tenantId = randomUUID();
        const teamId = randomUUID();
        const partnerId = randomUUID();
        const appId = `cli_binding_test_${randomUUID()}`;
        const oldEmail = `binding-old-${partnerId}@example.com`;
        const newEmail = `binding-new-${partnerId}@example.com`;
        const finalEmail = `binding-final-${partnerId}@example.com`;
        const oldMessageId = `om_old_${randomUUID()}`;
        const newMessageId = `om_new_${randomUUID()}`;
        const renewedMessageId = `om_renewed_${randomUUID()}`;

        await tx`
          insert into tenants (id, name)
          values (${tenantId}, 'Feishu binding delivery test')
        `;
        await tx`
          insert into teams (id, tenant_id, name)
          values (${teamId}, ${tenantId}, 'Feishu binding delivery test')
        `;
        await tx`
          insert into partners (
            id, tenant_id, team_id, email, display_name
          ) values (
            ${partnerId}, ${tenantId}, ${teamId}, ${oldEmail}, 'Binding Test'
          )
        `;

        let markReplacementStarted!: () => void;
        let releaseReplacement!: () => void;
        const replacementStarted = new Promise<void>((resolve) => {
          markReplacementStarted = resolve;
        });
        const replacementBlocked = new Promise<void>((resolve) => {
          releaseReplacement = resolve;
        });
        let sendCount = 0;
        const sendInteractiveCard = vi.fn(
          async (_input: SendInteractiveCardInput) => {
            sendCount += 1;
            if (sendCount === 1) return { messageId: oldMessageId };
            if (sendCount === 2) {
              markReplacementStarted();
              await replacementBlocked;
              return { messageId: newMessageId };
            }
            return { messageId: renewedMessageId };
          },
        );
        const transactionDatabase = Object.assign(
          (...arguments_: unknown[]) =>
            (tx as unknown as (...input: unknown[]) => unknown)(...arguments_),
          {
            begin: async (callback: (nested: typeof tx) => Promise<unknown>) =>
              callback(tx),
          },
        ) as unknown as typeof sql;
        const service = new FeishuDeliveryService({
          appId,
          messageClient: {
            sendInteractiveCard,
            updateInteractiveCard: vi.fn(async () => undefined),
          },
          database: transactionDatabase,
        });
        const scope = { tenantId, teamId, partnerId };

        const initial = await service.sendBindingCardForScope(scope);
        expect(initial).toMatchObject({
          outcome: "sent",
          messageId: oldMessageId,
          domainVersion: 1,
        });
        const deliveryId = initial.deliveryId!;
        await expect(
          service.loadDeliveryForAction({
            deliveryId,
            messageId: oldMessageId,
            appId,
            expectedKind: "binding",
            aggregateId: partnerId,
          }),
        ).resolves.toMatchObject({ deliveryId, partnerEmail: oldEmail });

        await tx`
          update feishu_deliveries set
            status = 'retry_wait', next_retry_at = now() + interval '1 hour',
            last_error_code = 'OLD_RETRY', last_error_message = 'old retry'
          where id = ${deliveryId}
        `;
        await tx`
          update partners set email = ${newEmail}
          where id = ${partnerId} and tenant_id = ${tenantId}
            and team_id = ${teamId}
        `;

        const replacement = service.sendBindingCardForScope(scope);
        await replacementStarted;
        await expect(
          service.loadDeliveryForAction({
            deliveryId,
            messageId: oldMessageId,
            appId,
            expectedKind: "binding",
            aggregateId: partnerId,
          }),
        ).resolves.toBeNull();
        const whileReplacing = await tx<
          Array<{
            receive_id: string;
            message_id: string | null;
            domain_version: number | null;
            status: string;
            sent_at: Date | null;
            next_retry_at: Date | null;
            last_error_code: string | null;
          }>
        >`
          select receive_id, message_id, domain_version, status, sent_at,
            next_retry_at, last_error_code
          from feishu_deliveries where id = ${deliveryId}
        `;
        expect(whileReplacing).toEqual([
          {
            receive_id: newEmail,
            message_id: null,
            domain_version: null,
            status: "sending",
            sent_at: null,
            next_retry_at: null,
            last_error_code: null,
          },
        ]);

        releaseReplacement();
        await expect(replacement).resolves.toMatchObject({
          outcome: "sent",
          deliveryId,
          messageId: newMessageId,
          domainVersion: 1,
        });
        await expect(
          service.loadDeliveryForAction({
            deliveryId,
            messageId: newMessageId,
            appId,
            expectedKind: "binding",
            aggregateId: partnerId,
          }),
        ).resolves.toMatchObject({ deliveryId, partnerEmail: newEmail });

        const firstSend = sendInteractiveCard.mock.calls[0]![0];
        const replacementSend = sendInteractiveCard.mock.calls[1]![0];
        expect(firstSend.receiveId).toBe(oldEmail);
        expect(replacementSend.receiveId).toBe(newEmail);
        expect(replacementSend.idempotencyKey).not.toBe(
          firstSend.idempotencyKey,
        );

        await tx`
          update feishu_deliveries set sent_at = now() - interval '14 days'
          where id = ${deliveryId}
        `;
        await expect(
          service.sendBindingCardForScope(scope),
        ).resolves.toMatchObject({
          outcome: "sent",
          deliveryId,
          messageId: renewedMessageId,
        });
        await expect(
          service.loadDeliveryForAction({
            deliveryId,
            messageId: newMessageId,
            appId,
            expectedKind: "binding",
            aggregateId: partnerId,
          }),
        ).resolves.toBeNull();

        const boundOpenId = `ou_${randomUUID()}`;
        await tx`
          update feishu_partner_bindings set status = 'active',
            open_id = ${boundOpenId}, verified_at = now()
          where tenant_id = ${tenantId} and team_id = ${teamId}
            and partner_id = ${partnerId} and app_id = ${appId}
        `;
        await tx`
          update partners set email = ${finalEmail}
          where id = ${partnerId} and tenant_id = ${tenantId}
            and team_id = ${teamId}
        `;
        await expect(
          service.sendBindingCardForScope(scope),
        ).resolves.toMatchObject({
          outcome: "skipped",
          deliveryId,
          messageId: renewedMessageId,
          reason: "already_bound",
        });
        expect(sendInteractiveCard).toHaveBeenCalledTimes(3);

        const activeState = await tx<
          Array<{
            status: string;
            open_id: string | null;
            receive_id: string;
            message_id: string | null;
          }>
        >`
          select b.status, b.open_id, d.receive_id, d.message_id
          from feishu_partner_bindings b
          join feishu_deliveries d
            on d.tenant_id = b.tenant_id and d.team_id = b.team_id
            and d.partner_id = b.partner_id and d.kind = 'binding'
          where b.tenant_id = ${tenantId} and b.team_id = ${teamId}
            and b.partner_id = ${partnerId} and b.app_id = ${appId}
        `;
        expect(activeState).toEqual([
          {
            status: "active",
            open_id: boundOpenId,
            receive_id: newEmail,
            message_id: renewedMessageId,
          },
        ]);

        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
