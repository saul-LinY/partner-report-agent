import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlClient as defaultDatabase } from "@partner-report/db";
import { ApiError, type DomainActor } from "../common.js";
import {
  decideReviewWorkItem,
  regenerateReviewWorkItem,
} from "../routes/reviews.js";
import {
  feishuActionValueSchema,
  REVIEW_REGENERATION_INSTRUCTION_FIELD,
  renderErrorCard,
  renderLockedCard,
  renderStaleCard,
  renderStatusCard,
  SCOPE_FORM_FIELD_PREFIX,
  SCOPE_FORM_PROJECT_LIMIT,
  type FeishuActionValue,
  type FeishuCard,
} from "./cards.js";
import { decideProjectScopes } from "../project-scope.js";
import type { FeishuMessageClient } from "./client.js";
import type { FeishuConfig } from "./config.js";
import {
  FeishuDeliveryService,
  type FeishuActionDelivery,
  type FeishuDeliveryResult,
  type FeishuDeliveryScope,
} from "./delivery.js";

type Database = typeof defaultDatabase;

export type FeishuGatewayLogger = {
  info: (context: unknown, message?: string) => void;
  warn: (context: unknown, message?: string) => void;
  error: (context: unknown, message?: string) => void;
};

const quietLogger: FeishuGatewayLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const opaqueIdSchema = z.string().trim().min(1).max(256);
const projectScopeFormDecisionSchema = z.enum(["allow", "deny"]);
const cardActionEventSchema = z
  .object({
    event_id: opaqueIdSchema,
    event_type: z.string().trim().min(1).max(128).optional(),
    app_id: opaqueIdSchema,
    tenant_key: opaqueIdSchema.optional(),
    operator: z
      .object({
        open_id: opaqueIdSchema,
        union_id: opaqueIdSchema.optional(),
      })
      .passthrough(),
    action: z
      .object({
        value: z.unknown(),
        form_value: z.record(z.unknown()).optional(),
      })
      .passthrough(),
    context: z
      .object({
        open_message_id: opaqueIdSchema,
      })
      .passthrough(),
  })
  .passthrough();

const storedCardActionSchema = z
  .object({
    appId: opaqueIdSchema,
    tenantKey: opaqueIdSchema.optional(),
    operatorOpenId: opaqueIdSchema,
    operatorUnionId: opaqueIdSchema.optional(),
    messageId: opaqueIdSchema,
    value: feishuActionValueSchema,
    formValue: z.record(z.unknown()).default({}),
  })
  .strict();

type StoredCardAction = z.infer<typeof storedCardActionSchema>;

type InboxRow = {
  id: string;
  event_id: string;
  sanitized_payload: unknown;
};

type OutboxRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
};

type DeliveryRetryRow = FeishuDeliveryScope & {
  kind: "binding" | "recovery" | "scope" | "review";
  aggregateId: string;
};

export type FeishuCallbackResponse = {
  toast: {
    type: "success" | "error";
    content: string;
  };
};

function callbackResponse(
  type: "success" | "error",
  content: string,
): FeishuCallbackResponse {
  return { toast: { type, content } };
}

function expectedDeliveryKind(
  action: FeishuActionValue["action"],
): "binding" | "recovery" | "scope" | "review" {
  if (action === "binding_confirm") return "binding";
  if (action === "recovery_confirm") return "recovery";
  if (action.startsWith("scope_")) return "scope";
  return "review";
}

function parseScopeAggregateId(aggregateId: string) {
  const separator = aggregateId.indexOf(":");
  if (separator < 1)
    throw new ApiError(400, "PROJECT_SCOPE_INVALID", "项目权限卡片无效。");
  return {
    pluginInstanceId: aggregateId.slice(0, separator),
    periodKey: aggregateId.slice(separator + 1),
  };
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isOpenIdUniqueViolation(error: unknown): boolean {
  const record = safeRecord(error);
  const constraint = record.constraint_name ?? record.constraint;
  return (
    record.code === "23505" &&
    constraint === "feishu_partner_bindings_app_open_unique"
  );
}

export function projectScopeFormDecisions(
  formValue: Record<string, unknown>,
  projects: Array<{ scopeKey: string }>,
) {
  const visibleProjects = projects.slice(0, SCOPE_FORM_PROJECT_LIMIT);
  return visibleProjects.map((project, index) => {
    const field = `${SCOPE_FORM_FIELD_PREFIX}${index}`;
    const decision = projectScopeFormDecisionSchema.safeParse(formValue[field]);
    if (!decision.success) {
      throw new ApiError(
        400,
        "PROJECT_SCOPE_DECISIONS_REQUIRED",
        "请为本页每个项目选择采集权限后再提交。",
      );
    }
    return { scopeKey: project.scopeKey, decision: decision.data };
  });
}

export function reviewRegenerationInstruction(
  formValue: Record<string, unknown>,
): string {
  const instruction = z
    .string()
    .trim()
    .min(2)
    .max(1_200)
    .safeParse(formValue[REVIEW_REGENERATION_INSTRUCTION_FIELD]);
  if (!instruction.success) {
    throw new ApiError(
      400,
      "REVIEW_REGENERATION_INSTRUCTION_REQUIRED",
      "请填写 2 至 1200 个字符的修改意见。",
    );
  }
  return instruction.data;
}

function isExpectedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.statusCode < 500;
}

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "FEISHU_ACTION_FAILED",
    message: "飞书审核操作处理失败，将自动重试。",
  };
}

