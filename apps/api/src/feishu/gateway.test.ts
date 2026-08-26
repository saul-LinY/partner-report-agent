import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { FeishuDeliveryService } from "./delivery.js";
import {
  FeishuGateway,
  projectScopeFormDecisions,
  reviewRegenerationInstruction,
} from "./gateway.js";

describe("project scope form decisions", () => {
  it("maps every visible form field to its project", () => {
    const projects = [
      { scopeKey: "a".repeat(64) },
      { scopeKey: "b".repeat(64) },
    ];

    expect(
      projectScopeFormDecisions(
        { scope_decision_0: "allow", scope_decision_1: "deny" },
        projects,
      ),
    ).toEqual([
      { scopeKey: projects[0]!.scopeKey, decision: "allow" },
      { scopeKey: projects[1]!.scopeKey, decision: "deny" },
    ]);
  });

  it("rejects an incomplete form instead of applying a partial decision", () => {
    expect(() =>
      projectScopeFormDecisions({ scope_decision_0: "allow" }, [
        { scopeKey: "a".repeat(64) },
        { scopeKey: "b".repeat(64) },
      ]),
    ).toThrow("请为本页每个项目选择采集权限后再提交。");
  });
});

describe("review regeneration form", () => {
  it("trims and validates the natural-language instruction", () => {
    expect(
      reviewRegenerationInstruction({
        review_regeneration_instruction: "  请把结果写得更通俗一些。  ",
      }),
    ).toBe("请把结果写得更通俗一些。");
  });

  it("rejects an empty instruction", () => {
    expect(() =>
      reviewRegenerationInstruction({
        review_regeneration_instruction: " ",
      }),
    ).toThrow("请填写 2 至 1200 个字符的修改意见。");
  });
});

describe("disabled legacy card actions", () => {
  it.each(["report_submit", "report_regenerate"])(
    "rejects %s before storing an inbox event",
    async (action) => {
      const appId = `cli_disabled_action_${randomUUID()}`;
      const messageClient = {
        sendInteractiveCard: vi.fn(),
        updateInteractiveCard: vi.fn(),
      };
      const deliveries = new FeishuDeliveryService({ appId, messageClient });
      const gateway = new FeishuGateway(
        { appId, appSecret: "disabled-action-test-secret" },
        messageClient,
        deliveries,
      );

      await expect(
        gateway.acceptCardAction({
          event_id: randomUUID(),
          event_type: "card.action.trigger",
          app_id: appId,
          operator: { open_id: `ou_${randomUUID()}` },
          action: {
            value: {
              deliveryId: randomUUID(),
              aggregateId: randomUUID(),
              baseVersion: 1,
              action,
            },
          },
          context: { open_message_id: `om_${randomUUID()}` },
        }),
      ).resolves.toEqual({
        toast: {
          type: "error",
          content: "审核操作无效，请刷新卡片。",
        },
      });
    },
  );
});

