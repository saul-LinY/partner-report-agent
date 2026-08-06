import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { isReportContentComplete } from "./cards.js";
import { FeishuDeliveryService } from "./delivery.js";
import { FeishuGateway } from "./gateway.js";

type ReportCallbackFixture = {
  tenantId: string;
  reportId: string;
  eventId: string;
  openId: string;
  updateInteractiveCard: ReturnType<typeof vi.fn>;
  sendInteractiveCard: ReturnType<typeof vi.fn>;
  gateway: FeishuGateway;
  callback: (baseVersion: number) => Record<string, unknown>;
  cleanup: () => Promise<void>;
};

async function createReportCallbackFixture(input: {
  markdown: string;
  contentRevision?: number;
  deliveryVersion?: number;
}): Promise<ReportCallbackFixture> {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const partnerId = randomUUID();
  const periodId = randomUUID();
  const reviewId = randomUUID();
  const snapshotId = randomUUID();
  const reportId = randomUUID();
  const bindingId = randomUUID();
  const deliveryId = randomUUID();
  const eventId = randomUUID();
  const appId = `cli_report_gateway_test_${randomUUID()}`;
  const openId = `ou_${randomUUID()}`;
  const messageId = `om_${randomUUID()}`;
  const email = `report-gateway-${partnerId}@example.com`;
  const contentRevision = input.contentRevision ?? 1;
  const deliveryVersion = input.deliveryVersion ?? contentRevision;
  const sendInteractiveCard = vi.fn(async () => ({
    messageId: `om_unexpected_${randomUUID()}`,
  }));
  const updateInteractiveCard = vi.fn(async () => undefined);

  await sql`insert into tenants (id, name) values (${tenantId}, 'Feishu report callback test')`;
  await sql`
    insert into teams (id, tenant_id, name)
    values (${teamId}, ${tenantId}, 'Feishu report callback test')
  `;
  await sql`
    insert into partners (id, tenant_id, team_id, email, display_name)
    values (
      ${partnerId}, ${tenantId}, ${teamId}, ${email},
      'Feishu Report Callback Test'
    )
  `;
  await sql`
    insert into report_periods (
      id, tenant_id, team_id, period_key, starts_at, ends_at,
      cutoff_at, submission_deadline_at, timezone
    ) values (
      ${periodId}, ${tenantId}, ${teamId}, ${`2099-${periodId}`},
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
      ${reviewId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
      'ITEMS_APPROVED', 1, 1, 0, 0
    )
  `;
  await sql`
    insert into work_item_snapshots (
      id, tenant_id, team_id, partner_id, period_id, review_id,
      review_version, checksum, payload, approved_by_actor_type,
      approved_by_actor_id, approved_at
    ) values (
      ${snapshotId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
      ${reviewId}, 1, ${`report-callback-${snapshotId}`},
      '{"workItems":[],"coverage":{}}'::jsonb, 'feishu', ${openId}, now()
    )
  `;
  await sql`
    insert into individual_reports (
      id, tenant_id, team_id, partner_id, period_id, snapshot_id,
      status, content_revision, title, summary, markdown, payload,
      preferences, source_checksum, generator_version
    ) values (
      ${reportId}, ${tenantId}, ${teamId}, ${partnerId}, ${periodId},
      ${snapshotId}, 'REPORT_REVIEW', ${contentRevision}, '飞书个人报告',
      '待确认的个人报告摘要', ${input.markdown},
      '{"sections":[]}'::jsonb, '{}'::jsonb,
      ${`report-callback-${snapshotId}`}, 'synthetic-test/1.0'
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
      ${deliveryId}, ${tenantId}, ${teamId}, ${partnerId}, 'report',
      'individual_report', ${reportId}, ${openId}, 'open_id', ${messageId},
      ${deliveryVersion}, 'sent',
      ${`report:${appId}:${partnerId}:${reportId}`}, now()
    )
  `;

  const service = new FeishuDeliveryService({
    appId,
    messageClient: { sendInteractiveCard, updateInteractiveCard },
  });
  const gateway = new FeishuGateway(
    { appId, appSecret: "report-gateway-test-secret" },
    { updateInteractiveCard },
    service,
    { tenantIdFilter: tenantId },
  );

  return {
    tenantId,
    reportId,
    eventId,
    openId,
    updateInteractiveCard,
    sendInteractiveCard,
    gateway,
    callback: (baseVersion) => ({
      event_id: eventId,
      event_type: "card.action.trigger",
      app_id: appId,
      tenant_key: "tenant-key-report-test",
      operator: { open_id: openId },
      action: {
        value: {
          deliveryId,
          action: "report_submit",
          aggregateId: reportId,
          baseVersion,
        },
      },
      context: { open_message_id: messageId },
    }),
    cleanup: async () => {
      await sql`delete from feishu_inbox_events where event_id = ${eventId}`;
      await sql`delete from audit_events where tenant_id = ${tenantId}`;
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from agent_jobs where tenant_id = ${tenantId}`;
      await sql`delete from team_report_versions where tenant_id = ${tenantId}`;
      await sql`delete from team_reports where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from individual_reports where tenant_id = ${tenantId}`;
      await sql`delete from work_item_snapshots where tenant_id = ${tenantId}`;
      await sql`delete from reviews where tenant_id = ${tenantId}`;
      await sql`delete from report_periods where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    },
  };
}

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