function deliveryNeedsStatusRetry(result: FeishuDeliveryResult): boolean {
  return result.outcome === "deferred";
}

export class FeishuGateway {
  private readonly database: Database;
  private readonly logger: FeishuGatewayLogger;
  private inboxDraining = false;
  private outboxDraining = false;
  private deliveriesDraining = false;
  private kickHandler: (() => void) | null = null;
  private readonly reviewDeliveryEnabled: boolean;
  private readonly tenantIdFilter: string | null;

  constructor(
    private readonly config: FeishuConfig,
    private readonly messageClient: Pick<
      FeishuMessageClient,
      "updateInteractiveCard"
    >,
    private readonly deliveries: FeishuDeliveryService,
    options: {
      database?: Database;
      logger?: FeishuGatewayLogger;
      reviewDeliveryEnabled?: boolean;
      tenantIdFilter?: string;
    } = {},
  ) {
    this.database = options.database ?? defaultDatabase;
    this.logger = options.logger ?? quietLogger;
    this.reviewDeliveryEnabled = options.reviewDeliveryEnabled ?? true;
    this.tenantIdFilter = options.tenantIdFilter ?? null;
  }

  setKickHandler(handler: () => void) {
    this.kickHandler = handler;
  }

  async acceptCardAction(rawEvent: unknown): Promise<FeishuCallbackResponse> {
    const parsedEvent = cardActionEventSchema.safeParse(rawEvent);
    if (!parsedEvent.success) {
      this.logger.warn(
        { reason: "invalid_callback_shape" },
        "Rejected malformed Feishu callback",
      );
      return callbackResponse("error", "卡片数据无效，请刷新后重试。");
    }
    if (parsedEvent.data.app_id !== this.config.appId) {
      this.logger.warn(
        { eventId: parsedEvent.data.event_id, reason: "app_id_mismatch" },
        "Rejected Feishu callback for another app",
      );
      return callbackResponse("error", "应用身份校验失败。");
    }
    const actionValue = feishuActionValueSchema.safeParse(
      parsedEvent.data.action.value,
    );
    if (!actionValue.success) {
      this.logger.warn(
        { eventId: parsedEvent.data.event_id, reason: "invalid_action" },
        "Rejected malformed Feishu card action",
      );
      return callbackResponse("error", "审核操作无效，请刷新卡片。");
    }
    if (
      !this.reviewDeliveryEnabled &&
      !["binding_confirm", "recovery_confirm"].includes(actionValue.data.action)
    ) {
      return callbackResponse("error", "当前服务仅开放身份绑定。");
    }

    const sanitizedPayload = storedCardActionSchema.parse({
      appId: parsedEvent.data.app_id,
      ...(parsedEvent.data.tenant_key
        ? { tenantKey: parsedEvent.data.tenant_key }
        : {}),
      operatorOpenId: parsedEvent.data.operator.open_id,
      ...(parsedEvent.data.operator.union_id
        ? { operatorUnionId: parsedEvent.data.operator.union_id }
        : {}),
      messageId: parsedEvent.data.context.open_message_id,
      value: actionValue.data,
      formValue: parsedEvent.data.action.form_value ?? {},
    });
    const inserted = await this.database<{ id: string }[]>`
      insert into feishu_inbox_events (
        id, event_id, event_type, status, sanitized_payload
      ) values (
        ${randomUUID()}, ${parsedEvent.data.event_id}, 'card.action.trigger',
        'received', ${JSON.stringify(sanitizedPayload)}::jsonb
      )
      on conflict (event_id) do nothing
      returning id
    `;

    this.kickHandler?.();
    return callbackResponse(
      "success",
      inserted[0] ? "已收到，正在处理。" : "该操作已经收到，请勿重复点击。",
    );
  }

  async drainInbox(limit = 10): Promise<number> {
    if (this.inboxDraining) return 0;
    this.inboxDraining = true;
    let processed = 0;
    try {
      while (processed < limit) {
        const event = await this.claimInboxEvent();
        if (!event) break;
        try {
          await this.processInboxEvent(event);
          await this.markInboxProcessed(event.id);
        } catch (error) {
          if (isExpectedError(error)) {
            try {
              await this.reflectExpectedError(event, error);
              await this.markInboxProcessed(event.id, error);
            } catch (reflectionError) {
              await this.markInboxFailed(event.id, reflectionError);
            }
          } else {
            await this.markInboxFailed(event.id, error);
          }
        }
        processed += 1;
      }
      return processed;
    } finally {
      this.inboxDraining = false;
    }
  }