describe("FeishuGateway review decisions", () => {
  it("accepts one work card and updates the same message to the next item", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const firstItemId = randomUUID();
    const secondItemId = randomUUID();
    const bindingId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const appId = `cli_review_decision_test_${randomUUID()}`;
    const openId = `ou_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    const email = `review-decision-${partnerId}@example.com`;
    const sendInteractiveCard = vi.fn(async () => ({
      messageId: `om_unexpected_${randomUUID()}`,
    }));
    const updateInteractiveCard = vi.fn(async (_input: unknown) => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Feishu review decision test')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Feishu review decision test')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${partnerId}, ${tenantId}, ${teamId}, ${email}, 'Review Partner')
      `;
      await sql`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, submission_deadline_at, timezone
        ) values (
          ${periodId}, ${tenantId}, ${teamId}, ${`review-${periodId}`},
          '2099-03-01T00:00:00Z', '2099-03-07T23:59:59Z',
          '2099-03-07T12:00:00Z', '2099-03-08T12:00:00Z', 'Asia/Shanghai'
        )
      `;
      await sql`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, version,
          approved_count, excluded_count, pending_count
        ) values (
          ${reviewId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          'IN_PROGRESS', 1, 0, 0, 2
        )
      `;
      await sql`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          title, status, review_status, fact_ids, payload, created_at
        ) values (
          ${firstItemId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          ${reviewId}, '第一张工作卡片', 'in_progress', 'pending', '[]'::jsonb,
          '{"overview":"第一项进展","dailyProgress":[]}'::jsonb,
          '2099-03-01T01:00:00Z'
        ), (
          ${secondItemId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          ${reviewId}, '第二张工作卡片', 'in_progress', 'pending', '[]'::jsonb,
          '{"overview":"第二项进展","dailyProgress":[]}'::jsonb,
          '2099-03-01T02:00:00Z'
        )
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
          ${openId}, 'active', now()
        )
      `;
      await sql`
        insert into feishu_deliveries (
          id, tenant_id, team_id, partner_id, kind, aggregate_type,
          aggregate_id, receive_id, receive_id_type, message_id,
          domain_version, status, idempotency_key, sent_at
        ) values (
          ${deliveryId}, ${tenantId}, ${teamId}, ${partnerId}, 'review', 'review',
          ${reviewId}, ${openId}, 'open_id', ${messageId}, 1, 'sent',
          ${`review:${appId}:${partnerId}:${reviewId}`}, now()
        )
      `;

      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "review-decision-test-secret" },
        { updateInteractiveCard },
        service,
        { tenantIdFilter: tenantId },
      );
      const callback = {
        event_id: eventId,
        event_type: "card.action.trigger",
        app_id: appId,
        operator: { open_id: openId },
        action: {
          value: {
            deliveryId,
            aggregateId: reviewId,
            itemId: firstItemId,
            baseVersion: 1,
            action: "review_approve",
          },
        },
        context: { open_message_id: messageId },
      };

      await expect(gateway.acceptCardAction(callback)).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(gateway.drainInbox()).resolves.toBe(1);

      const items = await sql<Array<{ id: string; review_status: string }>>`
        select id, review_status from work_items
        where review_id = ${reviewId} order by created_at
      `;
      expect(items).toEqual([
        { id: firstItemId, review_status: "approved" },
        { id: secondItemId, review_status: "pending" },
      ]);
      const reviews = await sql<
        Array<{
          version: number;
          approved_count: number;
          pending_count: number;
        }>
      >`
        select version, approved_count, pending_count from reviews where id = ${reviewId}
      `;
      expect(reviews).toEqual([
        { version: 2, approved_count: 1, pending_count: 1 },
      ]);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(updateInteractiveCard.mock.calls[0]?.[0]),
      ).toContain("第二张工作卡片");
      expect(sendInteractiveCard).not.toHaveBeenCalled();
    } finally {
      await sql`delete from feishu_inbox_events where event_id = ${eventId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from work_items where tenant_id = ${tenantId}`;
      await sql`delete from reviews where tenant_id = ${tenantId}`;
      await sql`delete from report_periods where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });

  it("queues a natural-language regeneration and shows progress in the same message", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    const factId = randomUUID();
    const bindingId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const appId = `cli_review_regeneration_test_${randomUUID()}`;
    const openId = `ou_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    const email = `review-regeneration-${partnerId}@example.com`;
    const instruction =
      "请把每天做了什么、解决了什么问题和最终结果写得更通俗。";
    const sendInteractiveCard = vi.fn();
    const updateInteractiveCard = vi.fn(async (_input: unknown) => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Feishu regeneration test')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Feishu regeneration test')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${partnerId}, ${tenantId}, ${teamId}, ${email}, 'Regeneration Partner')
      `;
      await sql`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, submission_deadline_at, timezone
        ) values (
          ${periodId}, ${tenantId}, ${teamId}, ${`regeneration-${periodId}`},
          '2099-04-01T00:00:00Z', '2099-04-07T23:59:59Z',
          '2099-04-07T12:00:00Z', '2099-04-08T12:00:00Z', 'Asia/Shanghai'
        )
      `;
      await sql`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, version,
          approved_count, excluded_count, pending_count
        ) values (
          ${reviewId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          'IN_PROGRESS', 1, 0, 0, 1
        )
      `;
      await sql`
        insert into session_facts (
          id, tenant_id, team_id, partner_id, period_id, session_id,
          external_fact_id, source_revision, source_hash, payload
        ) values (
          ${factId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          'regeneration-session', 'regeneration-fact', 1, ${"f".repeat(64)},
          ${JSON.stringify({
            recordType: "session_contribution",
            contributions: [
              {
                kind: "outcome",
                confidence: "high",
                text: "完成飞书卡片审核链路",
              },
            ],
          })}::jsonb
        )
      `;
      await sql`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${workItemId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          ${reviewId}, '飞书审核接入', 'completed', 'pending',
          ${JSON.stringify([factId])}::jsonb,
          ${JSON.stringify({
            projectKey: "project:feishu-review",
            projectDescription: "用于审核团队工作记录。",
            overview: "完成审核链路。",
            dailyProgress: [],
          })}::jsonb
        )
      `;
      await sql`
        insert into work_item_facts (work_item_id, fact_id)
        values (${workItemId}, ${factId})
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
          ${openId}, 'active', now()
        )
      `;
      await sql`
        insert into feishu_deliveries (
          id, tenant_id, team_id, partner_id, kind, aggregate_type,
          aggregate_id, receive_id, receive_id_type, message_id,
          domain_version, status, idempotency_key, sent_at
        ) values (
          ${deliveryId}, ${tenantId}, ${teamId}, ${partnerId}, 'review', 'review',
          ${reviewId}, ${openId}, 'open_id', ${messageId}, 1, 'sent',
          ${`review:${appId}:${partnerId}:${reviewId}`}, now()
        )
      `;

      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "review-regeneration-test-secret" },
        { updateInteractiveCard },
        service,
        { tenantIdFilter: tenantId },
      );

      await expect(
        gateway.acceptCardAction({
          event_id: eventId,
          event_type: "card.action.trigger",
          app_id: appId,
          operator: { open_id: openId },
          action: {
            value: {
              deliveryId,
              aggregateId: reviewId,
              itemId: workItemId,
              baseVersion: 1,
              action: "review_regenerate",
            },
            form_value: {
              review_regeneration_instruction: instruction,
            },
          },
          context: { open_message_id: messageId },
        }),
      ).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(gateway.drainInbox()).resolves.toBe(1);

      const jobs = await sql<
        Array<{ status: string; input_payload: Record<string, unknown> }>
      >`
        select status, input_payload from agent_jobs
        where tenant_id = ${tenantId} and type = 'AGGREGATE_WORK_ITEMS'
      `;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: "PENDING" });
      expect(jobs[0]!.input_payload).toMatchObject({
        reviewId,
        targetWorkItemId: workItemId,
        reviewInstruction: instruction,
      });
      const reviews = await sql<
        Array<{ version: number; pending_count: number }>
      >`
        select version, pending_count from reviews where id = ${reviewId}
      `;
      expect(reviews).toEqual([{ version: 2, pending_count: 1 }]);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(updateInteractiveCard.mock.calls[0]?.[0]),
      ).toContain("正在重新生成工作卡片");
      expect(sendInteractiveCard).not.toHaveBeenCalled();
    } finally {
      await sql`delete from feishu_inbox_events where event_id = ${eventId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from agent_jobs where tenant_id = ${tenantId}`;
      await sql`delete from work_item_facts where work_item_id = ${workItemId}`;
      await sql`delete from work_items where tenant_id = ${tenantId}`;
      await sql`delete from session_facts where tenant_id = ${tenantId}`;
      await sql`delete from reviews where tenant_id = ${tenantId}`;
      await sql`delete from report_periods where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });
});