describe("FeishuGateway plugin binding automation", () => {
  it("sends the Feishu binding card from a claimed-plugin outbox event", async () => {
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const partnerId = randomUUID();
    const outboxId = randomUUID();
    const appId = `cli_plugin_binding_${randomUUID()}`;
    const email = `plugin-binding-${partnerId}@example.com`;
    const messageId = `om_${randomUUID()}`;
    const sendInteractiveCard = vi.fn(async () => ({ messageId }));
    const updateInteractiveCard = vi.fn(async () => undefined);

    try {
      await sql`insert into tenants (id, name) values (${tenantId}, 'Plugin binding automation')`;
      await sql`
        insert into teams (id, tenant_id, name)
        values (${teamId}, ${tenantId}, 'Plugin binding automation')
      `;
      await sql`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${partnerId}, ${tenantId}, ${teamId}, ${email}, 'Automatic Binding')
      `;
      await sql`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${outboxId}, ${tenantId}, 'plugin.binding.claimed', 'partner',
          ${partnerId}, ${JSON.stringify({ teamId, partnerId })}::jsonb
        )
      `;
      const service = new FeishuDeliveryService({
        appId,
        messageClient: { sendInteractiveCard, updateInteractiveCard },
      });
      const gateway = new FeishuGateway(
        { appId, appSecret: "plugin-binding-automation-secret" },
        { updateInteractiveCard },
        service,
        {
          tenantIdFilter: tenantId,
          reviewDeliveryEnabled: false,
        },
      );

      await expect(gateway.drainOutbox()).resolves.toBe(1);
      expect(sendInteractiveCard).toHaveBeenCalledWith(
        expect.objectContaining({
          receiveIdType: "email",
          receiveId: email,
        }),
      );
      const state = await sql<
        Array<{
          binding_status: string;
          delivery_status: string;
          receive_id: string;
          published: boolean;
        }>
      >`
        select b.status as binding_status, d.status as delivery_status,
          d.receive_id, (o.published_at is not null) as published
        from feishu_partner_bindings b
        join feishu_deliveries d on d.tenant_id = b.tenant_id
          and d.partner_id = b.partner_id and d.kind = 'binding'
        join outbox_events o on o.id = ${outboxId}
        where b.tenant_id = ${tenantId} and b.partner_id = ${partnerId}
          and b.app_id = ${appId}
      `;
      expect(state).toEqual([
        {
          binding_status: "pending",
          delivery_status: "sent",
          receive_id: email,
          published: true,
        },
      ]);
    } finally {
      await sql`delete from outbox_events where tenant_id = ${tenantId}`;
      await sql`delete from feishu_deliveries where tenant_id = ${tenantId}`;
      await sql`delete from feishu_partner_bindings where tenant_id = ${tenantId}`;
      await sql`delete from partners where tenant_id = ${tenantId}`;
      await sql`delete from teams where tenant_id = ${tenantId}`;
      await sql`delete from tenants where id = ${tenantId}`;
    }
  });

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

describe("FeishuGateway individual report callback", () => {
  it("submits a fully displayed report for the bound Feishu identity", async () => {
    const markdown = "# 个人报告\n\n本周完成了数据链路审核，并核对了全部事实。";
    expect(isReportContentComplete(markdown)).toBe(true);
    const fixture = await createReportCallbackFixture({ markdown });

    try {
      await expect(
        fixture.gateway.acceptCardAction(fixture.callback(1)),
      ).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(fixture.gateway.drainInbox()).resolves.toBe(1);

      const reports = await sql<
        Array<{
          status: string;
          content_revision: number;
          submitted_at: string | null;
          locked_at: string | null;
        }>
      >`
        select status, content_revision, submitted_at, locked_at
        from individual_reports
        where id = ${fixture.reportId} and tenant_id = ${fixture.tenantId}
      `;
      expect(reports).toEqual([
        expect.objectContaining({
          status: "LOCKED",
          content_revision: 1,
          submitted_at: expect.any(String),
          locked_at: expect.any(String),
        }),
      ]);

      const inbox = await sql<
        Array<{ status: string; error_code: string | null }>
      >`
        select status, error_code from feishu_inbox_events
        where event_id = ${fixture.eventId}
      `;
      expect(inbox).toEqual([{ status: "processed", error_code: null }]);
      const audits = await sql<
        Array<{ actor_type: string; actor_id: string; action: string }>
      >`
        select actor_type, actor_id, action from audit_events
        where tenant_id = ${fixture.tenantId}
          and request_id = ${fixture.eventId}
      `;
      expect(audits).toEqual([
        {
          actor_type: "feishu",
          actor_id: fixture.openId,
          action: "individual_report.submitted",
        },
      ]);
      expect(fixture.updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(fixture.sendInteractiveCard).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a stale report baseVersion without locking the report", async () => {
    const fixture = await createReportCallbackFixture({
      markdown: "# 最新个人报告\n\n这是版本二的完整正文。",
      contentRevision: 2,
      deliveryVersion: 1,
    });

    try {
      await expect(
        fixture.gateway.acceptCardAction(fixture.callback(1)),
      ).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(fixture.gateway.drainInbox()).resolves.toBe(1);

      const reports = await sql<
        Array<{
          status: string;
          content_revision: number;
          submitted_at: Date | null;
          locked_at: Date | null;
        }>
      >`
        select status, content_revision, submitted_at, locked_at
        from individual_reports
        where id = ${fixture.reportId} and tenant_id = ${fixture.tenantId}
      `;
      expect(reports).toEqual([
        {
          status: "REPORT_REVIEW",
          content_revision: 2,
          submitted_at: null,
          locked_at: null,
        },
      ]);
      const inbox = await sql<
        Array<{ status: string; error_code: string | null }>
      >`
        select status, error_code from feishu_inbox_events
        where event_id = ${fixture.eventId}
      `;
      expect(inbox).toEqual([
        { status: "processed", error_code: "REPORT_CONTENT_CHANGED" },
      ]);
      const submissions = await sql<Array<{ count: number }>>`
        select count(*)::int as count from outbox_events
        where tenant_id = ${fixture.tenantId}
          and event_type = 'individual_report.submitted'
      `;
      expect(submissions).toEqual([{ count: 0 }]);
      expect(fixture.updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(fixture.sendInteractiveCard).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a forged submit action when the report body is not fully displayable", async () => {
    const markdown = `# 超长个人报告\n\n${"正文内容".repeat(5_000)}`;
    expect(isReportContentComplete(markdown)).toBe(false);
    const fixture = await createReportCallbackFixture({ markdown });

    try {
      await expect(
        fixture.gateway.acceptCardAction(fixture.callback(1)),
      ).resolves.toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      await expect(fixture.gateway.drainInbox()).resolves.toBe(1);

      const reports = await sql<
        Array<{
          status: string;
          submitted_at: Date | null;
          locked_at: Date | null;
        }>
      >`
        select status, submitted_at, locked_at from individual_reports
        where id = ${fixture.reportId} and tenant_id = ${fixture.tenantId}
      `;
      expect(reports).toEqual([
        { status: "REPORT_REVIEW", submitted_at: null, locked_at: null },
      ]);
      const inbox = await sql<
        Array<{ status: string; error_code: string | null }>
      >`
        select status, error_code from feishu_inbox_events
        where event_id = ${fixture.eventId}
      `;
      expect(inbox).toEqual([
        {
          status: "processed",
          error_code: "FEISHU_REPORT_CONTENT_INCOMPLETE",
        },
      ]);
      const submissions = await sql<Array<{ count: number }>>`
        select count(*)::int as count from outbox_events
        where tenant_id = ${fixture.tenantId}
          and event_type = 'individual_report.submitted'
      `;
      expect(submissions).toEqual([{ count: 0 }]);
      expect(fixture.updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(fixture.sendInteractiveCard).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
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