  async drainOutbox(limit = 20): Promise<number> {
    if (this.outboxDraining) return 0;
    this.outboxDraining = true;
    try {
      return await this.database.begin(async (transaction) => {
        const events = await transaction<OutboxRow[]>`
          select id, tenant_id, event_type, aggregate_type, aggregate_id, payload
          from outbox_events
          where published_at is null
          and (${this.tenantIdFilter}::uuid is null or tenant_id = ${this.tenantIdFilter})
          and (
            event_type in (
              'plugin.binding.recovery.requested',
              'project_scope.delivery.requested'
            )
            or (
              ${this.reviewDeliveryEnabled}
              and event_type in (
                'work_items.draft.created',
                'work_item.review.changed',
                'work_items.snapshot.approved',
                'work_items.all_dismissed',
                'review.change.applied',
                'review.reopened',
                'project_scope.candidates.changed',
                'project_scope.period.review_ready'
              )
            )
          )
          and not exists (
            select 1 from feishu_deliveries deferred
            where deferred.tenant_id = outbox_events.tenant_id
              and deferred.aggregate_id = outbox_events.aggregate_id
              and deferred.kind in ('recovery', 'scope', 'review')
              and deferred.status = 'deferred'
              and deferred.receive_id_type = 'email'
              and not exists (
                select 1 from feishu_partner_bindings binding
                where binding.tenant_id = deferred.tenant_id
                  and binding.team_id = deferred.team_id
                  and binding.partner_id = deferred.partner_id
                  and binding.app_id = ${this.config.appId}
                  and binding.status = 'active'
                  and binding.open_id is not null
              )
          )
          order by created_at asc
          for update skip locked
          limit ${limit}
        `;
        let published = 0;
        for (const event of events) {
          try {
            if (await this.processOutboxEvent(event)) {
              await transaction`
                update outbox_events set published_at = now()
                where id = ${event.id} and published_at is null
              `;
              published += 1;
            }
          } catch (error) {
            this.logger.error(
              { eventId: event.id, eventType: event.event_type },
              "Feishu outbox event failed",
            );
          }
        }
        return published;
      });
    } finally {
      this.outboxDraining = false;
    }
  }

  async retryDueDeliveries(
    limit = 20,
    includeReviewDeliveries = true,
  ): Promise<number> {
    if (this.deliveriesDraining) return 0;
    this.deliveriesDraining = true;
    try {
      const rows = await this.database<
        Array<{
          tenant_id: string;
          team_id: string;
          partner_id: string;
          kind: "binding" | "recovery" | "scope" | "review";
          aggregate_id: string;
        }>
      >`
        select d.tenant_id, d.team_id, d.partner_id, d.kind, d.aggregate_id
        from feishu_deliveries d
        where (${this.tenantIdFilter}::uuid is null or d.tenant_id = ${this.tenantIdFilter})
        and (${includeReviewDeliveries} or d.kind = 'recovery')
        and (
          d.kind in ('recovery', 'scope', 'review') and (
            (
              d.status = 'deferred' and exists (
                select 1 from feishu_partner_bindings b
                where b.tenant_id = d.tenant_id and b.team_id = d.team_id
                  and b.partner_id = d.partner_id and b.app_id = ${this.config.appId}
                  and b.status = 'active' and b.open_id is not null
              )
            )
            or (d.status = 'retry_wait' and d.next_retry_at <= now())
            or (
              d.status = 'sending'
              and d.last_attempt_at < now() - interval '2 minutes'
            )
          ) and (
            (d.kind = 'recovery' and exists (
              select 1 from plugin_device_authorizations pda
              where pda.id::text = d.aggregate_id
                and pda.tenant_id = d.tenant_id and pda.team_id = d.team_id
                and pda.partner_id = d.partner_id and pda.status = 'pending'
                and pda.expires_at > now()
            ))
            or (d.kind = 'review' and exists (
              select 1 from reviews r
              where r.id::text = d.aggregate_id and r.tenant_id = d.tenant_id
                and r.team_id = d.team_id and r.partner_id = d.partner_id
                and r.state = 'IN_PROGRESS'
            ))
            or (d.kind = 'scope' and exists (
              select 1 from project_scope_policies psp
              where psp.plugin_instance_id::text = split_part(d.aggregate_id, ':', 1)
                and psp.tenant_id = d.tenant_id and psp.team_id = d.team_id
                and psp.partner_id = d.partner_id
                and exists (
                  select 1 from project_scope_entries pse
                  where pse.plugin_instance_id = psp.plugin_instance_id
                    and pse.status = 'pending'
                )
            ))
          )
        )
        order by d.updated_at asc
        limit ${limit}
      `;
      let attempted = 0;
      for (const row of rows) {
        const retry: DeliveryRetryRow = {
          tenantId: row.tenant_id,
          teamId: row.team_id,
          partnerId: row.partner_id,
          kind: row.kind,
          aggregateId: row.aggregate_id,
        };
        if (retry.kind === "recovery") {
          const authorizations = await this.database<
            Array<{ device_name: string; expires_at: Date | string }>
          >`
            select device_name, expires_at from plugin_device_authorizations
            where id = ${retry.aggregateId} and tenant_id = ${retry.tenantId}
              and team_id = ${retry.teamId} and partner_id = ${retry.partnerId}
              and status = 'pending' and expires_at > now()
            limit 1
          `;
          if (authorizations[0])
            await this.deliveries.deliverRecovery({
              ...retry,
              authorizationId: retry.aggregateId,
              deviceName: authorizations[0].device_name,
              expiresAt: new Date(authorizations[0].expires_at).toISOString(),
            });
        } else if (retry.kind === "review") {
          await this.deliveries.deliverReview({
            ...retry,
            reviewId: retry.aggregateId,
          });
        } else if (retry.kind === "scope") {
          await this.deliveries.deliverScope({
            ...retry,
            ...parseScopeAggregateId(retry.aggregateId),
          });
        }
        attempted += 1;
      }
      return attempted;
    } finally {
      this.deliveriesDraining = false;
    }
  }