describe("FeishuGateway binding callback", () => {
  it("binds the callback operator once and records a sanitized inbox event", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const bindingId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const appId = `cli_gateway_test_${randomUUID()}`;
    const openId = `ou_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    const email = `gateway-${partnerId}@example.com`;
    const sendInteractiveCard = vi.fn(async () => ({ messageId }));
    const updateInteractiveCard = vi.fn(async () => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Feishu gateway test')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Feishu gateway test')
      `;
      await sql`
        insert into partners (
          id, tenant_id, team_id, email, display_name
        ) values (
          ${partnerId}, ${tenantId}, ${teamId}, ${email}, 'Gateway Test'
        )
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, status
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId}, 'pending'
        )
      `;
      await sql`
        insert into feishu_deliveries (
          id, tenant_id, team_id, partner_id, kind, aggregate_type,
          aggregate_id, receive_id, receive_id_type, message_id,
          domain_version, status, idempotency_key, sent_at
        ) values (
          ${deliveryId}, ${tenantId}, ${teamId}, ${partnerId}, 'binding',
          'partner', ${partnerId}, ${email}, 'email', ${messageId}, 1,
          'sent', ${`binding:${appId}:${partnerId}:${partnerId}`}, now()
        )
      `;

      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "gateway-test-secret" },
        { updateInteractiveCard },
        service,
        { reviewDeliveryEnabled: false },
      );
      const callback = {
        event_id: eventId,
        event_type: "card.action.trigger",
        app_id: appId,
        tenant_key: "tenant-key-test",
        operator: { open_id: openId, union_id: "union-id-test" },
        action: {
          value: {
            deliveryId,
            action: "binding_confirm",
            aggregateId: partnerId,
            baseVersion: 1,
          },
        },
        context: { open_message_id: messageId },
      };

      await expect(gateway.acceptCardAction(callback)).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(gateway.drainInbox()).resolves.toBe(1);

      const bindings = await sql<
        Array<{
          status: string;
          open_id: string;
          union_id: string;
          tenant_key: string;
        }>
      >`
        select status, open_id, union_id, tenant_key
        from feishu_partner_bindings where id = ${bindingId}
      `;
      expect(bindings).toEqual([
        {
          status: "active",
          open_id: openId,
          union_id: "union-id-test",
          tenant_key: "tenant-key-test",
        },
      ]);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(sendInteractiveCard).not.toHaveBeenCalled();

      const inbox = await sql<
        Array<{
          status: string;
          sanitized_payload: Record<string, unknown>;
        }>
      >`
        select status, sanitized_payload from feishu_inbox_events
        where event_id = ${eventId}
      `;
      expect(inbox[0]?.status).toBe("processed");
      expect(JSON.stringify(inbox[0]?.sanitized_payload)).not.toContain(
        "gateway-test-secret",
      );
      const audits = await sql<Array<{ actor_type: string; actor_id: string }>>`
        select actor_type, actor_id from audit_events
        where tenant_id = ${tenantId} and request_id = ${eventId}
      `;
      expect(audits).toEqual([{ actor_type: "feishu", actor_id: openId }]);

      await expect(gateway.acceptCardAction(callback)).resolves.toEqual({
        toast: {
          type: "success",
          content: "该操作已经收到，请勿重复点击。",
        },
      });
      await expect(gateway.drainInbox()).resolves.toBe(0);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(1);
    } finally {
      await sql`delete from feishu_inbox_events where event_id = ${eventId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });
});

describe("FeishuGateway plugin recovery automation", () => {
  it("delivers and confirms a plugin credential recovery card", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const pluginInstanceId = randomUUID();
    const authorizationId = randomUUID();
    const bindingId = randomUUID();
    const outboxId = randomUUID();
    const eventId = randomUUID();
    const appId = `cli_plugin_recovery_${randomUUID()}`;
    const openId = `ou_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    const sendInteractiveCard = vi.fn(async () => ({ messageId }));
    const updateInteractiveCard = vi.fn(async () => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Plugin recovery automation')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Plugin recovery automation')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${partnerId}, ${tenantId}, ${teamId}, ${`recovery-${partnerId}@example.com`}, 'Recovery User')
      `;
      await sql`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${pluginInstanceId}, ${tenantId}, ${teamId}, ${partnerId},
          'Recovery MacBook', '0.4.3', 'old-access', 'old-refresh', now()
        )
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
          ${openId}, 'active', now()
        )
      `;
      await sql`
        insert into plugin_device_authorizations (
          id, device_code_hash, user_code, device_name, plugin_version,
          tenant_id, team_id, partner_id, plugin_instance_id, expires_at
        ) values (
          ${authorizationId}, ${`hash-${authorizationId}`}, ${`USER-${authorizationId}`},
          'Recovery MacBook', '0.4.3', ${tenantId}, ${teamId}, ${partnerId},
          ${pluginInstanceId}, now() + interval '7 days'
        )
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${outboxId}, ${tenantId}, 'plugin.binding.recovery.requested',
          'device_authorization', ${authorizationId}, '{}'::jsonb
        )
      `;
      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "plugin-recovery-automation-secret" },
        { updateInteractiveCard },
        service,
        { tenantIdFilter: tenantId, reviewDeliveryEnabled: false },
      );

      await expect(gateway.drainOutbox()).resolves.toBe(1);
      expect(sendInteractiveCard).toHaveBeenCalledWith(
        expect.objectContaining({
          receiveId: openId,
          receiveIdType: "open_id",
        }),
      );
      const deliveries = await sql<Array<{ id: string }>>`
        select id from feishu_deliveries
        where tenant_id = ${tenantId} and kind = 'recovery'
          and aggregate_id = ${authorizationId}
      `;
      const deliveryId = deliveries[0]!.id;
      await expect(
        gateway.acceptCardAction({
          event_id: eventId,
          event_type: "card.action.trigger",
          app_id: appId,
          operator: { open_id: openId },
          action: {
            value: {
              deliveryId,
              aggregateId: authorizationId,
              baseVersion: 1,
              action: "recovery_confirm",
            },
          },
          context: { open_message_id: messageId },
        }),
      ).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(gateway.drainInbox()).resolves.toBe(1);
      const states = await sql<Array<{ status: string }>>`
        select status from plugin_device_authorizations where id = ${authorizationId}
      `;
      expect(states).toEqual([{ status: "approved" }]);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(1);
    } finally {
      await sql`delete from feishu_inbox_events where event_id = ${eventId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from plugin_device_authorizations where id = ${authorizationId}`;
      await sql`delete from feishu_partner_bindings where id = ${bindingId}`;
      await sql`delete from plugin_instances where id = ${pluginInstanceId}`;
      await sql`delete from partners where id = ${partnerId}`;
      await sql`delete from teams where id = ${teamId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });
});