  private async claimInboxEvent(): Promise<InboxRow | null> {
    const rows = await this.database<InboxRow[]>`
      update feishu_inbox_events set status = 'processing', updated_at = now()
      where id = (
        select id from feishu_inbox_events
        where status = 'received'
          or (status = 'failed' and updated_at < now() - interval '30 seconds')
          or (status = 'processing' and updated_at < now() - interval '2 minutes')
        order by received_at asc
        for update skip locked
        limit 1
      )
      returning id, event_id, sanitized_payload
    `;
    return rows[0] ?? null;
  }

  private async processInboxEvent(row: InboxRow): Promise<void> {
    const event = storedCardActionSchema.parse(row.sanitized_payload);
    const kind = expectedDeliveryKind(event.value.action);
    const delivery = await this.deliveries.loadDeliveryForAction({
      deliveryId: event.value.deliveryId,
      messageId: event.messageId,
      appId: event.appId,
      operatorOpenId: event.operatorOpenId,
      expectedKind: kind,
      aggregateId: event.value.aggregateId,
    });
    if (!delivery) {
      throw new ApiError(
        403,
        "FEISHU_ACTION_UNAUTHORIZED",
        "卡片与当前飞书身份不匹配。",
      );
    }

    if (event.value.action === "binding_confirm") {
      await this.confirmBinding(row.event_id, event, delivery);
      return;
    }

    if (event.value.action === "recovery_confirm") {
      await this.confirmRecovery(row.event_id, event, delivery);
      return;
    }

    if (
      event.value.action.startsWith("scope_") &&
      delivery.bindingStatus !== "active"
    ) {
      await this.confirmScopeBinding(row.event_id, event, delivery);
    }

    const actor: DomainActor = {
      actorType: "feishu",
      actorId: event.operatorOpenId,
      userId: delivery.partnerUserId,
      tenantId: delivery.tenantId,
      teamId: delivery.teamId,
      partnerId: delivery.partnerId,
    };
    const scope: FeishuDeliveryScope = delivery;

    if (event.value.action.startsWith("scope_")) {
      const aggregate = parseScopeAggregateId(event.value.aggregateId);
      const view = await this.deliveries.loadScopeDeliveryView(
        scope,
        aggregate.pluginInstanceId,
        aggregate.periodKey,
      );
      if (!view)
        throw new ApiError(
          409,
          "PROJECT_SCOPE_ALREADY_REVIEWED",
          "当前项目权限已经处理完成。",
        );
      const isFormSubmit = event.value.action === "scope_submit";
      const selected = isFormSubmit
        ? view.projects.slice(0, SCOPE_FORM_PROJECT_LIMIT)
        : event.value.action === "scope_allow_all" ||
            event.value.action === "scope_deny_all"
          ? view.projects
          : view.projects.filter(
              (project) =>
                "scopeKey" in event.value &&
                project.scopeKey === event.value.scopeKey,
            );
      if (selected.length === 0)
        throw new ApiError(
          404,
          "PROJECT_SCOPE_NOT_FOUND",
          "该项目已不在待审批列表中。",
        );
      const allow =
        event.value.action === "scope_allow" ||
        event.value.action === "scope_allow_all";
      const decisions = isFormSubmit
        ? projectScopeFormDecisions(event.formValue, view.projects)
        : selected.map((project) => ({
            scopeKey: project.scopeKey,
            decision: allow ? ("allow" as const) : ("deny" as const),
          }));
      const result = await decideProjectScopes(
        actor,
        aggregate.pluginInstanceId,
        {
          baseVersion: event.value.baseVersion,
          decisions,
        },
        this.database,
      );
      await this.auditOnce(
        row.event_id,
        actor,
        isFormSubmit
          ? "project_scope.decisions_submitted"
          : allow
            ? "project_scope.allowed"
            : "project_scope.denied",
        "plugin_instance",
        aggregate.pluginInstanceId,
        {
          scopeKeys: decisions.map((decision) => decision.scopeKey),
          ...(isFormSubmit
            ? {
                allowed: decisions.filter(
                  (decision) => decision.decision === "allow",
                ).length,
                denied: decisions.filter(
                  (decision) => decision.decision === "deny",
                ).length,
              }
            : {}),
          version: result.version,
        },
      );
      const refreshed = await this.deliveries.deliverScope({
        ...scope,
        pluginInstanceId: aggregate.pluginInstanceId,
        periodKey: aggregate.periodKey,
      });
      if (refreshed.reason === "not_reviewable") {
        await this.deliveries.patchScopeStatus({
          ...scope,
          aggregateId: event.value.aggregateId,
          targetDomainVersion: result.version,
          card: renderStatusCard({
            kind: "locked",
            title: "项目采集范围已确认",
            message:
              "权限已同步到 Partner Report。插件下次运行时会自动拉取最新规则。",
          }),
        });
      }
      return;
    }

    if (
      event.value.action === "review_approve" ||
      event.value.action === "review_exclude"
    ) {
      const result = await decideReviewWorkItem(actor, {
        reviewId: event.value.aggregateId,
        workItemId: event.value.itemId,
        decision:
          event.value.action === "review_approve" ? "approve" : "exclude",
        baseVersion: event.value.baseVersion,
      });
      await this.auditOnce(
        row.event_id,
        actor,
        `work_item.${
          event.value.action === "review_approve" ? "approved" : "excluded"
        }`,
        "work_item",
        event.value.itemId,
        {
          reviewId: event.value.aggregateId,
          version: result.version,
          idempotent: !result.decisionApplied,
        },
      );
      if (result.finalized) {
        const allDismissed = result.finalized.ignored === true;
        await this.deliveries.patchReviewStatus({
          ...scope,
          reviewId: event.value.aggregateId,
          card: renderStatusCard({
            kind: "locked",
            title: "项目卡片审核已完成",
            message: allDismissed
              ? "本期工作卡片均已忽略，将记录为本期无可汇报内容。"
              : "审核结果已经锁定，将用于本期团队报告汇总。",
          }),
        });
      } else {
        await this.deliveries.deliverReview({
          ...scope,
          reviewId: event.value.aggregateId,
        });
      }
      return;
    }

    if (event.value.action === "review_regenerate") {
      const instruction = reviewRegenerationInstruction(event.formValue);
      const result = await regenerateReviewWorkItem(actor, {
        reviewId: event.value.aggregateId,
        workItemId: event.value.itemId,
        instruction,
        baseVersion: event.value.baseVersion,
      });
      await this.auditOnce(
        row.event_id,
        actor,
        "project_card.regeneration_requested",
        "work_item",
        event.value.itemId,
        {
          reviewId: event.value.aggregateId,
          jobId: result.jobId,
          version: result.version,
          instructionLength: Array.from(instruction).length,
        },
      );
      const refreshed = await this.deliveries.deliverReview({
        ...scope,
        reviewId: event.value.aggregateId,
      });
      if (deliveryNeedsStatusRetry(refreshed)) {
        throw new Error("FEISHU_REGENERATION_STATUS_DEFERRED");
      }
      return;
    }

    throw new ApiError(
      409,
      "FEISHU_ACTION_DISABLED",
      "当前卡片操作已停用，请使用最新卡片。",
    );
  }