describe("FeishuGateway project scope delivery", () => {
  it("sends the initial project review card by Partner email and starts Feishu binding", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const userId = randomUUID();
    const partnerId = randomUUID();
    const pluginInstanceId = randomUUID();
    const bindingCodeId = randomUUID();
    const periodId = randomUUID();
    const entryId = randomUUID();
    const outboxId = randomUUID();
    const reminderOutboxId = randomUUID();
    const appId = `cli_initial_scope_${randomUUID()}`;
    const periodKey = `initial-scope-${periodId}`;
    const email = `initial-scope-${partnerId}@example.com`;
    const messageId = `om_${randomUUID()}`;
    const sendInteractiveCard = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary Feishu failure"))
      .mockResolvedValueOnce({ messageId });
    const updateInteractiveCard = vi.fn(async () => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Initial scope delivery')`;
      await sql`
        insert into users (id, email, display_name, password_hash)
        values (${userId}, ${`initial-scope-admin-${userId}@example.com`}, 'Initial Scope Admin', 'test')
      `;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Initial scope delivery')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${partnerId}, ${tenantId}, ${teamId}, ${email}, 'Initial Scope User')
      `;
      await sql`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, submission_deadline_at, timezone
        ) values (
          ${periodId}, ${tenantId}, ${teamId}, ${periodKey},
          now() - interval '1 day', now() + interval '6 days',
          now() + interval '5 days', now() + interval '6 days',
          'Asia/Shanghai'
        )
      `;
      await sql`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${pluginInstanceId}, ${tenantId}, ${teamId}, ${partnerId},
          'Initial Scope MacBook', '2.0.0', 'access', 'refresh',
          now() + interval '1 day'
        )
      `;
      await sql`
        insert into plugin_binding_codes (
          id, tenant_id, team_id, partner_id, code_hash, code_prefix, label,
          status, plugin_instance_id, created_by
        ) values (
          ${bindingCodeId}, ${tenantId}, ${teamId}, ${partnerId},
          ${"f".repeat(64)}, 'PR-TEST', 'Initial scope binding',
          'connecting', ${pluginInstanceId}, ${userId}
        )
      `;
      await sql`
        insert into project_scope_policies (
          plugin_instance_id, tenant_id, team_id, partner_id,
          version, initialized
        ) values (
          ${pluginInstanceId}, ${tenantId}, ${teamId}, ${partnerId}, 2, false
        )
      `;
      await sql`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id,
          scope_key, display_name, status, first_seen_period_key, session_count
        ) values (
          ${entryId}, ${tenantId}, ${teamId}, ${partnerId},
          ${pluginInstanceId}, ${"1".repeat(64)}, 'Initial Pending Project',
          'pending', ${periodKey}, 3
        )
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${outboxId}, ${tenantId}, 'project_scope.candidates.changed',
          'plugin_instance', ${pluginInstanceId},
          ${JSON.stringify({ periodKey, version: 2 })}::jsonb
        )
      `;

      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "initial-scope-secret" },
        { updateInteractiveCard },
        service,
        { tenantIdFilter: tenantId, reviewDeliveryEnabled: true },
      );

      await expect(gateway.drainOutbox()).resolves.toBe(0);
      await expect(
        sql<Array<{ status: string }>>`
          select status from plugin_binding_codes where id = ${bindingCodeId}
        `,
      ).resolves.toEqual([{ status: "connecting" }]);
      await sql`
        update outbox_events set published_at = now()
        where id = ${outboxId} and tenant_id = ${tenantId}
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${reminderOutboxId}, ${tenantId}, 'project_scope.delivery.requested',
          'plugin_instance', ${pluginInstanceId},
          ${JSON.stringify({ periodKey, version: 2 })}::jsonb
        )
      `;
      await sql`
        update feishu_deliveries set next_retry_at = now() - interval '1 second'
        where tenant_id = ${tenantId} and aggregate_id = ${`${pluginInstanceId}:${periodKey}`}
      `;

      await expect(gateway.drainOutbox()).resolves.toBe(1);
      expect(sendInteractiveCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          receiveId: email,
          receiveIdType: "email",
          card: expect.objectContaining({
            header: expect.objectContaining({
              title: { tag: "plain_text", content: "确认项目采集范围" },
            }),
          }),
        }),
      );
      const bindings = await sql<
        Array<{ status: string; open_id: string | null }>
      >`
        select status, open_id from feishu_partner_bindings
        where tenant_id = ${tenantId} and partner_id = ${partnerId}
          and app_id = ${appId}
      `;
      expect(bindings).toEqual([{ status: "pending", open_id: null }]);
      const bindingCodes = await sql<
        Array<{ status: string; claimed_at: Date | null }>
      >`
        select status, claimed_at from plugin_binding_codes
        where id = ${bindingCodeId}
      `;
      expect(bindingCodes[0]).toMatchObject({
        status: "claimed",
        claimed_at: expect.any(String),
      });
    } finally {
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from plugin_binding_codes where id = ${bindingCodeId}`;
      await sql`delete from project_scope_entries where id = ${entryId}`;
      await sql`delete from project_scope_policies where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from plugin_instances where id = ${pluginInstanceId}`;
      await sql`delete from report_periods where id = ${periodId}`;
      await sql`delete from partners where id = ${partnerId}`;
      await sql`delete from teams where id = ${teamId}`;
      await sql`delete from tenants where id = ${tenantId}`;
      await sql`delete from users where id = ${userId}`;
    }
  });

  it("sends Admin status and later-candidate review cards", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const pluginInstanceId = randomUUID();
    const periodId = randomUUID();
    const bindingId = randomUUID();
    const entryId = randomUUID();
    const pendingEntryId = randomUUID();
    const secondPendingEntryId = randomUUID();
    const outboxId = randomUUID();
    const candidateOutboxId = randomUUID();
    const candidateRetryOutboxId = randomUUID();
    const scopeSubmitEventId = randomUUID();
    const appId = `cli_scope_status_${randomUUID()}`;
    const periodKey = `scope-status-${periodId}`;
    const openId = `ou_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    const newMessageId = `om_${randomUUID()}`;
    const sendInteractiveCard = vi
      .fn()
      .mockResolvedValueOnce({ messageId })
      .mockResolvedValueOnce({ messageId: newMessageId });
    const updateInteractiveCard = vi.fn(async () => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Scope status delivery')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Scope status delivery')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (
          ${partnerId}, ${tenantId}, ${teamId},
          ${`scope-status-${partnerId}@example.com`}, 'Scope Status User'
        )
      `;
      await sql`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, submission_deadline_at, timezone
        ) values (
          ${periodId}, ${tenantId}, ${teamId}, ${periodKey},
          now() - interval '1 day', now() + interval '6 days',
          now() + interval '5 days', now() + interval '6 days',
          'Asia/Shanghai'
        )
      `;
      await sql`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${pluginInstanceId}, ${tenantId}, ${teamId}, ${partnerId},
          'Scope Status MacBook', '0.4.5', 'scope-access', 'scope-refresh',
          now() + interval '1 day'
        )
      `;
      await sql`
        insert into project_scope_policies (
          plugin_instance_id, tenant_id, team_id, partner_id,
          version, initialized, initialized_at
        ) values (
          ${pluginInstanceId}, ${tenantId}, ${teamId}, ${partnerId},
          3, true, now()
        )
      `;
      await sql`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id,
          scope_key, display_name, status, effective_from,
          first_seen_period_key, session_count
        ) values (
          ${entryId}, ${tenantId}, ${teamId}, ${partnerId},
          ${pluginInstanceId}, ${"a".repeat(64)}, 'Allowed Project',
          'allowed', now(), ${periodKey}, 4
        )
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
          ${openId}, 'active', now()
        )
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${outboxId}, ${tenantId}, 'project_scope.delivery.requested',
          'plugin_instance', ${pluginInstanceId},
          ${JSON.stringify({ periodKey })}::jsonb
        )
      `;
      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "scope-status-delivery-secret" },
        { updateInteractiveCard },
        service,
        { tenantIdFilter: tenantId, reviewDeliveryEnabled: true },
      );

      await expect(gateway.drainOutbox()).resolves.toBe(1);
      expect(sendInteractiveCard).toHaveBeenCalledWith(
        expect.objectContaining({
          receiveId: openId,
          receiveIdType: "open_id",
          card: expect.objectContaining({
            header: expect.objectContaining({
              title: { tag: "plain_text", content: "项目采集权限状态" },
            }),
          }),
        }),
      );
      await sql`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id,
          scope_key, display_name, status, first_seen_period_key, session_count
        ) values (
          ${pendingEntryId}, ${tenantId}, ${teamId}, ${partnerId},
          ${pluginInstanceId}, ${"b".repeat(64)}, 'New Pending Project A',
          'pending', ${periodKey}, 2
        ), (
          ${secondPendingEntryId}, ${tenantId}, ${teamId}, ${partnerId},
          ${pluginInstanceId}, ${"c".repeat(64)}, 'New Pending Project B',
          'pending', ${periodKey}, 1
        )
      `;
      await sql`
        update project_scope_policies set version = 4
        where plugin_instance_id = ${pluginInstanceId}
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${candidateOutboxId}, ${tenantId},
          'project_scope.candidates.changed', 'plugin_instance',
          ${pluginInstanceId}, ${JSON.stringify({ periodKey, version: 4 })}::jsonb
        )
      `;

      const published = await gateway.drainOutbox();
      expect(sendInteractiveCard).toHaveBeenCalledTimes(2);
      expect(sendInteractiveCard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          card: expect.objectContaining({
            header: expect.objectContaining({
              title: { tag: "plain_text", content: "审批本周期新增项目" },
            }),
          }),
        }),
      );
      expect(updateInteractiveCard).not.toHaveBeenCalled();
      expect(published).toBe(1);
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${candidateRetryOutboxId}, ${tenantId},
          'project_scope.candidates.changed', 'plugin_instance',
          ${pluginInstanceId}, ${JSON.stringify({ periodKey, version: 4 })}::jsonb
        )
      `;
      await expect(gateway.drainOutbox()).resolves.toBe(1);
      expect(sendInteractiveCard).toHaveBeenCalledTimes(2);

      const scopeDeliveries = await sql<Array<{ id: string }>>`
        select id from feishu_deliveries
        where tenant_id = ${tenantId} and kind = 'scope'
          and aggregate_id = ${`${pluginInstanceId}:${periodKey}`}
          and message_id = ${newMessageId}
        limit 1
      `;
      await expect(
        gateway.acceptCardAction({
          event_id: scopeSubmitEventId,
          event_type: "card.action.trigger",
          app_id: appId,
          operator: { open_id: openId },
          action: {
            value: {
              deliveryId: scopeDeliveries[0]!.id,
              aggregateId: `${pluginInstanceId}:${periodKey}`,
              baseVersion: 4,
              action: "scope_submit",
            },
            form_value: {
              scope_decision_0: "allow",
              scope_decision_1: "deny",
            },
          },
          context: { open_message_id: newMessageId },
        }),
      ).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(gateway.drainInbox()).resolves.toBe(1);

      const decisions = await sql<
        Array<{ display_name: string; status: string }>
      >`
        select display_name, status from project_scope_entries
        where id in (${pendingEntryId}, ${secondPendingEntryId})
        order by display_name asc
      `;
      expect(decisions).toEqual([
        { display_name: "New Pending Project A", status: "allowed" },
        { display_name: "New Pending Project B", status: "denied" },
      ]);
      const policies = await sql<Array<{ version: number }>>`
        select version from project_scope_policies
        where plugin_instance_id = ${pluginInstanceId}
      `;
      expect(policies).toEqual([{ version: 5 }]);
      const completedDeliveries = await sql<Array<{ domain_version: number }>>`
        select domain_version from feishu_deliveries
        where id = ${scopeDeliveries[0]!.id}
      `;
      expect(completedDeliveries).toEqual([{ domain_version: 5 }]);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(1);
    } finally {
      await sql`delete from feishu_inbox_events where event_id = ${scopeSubmitEventId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where id = ${bindingId}`;
      await sql`delete from project_scope_entries where id in (${entryId}, ${pendingEntryId}, ${secondPendingEntryId})`;
      await sql`delete from project_scope_policies where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from plugin_instances where id = ${pluginInstanceId}`;
      await sql`delete from report_periods where id = ${periodId}`;
      await sql`delete from partners where id = ${partnerId}`;
      await sql`delete from teams where id = ${teamId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });
});