  private async confirmBinding(
    requestId: string,
    event: StoredCardAction,
    delivery: FeishuActionDelivery,
  ): Promise<void> {
    const actor: DomainActor = {
      actorType: "feishu",
      actorId: event.operatorOpenId,
      userId: delivery.partnerUserId,
      tenantId: delivery.tenantId,
      teamId: delivery.teamId,
      partnerId: delivery.partnerId,
    };
    try {
      await this.database.begin(async (transaction) => {
        const conflicts = await transaction<Array<{ partner_id: string }>>`
        select partner_id from feishu_partner_bindings
        where app_id = ${this.config.appId} and open_id = ${event.operatorOpenId}
          and partner_id <> ${delivery.partnerId}
        for update
      `;
        if (conflicts[0]) {
          throw new ApiError(
            409,
            "FEISHU_ACCOUNT_ALREADY_BOUND",
            "此飞书账号已经绑定到其他 Partner。",
          );
        }
        const bindings = await transaction<
          Array<{
            status: string;
            open_id: string | null;
            tenant_key: string | null;
          }>
        >`
        select status, open_id, tenant_key from feishu_partner_bindings
        where id = ${delivery.bindingId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
          and app_id = ${this.config.appId}
        for update
      `;
        const binding = bindings[0];
        if (!binding) {
          throw new ApiError(
            404,
            "FEISHU_BINDING_NOT_FOUND",
            "身份绑定请求不存在或已经失效。",
          );
        }
        if (binding.open_id && binding.open_id !== event.operatorOpenId) {
          throw new ApiError(
            409,
            "FEISHU_BINDING_MISMATCH",
            "此 Partner 已绑定到另一个飞书账号。",
          );
        }
        if (
          binding.tenant_key &&
          event.tenantKey &&
          binding.tenant_key !== event.tenantKey
        ) {
          throw new ApiError(
            409,
            "FEISHU_TENANT_MISMATCH",
            "飞书企业身份与已有绑定不一致。",
          );
        }
        await transaction`
        update feishu_partner_bindings set
          open_id = ${event.operatorOpenId},
          union_id = coalesce(${event.operatorUnionId ?? null}, union_id),
          tenant_key = coalesce(${event.tenantKey ?? null}, tenant_key),
          status = 'active', verified_at = coalesce(verified_at, now()),
          updated_at = now()
        where id = ${delivery.bindingId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
      `;
        await transaction`
        update feishu_deliveries set status = 'confirmed', updated_at = now()
        where id = ${delivery.deliveryId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
      `;
        await this.insertAudit(
          transaction,
          requestId,
          actor,
          "feishu.binding.confirmed",
          "partner",
          delivery.partnerId,
          {},
        );
      });
    } catch (error) {
      if (isOpenIdUniqueViolation(error)) {
        throw new ApiError(
          409,
          "FEISHU_ACCOUNT_ALREADY_BOUND",
          "此飞书账号已经绑定到其他 Partner。",
        );
      }
      throw error;
    }

    await this.messageClient.updateInteractiveCard({
      messageId: event.messageId,
      card: renderStatusCard({
        kind: "locked",
        title: "飞书审核身份已连接",
        message: `已完成 ${delivery.partnerEmail} 的审核身份绑定。后续项目权限和工作卡片会私发到当前飞书账号。`,
      }),
    });
    if (this.reviewDeliveryEnabled) {
      await this.deliveries.syncPartnerPendingApprovals(delivery);
    }
  }

  private async confirmScopeBinding(
    requestId: string,
    event: StoredCardAction,
    delivery: FeishuActionDelivery,
  ): Promise<void> {
    const actor: DomainActor = {
      actorType: "feishu",
      actorId: event.operatorOpenId,
      userId: delivery.partnerUserId,
      tenantId: delivery.tenantId,
      teamId: delivery.teamId,
      partnerId: delivery.partnerId,
    };
    await this.database.begin(async (transaction) => {
      const conflicts = await transaction<Array<{ partner_id: string }>>`
        select partner_id from feishu_partner_bindings
        where app_id = ${this.config.appId} and open_id = ${event.operatorOpenId}
          and partner_id <> ${delivery.partnerId}
        for update
      `;
      if (conflicts[0]) {
        throw new ApiError(
          409,
          "FEISHU_ACCOUNT_ALREADY_BOUND",
          "此飞书账号已经绑定到其他 Partner。",
        );
      }
      const bindings = await transaction<
        Array<{ status: string; open_id: string | null }>
      >`
        select status, open_id from feishu_partner_bindings
        where id = ${delivery.bindingId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
          and app_id = ${this.config.appId}
        for update
      `;
      const binding = bindings[0];
      if (!binding)
        throw new ApiError(
          404,
          "FEISHU_BINDING_NOT_FOUND",
          "项目权限绑定不存在或已经失效。",
        );
      if (binding.open_id && binding.open_id !== event.operatorOpenId)
        throw new ApiError(
          409,
          "FEISHU_BINDING_MISMATCH",
          "此 Partner 已绑定到另一个飞书账号。",
        );
      await transaction`
        update feishu_partner_bindings set
          open_id = ${event.operatorOpenId},
          union_id = coalesce(${event.operatorUnionId ?? null}, union_id),
          tenant_key = coalesce(${event.tenantKey ?? null}, tenant_key),
          status = 'active', verified_at = coalesce(verified_at, now()),
          updated_at = now()
        where id = ${delivery.bindingId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
      `;
      await transaction`
        update feishu_deliveries set
          receive_id = ${event.operatorOpenId}, receive_id_type = 'open_id',
          status = case when status = 'confirmed' then status else 'sent' end,
          updated_at = now()
        where id = ${delivery.deliveryId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
      `;
      await this.insertAudit(
        transaction,
        requestId,
        actor,
        "feishu.binding.confirmed_by_project_scope",
        "partner",
        delivery.partnerId,
        { source: "project_scope_card" },
      );
    });
  }

  private async confirmRecovery(
    requestId: string,
    event: StoredCardAction,
    delivery: FeishuActionDelivery,
  ): Promise<void> {
    const actor: DomainActor = {
      actorType: "feishu",
      actorId: event.operatorOpenId,
      userId: delivery.partnerUserId,
      tenantId: delivery.tenantId,
      teamId: delivery.teamId,
      partnerId: delivery.partnerId,
    };
    await this.database.begin(async (transaction) => {
      const rows = await transaction<Array<{ id: string }>>`
        select pda.id from plugin_device_authorizations pda
        join plugin_instances pi
          on pi.id = pda.plugin_instance_id and pi.tenant_id = pda.tenant_id
          and pi.team_id = pda.team_id and pi.partner_id = pda.partner_id
          and pi.status = 'active'
        where pda.id = ${event.value.aggregateId}
          and pda.tenant_id = ${delivery.tenantId}
          and pda.team_id = ${delivery.teamId}
          and pda.partner_id = ${delivery.partnerId}
          and pda.status = 'pending' and pda.expires_at > now()
        for update of pda
      `;
      if (!rows[0])
        throw new ApiError(
          409,
          "PLUGIN_RECOVERY_EXPIRED",
          "此连接恢复申请已失效，请等待插件重新发起。",
        );
      await transaction`
        update plugin_device_authorizations set
          status = 'approved', approved_at = now()
        where id = ${rows[0].id} and status = 'pending'
      `;
      await transaction`
        update feishu_deliveries set status = 'confirmed', updated_at = now()
        where id = ${delivery.deliveryId} and tenant_id = ${delivery.tenantId}
          and team_id = ${delivery.teamId} and partner_id = ${delivery.partnerId}
      `;
      await this.insertAudit(
        transaction,
        requestId,
        actor,
        "plugin.binding.recovery.confirmed",
        "device_authorization",
        rows[0].id,
        {},
      );
    });
    await this.messageClient.updateInteractiveCard({
      messageId: event.messageId,
      card: renderStatusCard({
        kind: "locked",
        title: "插件连接恢复已确认",
        message:
          "新凭据已获授权。插件会在下次定时运行时自动恢复；也可以回到原 Session 说“继续采集”立即执行。",
      }),
    });
  }