describe("FeishuGateway delivery retry selection", () => {
  it("does not let stale deferred reviews starve a live review at the retry limit", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const bindingId = randomUUID();
    const livePeriodId = randomUUID();
    const liveReviewId = randomUUID();
    const liveWorkItemId = randomUUID();
    const liveDeliveryId = randomUUID();
    const appId = `cli_retry_selection_test_${randomUUID()}`;
    const openId = `ou_${randomUUID()}`;
    const email = `retry-selection-${partnerId}@example.com`;
    const stalePeriodIds = Array.from({ length: 20 }, () => randomUUID());
    const staleReviewIds = Array.from({ length: 20 }, () => randomUUID());
    const staleDeliveryIds = Array.from({ length: 20 }, () => randomUUID());
    const sendInteractiveCard = vi.fn(async () => ({
      messageId: `om_${randomUUID()}`,
    }));
    const updateInteractiveCard = vi.fn(async () => undefined);

    try {
      await sql`
        insert into tenants (id, name)
        values (${tenantId}, 'Feishu retry selection test')
      `;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Feishu retry selection test')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (
          ${partnerId}, ${tenantId}, ${teamId}, ${email},
          'Feishu Retry Selection Test'
        )
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, open_id, status,
          verified_at
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
          ${openId}, 'active', now()
        )
      `;

      for (const [index, staleReviewId] of staleReviewIds.entries()) {
        const stalePeriodId = stalePeriodIds[index]!;
        const staleDeliveryId = staleDeliveryIds[index]!;
        await sql`
          insert into report_periods (
            id, tenant_id, team_id, period_key, starts_at, ends_at,
            cutoff_at, submission_deadline_at, timezone
          ) values (
            ${stalePeriodId}, ${tenantId}, ${teamId},
            ${`retry-stale-${index}-${stalePeriodId}`},
            '2098-01-01T00:00:00Z', '2098-01-07T23:59:59Z',
            '2098-01-07T12:00:00Z', '2098-01-08T12:00:00Z',
            'Asia/Shanghai'
          )
        `;
        await sql`
          insert into reviews (
            id, tenant_id, team_id, partner_id, period_id, state, version,
            approved_count, excluded_count, pending_count
          ) values (
            ${staleReviewId}, ${tenantId}, ${teamId}, ${partnerId},
            ${stalePeriodId}, 'ITEMS_APPROVED', 1, 1, 0, 0
          )
        `;
        await sql`
          insert into feishu_deliveries (
            id, tenant_id, team_id, partner_id, kind, aggregate_type,
            aggregate_id, receive_id, receive_id_type, domain_version,
            status, idempotency_key, updated_at
          ) values (
            ${staleDeliveryId}, ${tenantId}, ${teamId}, ${partnerId},
            'review', 'review', ${staleReviewId}, ${email}, 'email', null,
            'deferred', ${`retry-stale:${appId}:${staleReviewId}`},
            '2000-01-01T00:00:00Z'
          )
        `;
      }

      await sql`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, submission_deadline_at, timezone
        ) values (
          ${livePeriodId}, ${tenantId}, ${teamId},
          ${`retry-live-${livePeriodId}`},
          '2099-01-01T00:00:00Z', '2099-01-07T23:59:59Z',
          '2099-01-07T12:00:00Z', '2099-01-08T12:00:00Z',
          'Asia/Shanghai'
        )
      `;
      await sql`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, version,
          approved_count, excluded_count, pending_count
        ) values (
          ${liveReviewId}, ${tenantId}, ${teamId}, ${partnerId},
          ${livePeriodId}, 'IN_PROGRESS', 1, 0, 0, 1
        )
      `;
      await sql`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${liveWorkItemId}, ${tenantId}, ${teamId}, ${partnerId},
          ${livePeriodId}, ${liveReviewId}, 'Live deferred review',
          'in_progress', 'pending', '[]'::jsonb,
          '{"overview":"Ready for review","dailyProgress":[]}'::jsonb
        )
      `;
      await sql`
        insert into feishu_deliveries (
          id, tenant_id, team_id, partner_id, kind, aggregate_type,
          aggregate_id, receive_id, receive_id_type, domain_version,
          status, idempotency_key, updated_at
        ) values (
          ${liveDeliveryId}, ${tenantId}, ${teamId}, ${partnerId},
          'review', 'review', ${liveReviewId}, ${email}, 'email', null,
          'deferred', ${`review:${appId}:${partnerId}:${liveReviewId}`},
          '2001-01-01T00:00:00Z'
        )
      `;

      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "retry-selection-test-secret" },
        { updateInteractiveCard },
        service,
        { tenantIdFilter: tenantId },
      );

      await expect(gateway.retryDueDeliveries(20)).resolves.toBe(1);
      expect(sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(updateInteractiveCard).not.toHaveBeenCalled();

      const liveDelivery = await sql<
        Array<{
          status: string;
          receive_id: string;
          receive_id_type: string;
          message_id: string | null;
          domain_version: number | null;
        }>
      >`
        select status, receive_id, receive_id_type, message_id, domain_version
        from feishu_deliveries
        where id = ${liveDeliveryId} and tenant_id = ${tenantId}
      `;
      expect(liveDelivery).toEqual([
        {
          status: "sent",
          receive_id: openId,
          receive_id_type: "open_id",
          message_id: expect.stringMatching(/^om_/),
          domain_version: 1,
        },
      ]);

      const staleDeliveries = await sql<Array<{ status: string }>>`
        select status from feishu_deliveries
        where tenant_id = ${tenantId} and id = any(${staleDeliveryIds}::uuid[])
      `;
      expect(staleDeliveries).toHaveLength(20);
      expect(
        staleDeliveries.every((delivery) => delivery.status === "deferred"),
      ).toBe(true);
    } finally {
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from work_items where tenant_id = ${tenantId}`;
      await sql`delete from reviews where tenant_id = ${tenantId}`;
      await sql`delete from report_periods where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });
});

describe("FeishuGateway outbox ordering", () => {
  it("keeps a newer review event unpublished while an older card update is in flight", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const periodId = randomUUID();
    const reviewId = randomUUID();
    const workItemId = randomUUID();
    const bindingId = randomUUID();
    const deliveryId = randomUUID();
    const firstOutboxId = randomUUID();
    const secondOutboxId = randomUUID();
    const appId = `cli_outbox_order_test_${randomUUID()}`;
    const openId = `ou_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    const email = `outbox-order-${partnerId}@example.com`;
    const sendInteractiveCard = vi.fn(async () => ({
      messageId: `om_unexpected_${randomUUID()}`,
    }));
    let signalFirstPatchStarted!: () => void;
    let releaseFirstPatch!: () => void;
    const firstPatchStarted = new Promise<void>((resolve) => {
      signalFirstPatchStarted = resolve;
    });
    const firstPatchBlocked = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve;
    });
    let patchCount = 0;
    const updateInteractiveCard = vi.fn(async () => {
      patchCount += 1;
      if (patchCount === 1) {
        signalFirstPatchStarted();
        await firstPatchBlocked;
      }
    });
    let firstDrain: Promise<number> | undefined;

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Feishu outbox ordering test')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Feishu outbox ordering test')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (
          ${partnerId}, ${tenantId}, ${teamId}, ${email},
          'Feishu Outbox Ordering Test'
        )
      `;
      await sql`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at,
          cutoff_at, submission_deadline_at, timezone
        ) values (
          ${periodId}, ${tenantId}, ${teamId}, ${`2099-${periodId}`},
          '2099-02-01T00:00:00Z', '2099-02-07T23:59:59Z',
          '2099-02-07T12:00:00Z', '2099-02-08T12:00:00Z',
          'Asia/Shanghai'
        )
      `;
      await sql`
        insert into reviews (
          id, tenant_id, team_id, partner_id, period_id, state, version,
          approved_count, excluded_count, pending_count
        ) values (
          ${reviewId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          'IN_PROGRESS', 1, 0, 0, 1
        )
      `;
      await sql`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          title, status, review_status, fact_ids, payload
        ) values (
          ${workItemId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
          ${reviewId}, 'Outbox ordering review item', 'in_progress',
          'pending', '[]'::jsonb,
          '{"overview":"Version one","dailyProgress":[]}'::jsonb
        )
      `;
      await sql`
        insert into feishu_partner_bindings (
          id, tenant_id, team_id, partner_id, app_id, open_id, status,
          verified_at
        ) values (
          ${bindingId}, ${tenantId}, ${teamId}, ${partnerId}, ${appId},
          ${openId}, 'active', now()
        )
      `;
      await sql`
        insert into feishu_deliveries (
          id, tenant_id, team_id, partner_id, kind, aggregate_type,
          aggregate_id, receive_id, receive_id_type, message_id,
          domain_version, status, idempotency_key, sent_at
        ) values (
          ${deliveryId}, ${tenantId}, ${teamId}, ${partnerId}, 'review',
          'review', ${reviewId}, ${openId}, 'open_id', ${messageId},
          null, 'sent', ${`review:${appId}:${partnerId}:${reviewId}`}, now()
        )
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${firstOutboxId}, ${tenantId}, 'work_items.draft.created',
          'review', ${reviewId}, '{"version":1}'::jsonb
        )
      `;

      const firstService = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const secondService = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const firstGateway = new FeishuGateway(
        { appId, appSecret: "outbox-order-test-secret" },
        { updateInteractiveCard },
        firstService,
        { tenantIdFilter: tenantId },
      );
      const secondGateway = new FeishuGateway(
        { appId, appSecret: "outbox-order-test-secret" },
        { updateInteractiveCard },
        secondService,
        { tenantIdFilter: tenantId },
      );

      firstDrain = firstGateway.drainOutbox();
      await firstPatchStarted;

      await sql`
        update reviews set version = 2, updated_at = now()
        where id = ${reviewId} and tenant_id = ${tenantId}
      `;
      await sql`
        update work_items set
          payload = '{"overview":"Version two","dailyProgress":[]}'::jsonb,
          updated_at = now()
        where id = ${workItemId} and tenant_id = ${tenantId}
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${secondOutboxId}, ${tenantId}, 'work_item.review.changed',
          'review', ${reviewId}, '{"version":2}'::jsonb
        )
      `;

      await expect(secondGateway.drainOutbox()).resolves.toBe(0);
      const whileFirstPatchIsBlocked = await sql<
        Array<{ id: string; published: boolean }>
      >`
        select id, published_at is not null as published
        from outbox_events
        where tenant_id = ${tenantId}
        order by case when id = ${firstOutboxId} then 1 else 2 end
      `;
      expect(whileFirstPatchIsBlocked).toEqual([
        { id: firstOutboxId, published: false },
        { id: secondOutboxId, published: false },
      ]);

      releaseFirstPatch();
      await expect(firstDrain).resolves.toBe(1);
      firstDrain = undefined;

      await expect(secondGateway.drainOutbox()).resolves.toBe(1);
      const completed = await sql<Array<{ id: string; published: boolean }>>`
        select id, published_at is not null as published
        from outbox_events
        where tenant_id = ${tenantId}
        order by case when id = ${firstOutboxId} then 1 else 2 end
      `;
      expect(completed).toEqual([
        { id: firstOutboxId, published: true },
        { id: secondOutboxId, published: true },
      ]);
      const deliveries = await sql<
        Array<{ domain_version: number | null; status: string }>
      >`
        select domain_version, status from feishu_deliveries
        where id = ${deliveryId} and tenant_id = ${tenantId}
      `;
      expect(deliveries).toEqual([{ domain_version: 2, status: "sent" }]);
      expect(updateInteractiveCard).toHaveBeenCalledTimes(2);
      expect(sendInteractiveCard).not.toHaveBeenCalled();
    } finally {
      releaseFirstPatch?.();
      await firstDrain?.catch(() => undefined);
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from work_items where tenant_id = ${tenantId}`;
      await sql`delete from reviews where tenant_id = ${tenantId}`;
      await sql`delete from report_periods where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });
});