  private async reflectExpectedError(
    row: InboxRow,
    error: ApiError,
  ): Promise<void> {
    const event = storedCardActionSchema.parse(row.sanitized_payload);
    const kind = expectedDeliveryKind(event.value.action);
    const delivery = await this.deliveries.loadDeliveryForAction({
      deliveryId: event.value.deliveryId,
      messageId: event.messageId,
      appId: event.appId,
      operatorOpenId: event.operatorOpenId,
      expectedKind: kind,
      aggregateId: event.value.aggregateId,
    });
    if (!delivery) return;
    if (kind === "binding") {
      await this.messageClient.updateInteractiveCard({
        messageId: delivery.messageId,
        card: renderErrorCard({ message: error.message }),
      });
      return;
    }
    if (kind === "recovery") {
      const result = await this.deliveries.patchRecoveryStatus({
        ...delivery,
        authorizationId: event.value.aggregateId,
        card: renderErrorCard({ message: error.message }),
      });
      if (deliveryNeedsStatusRetry(result))
        throw new Error("FEISHU_STATUS_PATCH_DEFERRED");
      return;
    }

    const contentChanged = error.code === "VERSION_CONFLICT";
    if (contentChanged) {
      const result =
        kind === "review"
          ? await this.deliveries.deliverReview({
              ...delivery,
              reviewId: event.value.aggregateId,
            })
          : await this.deliveries.deliverScope({
              ...delivery,
              ...parseScopeAggregateId(event.value.aggregateId),
            });
      if (result.outcome !== "skipped" || result.reason === "already_current")
        return;
    }

    const card: FeishuCard =
      error.code.includes("LOCKED") ||
      error.code === "REVIEW_NOT_EDITABLE"
        ? renderLockedCard({ message: error.message })
        : contentChanged
          ? renderStaleCard({ message: error.message })
          : renderErrorCard({ message: error.message });
    const result =
      kind === "review"
        ? await this.deliveries.patchReviewStatus({
            ...delivery,
            reviewId: event.value.aggregateId,
            card,
          })
        : await this.deliveries.patchScopeStatus({
            ...delivery,
            aggregateId: event.value.aggregateId,
            card,
          });
    if (deliveryNeedsStatusRetry(result)) {
      throw new Error("FEISHU_STATUS_PATCH_DEFERRED");
    }
  }

  private async processOutboxEvent(event: OutboxRow): Promise<boolean> {
    if (event.event_type === "plugin.binding.recovery.requested") {
      const rows = await this.database<
        Array<{
          tenant_id: string;
          team_id: string;
          partner_id: string;
          device_name: string;
          expires_at: Date | string;
        }>
      >`
        select tenant_id, team_id, partner_id, device_name, expires_at
        from plugin_device_authorizations
        where id = ${event.aggregate_id} and tenant_id = ${event.tenant_id}
          and status = 'pending' and expires_at > now()
        limit 1
      `;
      const authorization = rows[0];
      if (!authorization) return true;
      const result = await this.deliveries.deliverRecovery({
        tenantId: authorization.tenant_id,
        teamId: authorization.team_id,
        partnerId: authorization.partner_id,
        authorizationId: event.aggregate_id,
        deviceName: authorization.device_name,
        expiresAt: new Date(authorization.expires_at).toISOString(),
      });
      return !deliveryNeedsStatusRetry(result);
    }

    if (
      event.event_type === "project_scope.candidates.changed" ||
      event.event_type === "project_scope.period.review_ready"
    ) {
      const scope = await this.loadPluginScope(
        event.tenant_id,
        event.aggregate_id,
      );
      if (!scope) return true;
      const payload = safeRecord(event.payload);
      const view = await this.deliveries.loadScopeDeliveryView(
        scope,
        event.aggregate_id,
        typeof payload.periodKey === "string" ? payload.periodKey : undefined,
      );
      if (!view) return true;
      if (
        event.event_type === "project_scope.candidates.changed" &&
        !view.initial
      )
        await this.deliveries.supersedeScopeDelivery({
          ...scope,
          aggregateId: view.aggregateId,
          version: view.version,
        });
      const result = await this.deliveries.deliverScope({
        ...scope,
        pluginInstanceId: event.aggregate_id,
        periodKey: view.periodLabel,
      });
      return !deliveryNeedsStatusRetry(result);
    }

    if (event.event_type === "project_scope.delivery.requested") {
      const scope = await this.loadPluginScope(
        event.tenant_id,
        event.aggregate_id,
      );
      if (!scope) return true;
      const payload = safeRecord(event.payload);
      const periodKey =
        typeof payload.periodKey === "string" ? payload.periodKey : null;
      const result = await this.deliveries.deliverScopeReminder({
        ...scope,
        pluginInstanceId: event.aggregate_id,
        ...(periodKey ? { periodKey } : {}),
      });
      return !deliveryNeedsStatusRetry(result);
    }

    if (
      [
        "work_items.draft.created",
        "work_items.regeneration.failed",
        "work_item.review.changed",
        "review.change.applied",
        "review.reopened",
      ].includes(event.event_type)
    ) {
      const scope = await this.loadReviewScope(
        event.tenant_id,
        event.aggregate_id,
      );
      if (!scope) return true;
      const result = await this.deliveries.deliverReview({
        ...scope,
        reviewId: event.aggregate_id,
      });
      return !deliveryNeedsStatusRetry(result);
    }

    if (
      event.event_type === "work_items.snapshot.approved" ||
      event.event_type === "work_items.all_dismissed"
    ) {
      const completed =
        event.event_type === "work_items.snapshot.approved"
          ? await this.loadSnapshotReviewScope(
              event.tenant_id,
              event.aggregate_id,
            )
          : await this.loadReviewScope(event.tenant_id, event.aggregate_id);
      if (!completed) return true;
      const result = await this.deliveries.patchReviewStatus({
        ...completed,
        reviewId: completed.reviewId,
        card: renderStatusCard({
          kind: "locked",
          title: "项目卡片审核已完成",
          message:
            event.event_type === "work_items.all_dismissed"
              ? "本期工作卡片均已忽略，将记录为本期无可汇报内容。"
              : "审核结果已经锁定，将用于本期团队报告汇总。",
        }),
      });
      if (deliveryNeedsStatusRetry(result)) return false;
      if (event.event_type === "work_items.all_dismissed")
        await this.deliveries.syncPartnerPendingApprovals(
          completed,
          completed.periodKey,
        );
      return true;
    }

    return true;
  }

  private async loadPluginScope(
    tenantId: string,
    pluginInstanceId: string,
  ): Promise<FeishuDeliveryScope | null> {
    const rows = await this.database<
      Array<{ tenant_id: string; team_id: string; partner_id: string }>
    >`
      select tenant_id, team_id, partner_id from plugin_instances
      where id = ${pluginInstanceId} and tenant_id = ${tenantId}
        and status = 'active'
      limit 1
    `;
    const row = rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          teamId: row.team_id,
          partnerId: row.partner_id,
        }
      : null;
  }

  private async loadReviewScope(
    tenantId: string,
    reviewId: string,
  ): Promise<
    (FeishuDeliveryScope & { reviewId: string; periodKey: string }) | null
  > {
    const rows = await this.database<
      Array<{
        tenant_id: string;
        team_id: string;
        partner_id: string;
        period_key: string;
      }>
    >`
      select r.tenant_id, r.team_id, r.partner_id, rp.period_key
      from reviews r
      join report_periods rp on rp.id = r.period_id and rp.tenant_id = r.tenant_id
      where r.id = ${reviewId} and r.tenant_id = ${tenantId}
      limit 1
    `;
    const row = rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          teamId: row.team_id,
          partnerId: row.partner_id,
          reviewId,
          periodKey: row.period_key,
        }
      : null;
  }

  private async loadSnapshotReviewScope(
    tenantId: string,
    snapshotId: string,
  ): Promise<
    (FeishuDeliveryScope & { reviewId: string; periodKey: string }) | null
  > {
    const rows = await this.database<
      Array<{
        tenant_id: string;
        team_id: string;
        partner_id: string;
        review_id: string;
        period_key: string;
      }>
    >`
      select wis.tenant_id, wis.team_id, wis.partner_id, wis.review_id,
        rp.period_key
      from work_item_snapshots wis
      join reviews r on r.id = wis.review_id and r.tenant_id = wis.tenant_id
      join report_periods rp on rp.id = r.period_id and rp.tenant_id = r.tenant_id
      where wis.id = ${snapshotId} and wis.tenant_id = ${tenantId}
      limit 1
    `;
    const row = rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          teamId: row.team_id,
          partnerId: row.partner_id,
          reviewId: row.review_id,
          periodKey: row.period_key,
        }
      : null;
  }

  private async auditOnce(
    requestId: string,
    actor: DomainActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.insertAudit(
      this.database,
      requestId,
      actor,
      action,
      targetType,
      targetId,
      metadata,
    );
  }

  private async insertAudit(
    database: any,
    requestId: string,
    actor: DomainActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await database`
      insert into audit_events (
        id, tenant_id, team_id, actor_type, actor_id, action,
        target_type, target_id, request_id, metadata
      )
      select
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.actorType},
        ${actor.actorId}, ${action}, ${targetType}, ${targetId}, ${requestId},
        ${JSON.stringify(metadata)}::jsonb
      where not exists (
        select 1 from audit_events
        where request_id = ${requestId} and actor_type = ${actor.actorType}
          and actor_id = ${actor.actorId} and action = ${action}
          and target_type = ${targetType} and target_id = ${targetId}
      )
    `;
  }

  private async markInboxProcessed(
    id: string,
    error?: ApiError,
  ): Promise<void> {
    await this.database`
      update feishu_inbox_events set
        status = 'processed', processed_at = now(),
        error_code = ${error?.code ?? null},
        error_message = ${error?.message ?? null}, updated_at = now()
      where id = ${id}
    `;
  }

  private async markInboxFailed(id: string, error: unknown): Promise<void> {
    const failure = safeFailure(error);
    await this.database`
      update feishu_inbox_events set
        status = 'failed', error_code = ${failure.code},
        error_message = ${failure.message}, updated_at = now()
      where id = ${id}
    `;
    this.logger.error(
      { inboxId: id, errorCode: failure.code },
      "Feishu inbox event failed",
    );
  }
}
