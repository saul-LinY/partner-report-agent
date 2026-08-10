import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlClient as defaultDatabase } from "@partner-report/db";
import {
  renderRecoveryCard,
  renderReportCard,
  renderReviewCard,
  renderScopeCard,
  renderScopeStatusCard,
  type FeishuCard,
} from "./cards.js";
import {
  FeishuApiError,
  createFeishuMessageClient,
  type FeishuMessageClient,
} from "./client.js";
import { requireFeishuConfig, type FeishuConfig } from "./config.js";

type Database = typeof defaultDatabase;

export type FeishuDeliveryScope = {
  tenantId: string;
  teamId: string;
  partnerId: string;
};

export type FeishuDeliveryKind =
  "binding" | "recovery" | "scope" | "review" | "report";

export type FeishuDeliveryOutcome = "sent" | "updated" | "deferred" | "skipped";

export type FeishuDeliveryResult = {
  outcome: FeishuDeliveryOutcome;
  deliveryId: string | null;
  messageId?: string;
  domainVersion?: number;
  nextRetryAt?: Date;
  reason?:
    | "binding_required"
    | "binding_delivery_retry"
    | "binding_delivery_busy"
    | "not_reviewable"
    | "retry_not_due"
    | "already_bound"
    | "already_current"
    | "delivery_in_progress"
    | "delivery_failed";
};

export type ReviewDeliveryView = FeishuDeliveryScope & {
  reviewId: string;
  version: number;
  state: string;
  periodLabel: string;
  progress: {
    current: number;
    total: number;
    approved: number;
    excluded: number;
  };
  item: {
    id: string;
    title: string;
    status: string;
    overview: string;
    dailyProgress: Array<{ date: string; summary: string }>;
  };
  regeneration: {
    enabled: true;
    pending: boolean;
  };
};

export type ReportDeliveryView = FeishuDeliveryScope & {
  reportId: string;
  version: number;
  status: string;
  title: string;
  summary: string;
  markdown: string;
  periodLabel: string;
  regeneration: {
    enabled: true;
    pending: boolean;
  };
};

export type ScopeDeliveryView = FeishuDeliveryScope & {
  aggregateId: string;
  pluginInstanceId: string;
  version: number;
  deviceName: string;
  periodLabel: string;
  initial: boolean;
  projects: Array<{
    scopeKey: string;
    displayName: string;
    sessionCount: number;
  }>;
};

export type ScopeStatusDeliveryView = FeishuDeliveryScope & {
  aggregateId: string;
  pluginInstanceId: string;
  version: number;
  deviceName: string;
  periodLabel: string;
  summary: {
    allowed: number;
    denied: number;
  };
  projects: Array<{
    displayName: string;
    permission: "allowed" | "denied";
    sessionCount: number;
  }>;
};

export type FeishuActionDelivery = FeishuDeliveryScope & {
  deliveryId: string;
  kind: FeishuDeliveryKind;
  aggregateType:
    | "partner"
    | "device_authorization"
    | "project_scope"
    | "review"
    | "individual_report";
  aggregateId: string;
  messageId: string;
  receiveId: string;
  receiveIdType: "email" | "open_id";
  domainVersion: number | null;
  partnerUserId: string | null;
  partnerEmail: string;
  bindingId: string;
  bindingStatus: string;
  bindingOpenId: string | null;
};

export type LoadDeliveryForActionInput = {
  deliveryId: string;
  messageId: string;
  appId: string;
  operatorOpenId?: string;
  expectedKind: FeishuDeliveryKind;
  aggregateId: string;
};

type PartnerRow = {
  id: string;
  tenant_id: string;
  team_id: string;
  user_id: string | null;
  email: string;
  display_name: string;
};

type BindingRow = {
  id: string;
  status: string;
  open_id: string | null;
};

type DeliveryRow = {
  id: string;
  tenant_id: string;
  team_id: string;
  partner_id: string;
  kind: string;
  aggregate_type: string;
  aggregate_id: string;
  receive_id: string;
  receive_id_type: string;
  message_id: string | null;
  domain_version: number | null;
  status: string;
  attempt_count: number;
  sent_at: Date | null;
  next_retry_at: Date | null;
};

type MessageClient = Pick<
  FeishuMessageClient,
  "sendInteractiveCard" | "updateInteractiveCard"
>;

const identifierSchema = z.string().trim().min(1).max(256);
const deliveryKindSchema = z.enum([
  "binding",
  "recovery",
  "scope",
  "review",
  "report",
]);
const webOriginSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value));

function safePayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeDailyProgress(
  value: unknown,
): Array<{ date: string; summary: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = safePayload(entry);
    if (typeof record.date !== "string" || typeof record.summary !== "string")
      return [];
    const date = record.date.trim();
    if (!date) return [];
    return [{ date, summary: record.summary }];
  });
}

function aggregateType(kind: Exclude<FeishuDeliveryKind, "binding">) {
  if (kind === "recovery") return "device_authorization";
  if (kind === "scope") return "project_scope";
  return kind === "review" ? "review" : "individual_report";
}

function idempotencyKey(
  appId: string,
  kind: FeishuDeliveryKind,
  partnerId: string,
  aggregateId: string,
) {
  return `${kind}:${appId}:${partnerId}:${aggregateId}`;
}

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FeishuApiError) {
    return {
      code: `FEISHU_${error.reason.toUpperCase()}${
        error.code === null ? "" : `_${error.code}`
      }`,
      message: "飞书接口暂时未完成卡片投递。",
    };
  }
  return {
    code: "FEISHU_DELIVERY_FAILED",
    message: "飞书卡片投递暂时失败。",
  };
}

function retryDelaySeconds(attemptCount: number) {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attemptCount - 1));
}

function messageIdempotencyKey(delivery: DeliveryRow) {
  const recipientFingerprint = createHash("sha256")
    .update(`${delivery.receive_id_type}\0${delivery.receive_id}`)
    .digest("hex")
    .slice(0, 12);
  return `${delivery.id}:${recipientFingerprint}`;
}

export class FeishuDeliveryService {
  private readonly database: Database;
  private readonly messageClient: MessageClient;
  private readonly webOrigin: string | null;
  readonly appId: string;

  constructor(input: {
    appId: string;
    messageClient: MessageClient;
    database?: Database;
    webOrigin?: string;
  }) {
    this.appId = identifierSchema.parse(input.appId);
    this.messageClient = input.messageClient;
    this.database = input.database ?? defaultDatabase;
    this.webOrigin = input.webOrigin
      ? webOriginSchema.parse(input.webOrigin).replace(/\/+$/, "")
      : null;
  }

  async loadReviewDeliveryView(
    scope: FeishuDeliveryScope,
    reviewId: string,
  ): Promise<ReviewDeliveryView | null> {
    const reviews = await this.database<
      Array<{
        id: string;
        state: string;
        version: number;
        period_key: string;
      }>
    >`
      select r.id, r.state, r.version, rp.period_key
      from reviews r
      join report_periods rp
        on rp.id = r.period_id and rp.tenant_id = r.tenant_id
        and rp.team_id = r.team_id
      where r.id = ${reviewId} and r.tenant_id = ${scope.tenantId}
        and r.team_id = ${scope.teamId} and r.partner_id = ${scope.partnerId}
      limit 1
    `;
    const review = reviews[0];
    if (!review || review.state !== "IN_PROGRESS") return null;

    const items = await this.database<
      Array<{
        id: string;
        title: string;
        status: string;
        payload: unknown;
        approved: number;
        excluded: number;
        pending: number;
        total: number;
      }>
    >`
      select wi.id, wi.title, wi.status, wi.payload,
        counts.approved, counts.excluded, counts.pending, counts.total
      from work_items wi
      cross join lateral (
        select
          count(*) filter (where counted.review_status = 'approved')::int as approved,
          count(*) filter (where counted.review_status = 'excluded')::int as excluded,
          count(*) filter (where counted.review_status = 'pending')::int as pending,
          count(*)::int as total
        from work_items counted
        where counted.review_id = ${reviewId}
          and counted.tenant_id = ${scope.tenantId}
          and counted.team_id = ${scope.teamId}
          and counted.partner_id = ${scope.partnerId}
      ) counts
      where wi.review_id = ${reviewId} and wi.tenant_id = ${scope.tenantId}
        and wi.team_id = ${scope.teamId} and wi.partner_id = ${scope.partnerId}
        and wi.review_status = 'pending'
      order by wi.created_at asc, wi.id asc
      limit 1
    `;
    const item = items[0];
    if (!item || item.total < 1 || item.pending < 1) return null;

    const pendingJobs = await this.database<Array<{ id: string }>>`
      select id from agent_jobs
      where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
        and partner_id = ${scope.partnerId} and type = 'AGGREGATE_WORK_ITEMS'
        and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
        and input_payload->>'reviewId' = ${reviewId}
        and input_payload->>'targetWorkItemId' = ${item.id}
      order by created_at desc
      limit 1
    `;
    const payload = safePayload(item.payload);
    return {
      ...scope,
      reviewId: review.id,
      version: review.version,
      state: review.state,
      periodLabel: review.period_key,
      progress: {
        current: item.approved + item.excluded + 1,
        total: item.total,
        approved: item.approved,
        excluded: item.excluded,
      },
      item: {
        id: item.id,
        title: item.title,
        status: item.status,
        overview:
          typeof payload.overview === "string"
            ? payload.overview
            : "暂无项目概览。",
        dailyProgress: safeDailyProgress(payload.dailyProgress),
      },
      regeneration: {
        enabled: true,
        pending: pendingJobs.length > 0,
      },
    };
  }

  async loadReportDeliveryView(
    scope: FeishuDeliveryScope,
    reportId: string,
  ): Promise<ReportDeliveryView | null> {
    const reports = await this.database<
      Array<{
        id: string;
        status: string;
        content_revision: number;
        period_key: string;
        title: string | null;
        summary: string | null;
        markdown: string | null;
      }>
    >`
      select r.id, r.status, r.content_revision, rp.period_key,
        r.title, r.summary, r.markdown
      from individual_reports r
      join report_periods rp
        on rp.id = r.period_id and rp.tenant_id = r.tenant_id
        and rp.team_id = r.team_id
      where r.id = ${reportId} and r.tenant_id = ${scope.tenantId}
        and r.team_id = ${scope.teamId} and r.partner_id = ${scope.partnerId}
      limit 1
    `;
    const report = reports[0];
    if (
      !report ||
      report.content_revision < 1 ||
      !report.title ||
      !report.summary ||
      !report.markdown
    )
      return null;

    const pendingJobs = await this.database<Array<{ id: string }>>`
      select id from agent_jobs
      where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
        and partner_id = ${scope.partnerId}
        and type = 'REGENERATE_INDIVIDUAL_REPORT'
        and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
        and input_payload->>'reportId' = ${reportId}
      order by created_at desc
      limit 1
    `;
    const regenerationPending = pendingJobs.length > 0;
    if (
      report.status !== "REPORT_REVIEW" &&
      !(report.status === "REPORT_DRAFT" && regenerationPending)
    )
      return null;

    return {
      ...scope,
      reportId: report.id,
      version: report.content_revision,
      status: report.status,
      title: report.title,
      summary: report.summary,
      markdown: report.markdown,
      periodLabel: report.period_key,
      regeneration: {
        enabled: true,
        pending: regenerationPending,
      },
    };
  }

  async loadScopeDeliveryView(
    scope: FeishuDeliveryScope,
    pluginInstanceId: string,
    requestedPeriodKey?: string,
  ): Promise<ScopeDeliveryView | null> {
    const rows = await this.database<
      Array<{
        plugin_instance_id: string;
        device_name: string;
        version: number;
        initialized: boolean;
        period_key: string;
      }>
    >`
      select pi.id as plugin_instance_id, pi.device_name, psp.version,
        psp.initialized, rp.period_key
      from plugin_instances pi
      join project_scope_policies psp
        on psp.plugin_instance_id = pi.id and psp.tenant_id = pi.tenant_id
      join lateral (
        select period_key from report_periods
        where tenant_id = pi.tenant_id and team_id = pi.team_id
          and (${requestedPeriodKey ?? null}::text is null or period_key = ${requestedPeriodKey ?? null})
        order by
          case when starts_at <= now() and ends_at >= now() then 0 else 1 end,
          starts_at desc
        limit 1
      ) rp on true
      where pi.id = ${pluginInstanceId} and pi.tenant_id = ${scope.tenantId}
        and pi.team_id = ${scope.teamId} and pi.partner_id = ${scope.partnerId}
        and pi.status = 'active'
      limit 1
    `;
    const policy = rows[0];
    if (!policy) return null;
    const projects = await this.database<
      Array<{ scope_key: string; display_name: string; session_count: number }>
    >`
      select scope_key, display_name, session_count
      from project_scope_entries
      where plugin_instance_id = ${pluginInstanceId}
        and tenant_id = ${scope.tenantId} and status = 'pending'
      order by first_seen_at asc, display_name asc
      limit 500
    `;
    if (projects.length === 0) return null;
    return {
      ...scope,
      aggregateId: `${pluginInstanceId}:${policy.period_key}`,
      pluginInstanceId,
      version: policy.version,
      deviceName: policy.device_name,
      periodLabel: policy.period_key,
      initial: !policy.initialized,
      projects: projects.map((project) => ({
        scopeKey: project.scope_key,
        displayName: project.display_name,
        sessionCount: project.session_count,
      })),
    };
  }

  async loadScopeStatusDeliveryView(
    scope: FeishuDeliveryScope,
    pluginInstanceId: string,
    requestedPeriodKey?: string,
  ): Promise<ScopeStatusDeliveryView | null> {
    const rows = await this.database<
      Array<{
        plugin_instance_id: string;
        device_name: string;
        version: number;
        period_key: string;
      }>
    >`
      select pi.id as plugin_instance_id, pi.device_name, psp.version,
        rp.period_key
      from plugin_instances pi
      join project_scope_policies psp
        on psp.plugin_instance_id = pi.id and psp.tenant_id = pi.tenant_id
      join lateral (
        select period_key from report_periods
        where tenant_id = pi.tenant_id and team_id = pi.team_id
          and (${requestedPeriodKey ?? null}::text is null or period_key = ${requestedPeriodKey ?? null})
        order by
          case when starts_at <= now() and ends_at >= now() then 0 else 1 end,
          starts_at desc
        limit 1
      ) rp on true
      where pi.id = ${pluginInstanceId} and pi.tenant_id = ${scope.tenantId}
        and pi.team_id = ${scope.teamId} and pi.partner_id = ${scope.partnerId}
        and pi.status = 'active'
      limit 1
    `;
    const policy = rows[0];
    if (!policy) return null;
    const projects = await this.database<
      Array<{
        display_name: string;
        status: "pending" | "allowed" | "denied";
        session_count: number;
        pending_count: number;
        allowed_count: number;
        denied_count: number;
      }>
    >`
      select display_name, status, session_count,
        count(*) filter (where status = 'pending') over ()::int as pending_count,
        count(*) filter (where status = 'allowed') over ()::int as allowed_count,
        count(*) filter (where status = 'denied') over ()::int as denied_count
      from project_scope_entries
      where plugin_instance_id = ${pluginInstanceId}
        and tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
        and partner_id = ${scope.partnerId}
      order by case status when 'allowed' then 0 else 1 end,
        display_name asc, first_seen_at asc
      limit 500
    `;
    if (projects.length === 0 || (projects[0]?.pending_count ?? 0) > 0)
      return null;
    return {
      ...scope,
      aggregateId: `${pluginInstanceId}:${policy.period_key}`,
      pluginInstanceId,
      version: policy.version,
      deviceName: policy.device_name,
      periodLabel: policy.period_key,
      summary: {
        allowed: projects[0]?.allowed_count ?? 0,
        denied: projects[0]?.denied_count ?? 0,
      },
      projects: projects.map((project) => ({
        displayName: project.display_name,
        permission: project.status === "allowed" ? "allowed" : "denied",
        sessionCount: project.session_count,
      })),
    };
  }

  renderReviewDeliveryCard(
    view: ReviewDeliveryView,
    deliveryId: string,
  ): FeishuCard {
    return renderReviewCard({
      deliveryId,
      aggregateId: view.reviewId,
      baseVersion: view.version,
      periodLabel: view.periodLabel,
      progress: view.progress,
      item: view.item,
      regeneration: view.regeneration,
    });
  }

  renderReportDeliveryCard(
    view: ReportDeliveryView,
    deliveryId: string,
  ): FeishuCard {
    return renderReportCard({
      deliveryId,
      aggregateId: view.reportId,
      baseVersion: view.version,
      title: view.title,
      summary: view.summary,
      markdown: view.markdown,
      ...(this.webOrigin
        ? {
            detailsUrl: `${this.webOrigin}/partner/report/${encodeURIComponent(
              view.reportId,
            )}`,
          }
        : {}),
      periodLabel: view.periodLabel,
      regeneration: view.regeneration,
    });
  }

  renderScopeDeliveryCard(view: ScopeDeliveryView, deliveryId: string) {
    return renderScopeCard({
      deliveryId,
      aggregateId: view.aggregateId,
      baseVersion: view.version,
      deviceName: view.deviceName,
      periodLabel: view.periodLabel,
      initial: view.initial,
      projects: view.projects,
    });
  }

  renderScopeStatusDeliveryCard(view: ScopeStatusDeliveryView) {
    return renderScopeStatusCard({
      deviceName: view.deviceName,
      periodLabel: view.periodLabel,
      summary: view.summary,
      projects: view.projects,
    });
  }

  async supersedeScopeDelivery(
    input: FeishuDeliveryScope & {
      aggregateId: string;
      version: number;
    },
  ) {
    const canonicalKey = idempotencyKey(
      this.appId,
      "scope",
      input.partnerId,
      input.aggregateId,
    );
    await this.database`
      update feishu_deliveries set
        idempotency_key = idempotency_key || ':superseded:auto:' || ${input.version},
        status = case
          when status in ('pending', 'sending', 'retry_wait', 'failed', 'deferred')
            then 'cancelled'
          else status
        end,
        next_retry_at = null, updated_at = now()
      where tenant_id = ${input.tenantId} and team_id = ${input.teamId}
        and partner_id = ${input.partnerId} and kind = 'scope'
        and aggregate_type = 'project_scope'
        and aggregate_id = ${input.aggregateId}
        and idempotency_key = ${canonicalKey}
        and coalesce(domain_version, 0) < ${input.version}
    `;
  }

  async deliverScope(
    input: FeishuDeliveryScope & {
      pluginInstanceId: string;
      periodKey?: string;
    },
  ) {
    const view = await this.loadScopeDeliveryView(
      input,
      input.pluginInstanceId,
      input.periodKey,
    );
    if (!view)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      } satisfies FeishuDeliveryResult;
    return this.deliverAggregate(
      "scope",
      input,
      view.aggregateId,
      view.version,
      (deliveryId) => this.renderScopeDeliveryCard(view, deliveryId),
    );
  }

  async deliverScopeStatus(
    input: FeishuDeliveryScope & {
      pluginInstanceId: string;
      periodKey?: string;
    },
  ) {
    const view = await this.loadScopeStatusDeliveryView(
      input,
      input.pluginInstanceId,
      input.periodKey,
    );
    if (!view)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      } satisfies FeishuDeliveryResult;
    return this.deliverAggregate(
      "scope",
      input,
      view.aggregateId,
      view.version,
      () => this.renderScopeStatusDeliveryCard(view),
    );
  }

  async deliverScopeReminder(
    input: FeishuDeliveryScope & {
      pluginInstanceId: string;
      periodKey?: string;
    },
  ) {
    const reviewView = await this.loadScopeDeliveryView(
      input,
      input.pluginInstanceId,
      input.periodKey,
    );
    if (!reviewView) return this.deliverScopeStatus(input);
    return this.deliverAggregate(
      "scope",
      input,
      reviewView.aggregateId,
      reviewView.version,
      (deliveryId) => this.renderScopeDeliveryCard(reviewView, deliveryId),
    );
  }

  async deliverRecovery(
    input: FeishuDeliveryScope & {
      authorizationId: string;
      deviceName: string;
      expiresAt: string;
    },
  ) {
    return this.deliverAggregate(
      "recovery",
      input,
      input.authorizationId,
      1,
      (deliveryId) =>
        renderRecoveryCard({
          deliveryId,
          aggregateId: input.authorizationId,
          baseVersion: 1,
          deviceName: input.deviceName,
          expiresAt: input.expiresAt,
        }),
    );
  }

  async deliverReview(input: FeishuDeliveryScope & { reviewId: string }) {
    const view = await this.loadReviewDeliveryView(input, input.reviewId);
    if (!view)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      } satisfies FeishuDeliveryResult;
    return this.deliverAggregate(
      "review",
      input,
      input.reviewId,
      view.version,
      (deliveryId) => this.renderReviewDeliveryCard(view, deliveryId),
    );
  }

  async deliverReport(input: FeishuDeliveryScope & { reportId: string }) {
    const view = await this.loadReportDeliveryView(input, input.reportId);
    if (!view)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      } satisfies FeishuDeliveryResult;
    return this.deliverAggregate(
      "report",
      input,
      input.reportId,
      view.version,
      (deliveryId) => this.renderReportDeliveryCard(view, deliveryId),
    );
  }

  async patchReviewDelivery(input: FeishuDeliveryScope & { reviewId: string }) {
    return this.deliverReview(input);
  }

  async patchReportDelivery(input: FeishuDeliveryScope & { reportId: string }) {
    return this.deliverReport(input);
  }

  async patchReviewStatus(
    input: FeishuDeliveryScope & { reviewId: string; card: FeishuCard },
  ) {
    return this.patchAggregateStatus(
      "review",
      input,
      input.reviewId,
      input.card,
    );
  }

  async patchReportStatus(
    input: FeishuDeliveryScope & { reportId: string; card: FeishuCard },
  ) {
    return this.patchAggregateStatus(
      "report",
      input,
      input.reportId,
      input.card,
    );
  }

  async patchScopeStatus(
    input: FeishuDeliveryScope & {
      aggregateId: string;
      card: FeishuCard;
      targetDomainVersion?: number;
    },
  ) {
    return this.patchAggregateStatus(
      "scope",
      input,
      input.aggregateId,
      input.card,
      input.targetDomainVersion,
    );
  }

  async patchRecoveryStatus(
    input: FeishuDeliveryScope & {
      authorizationId: string;
      card: FeishuCard;
    },
  ) {
    return this.patchAggregateStatus(
      "recovery",
      input,
      input.authorizationId,
      input.card,
    );
  }

  async syncPartnerPendingApprovals(
    scope: FeishuDeliveryScope,
    requestedPeriodKey?: string,
  ) {
    const [reviews, reports, scopes] = await Promise.all([
      this.database<Array<{ id: string }>>`
        select r.id from reviews r
        join report_periods rp
          on rp.id = r.period_id and rp.tenant_id = r.tenant_id
          and rp.team_id = r.team_id
        where r.tenant_id = ${scope.tenantId} and r.team_id = ${scope.teamId}
          and r.partner_id = ${scope.partnerId} and r.state = 'IN_PROGRESS'
          and exists (
            select 1 from work_items wi
            where wi.review_id = r.id and wi.tenant_id = ${scope.tenantId}
              and wi.team_id = ${scope.teamId} and wi.partner_id = ${scope.partnerId}
              and wi.review_status = 'pending'
          )
        order by rp.starts_at desc, r.updated_at desc
        limit 1
      `,
      this.database<Array<{ id: string }>>`
        select r.id from individual_reports r
        join report_periods rp
          on rp.id = r.period_id and rp.tenant_id = r.tenant_id
          and rp.team_id = r.team_id
        where r.tenant_id = ${scope.tenantId} and r.team_id = ${scope.teamId}
          and r.partner_id = ${scope.partnerId}
          and (
            r.status = 'REPORT_REVIEW'
            or (
              r.status = 'REPORT_DRAFT' and r.content_revision > 0
              and exists (
                select 1 from agent_jobs aj
                where aj.tenant_id = ${scope.tenantId}
                  and aj.team_id = ${scope.teamId}
                  and aj.partner_id = ${scope.partnerId}
                  and aj.type = 'REGENERATE_INDIVIDUAL_REPORT'
                  and aj.status in ('PENDING', 'LEASED', 'RETRY_WAIT')
                  and aj.input_payload->>'reportId' = r.id::text
              )
            )
          )
        order by rp.starts_at desc, r.updated_at desc
        limit 1
      `,
      this.database<Array<{ plugin_instance_id: string; period_key: string }>>`
        select psp.plugin_instance_id, rp.period_key
        from project_scope_policies psp
        join plugin_instances pi on pi.id = psp.plugin_instance_id
        join lateral (
          select period_key from report_periods
          where tenant_id = psp.tenant_id and team_id = psp.team_id
            and (${requestedPeriodKey ?? null}::text is null or period_key = ${requestedPeriodKey ?? null})
          order by
            case when starts_at <= now() and ends_at >= now() then 0 else 1 end,
            starts_at desc
          limit 1
        ) rp on true
        where psp.tenant_id = ${scope.tenantId} and psp.team_id = ${scope.teamId}
          and psp.partner_id = ${scope.partnerId} and pi.status = 'active'
          and exists (
            select 1 from project_scope_entries pse
            where pse.plugin_instance_id = psp.plugin_instance_id
              and pse.status = 'pending'
          )
        order by psp.created_at asc
        limit 20
      `,
    ]);

    const results: FeishuDeliveryResult[] = [];
    if (reviews[0])
      results.push(
        await this.deliverReview({ ...scope, reviewId: reviews[0].id }),
      );
    if (reports[0])
      results.push(
        await this.deliverReport({ ...scope, reportId: reports[0].id }),
      );
    for (const pendingScope of scopes)
      results.push(
        await this.deliverScope({
          ...scope,
          pluginInstanceId: pendingScope.plugin_instance_id,
          periodKey: pendingScope.period_key,
        }),
      );
    return results;
  }

  async loadDeliveryForAction(
    rawInput: LoadDeliveryForActionInput,
  ): Promise<FeishuActionDelivery | null> {
    const input = {
      deliveryId: identifierSchema.parse(rawInput.deliveryId),
      messageId: identifierSchema.parse(rawInput.messageId),
      appId: identifierSchema.parse(rawInput.appId),
      expectedKind: deliveryKindSchema.parse(rawInput.expectedKind),
      aggregateId: identifierSchema.parse(rawInput.aggregateId),
      ...(rawInput.operatorOpenId
        ? { operatorOpenId: identifierSchema.parse(rawInput.operatorOpenId) }
        : {}),
    };
    const expectedAggregateType =
      input.expectedKind === "binding"
        ? "partner"
        : aggregateType(input.expectedKind);
    const rows = await this.database<
      Array<{
        delivery_id: string;
        tenant_id: string;
        team_id: string;
        partner_id: string;
        kind: FeishuDeliveryKind;
        aggregate_type:
          | "partner"
          | "device_authorization"
          | "project_scope"
          | "review"
          | "individual_report";
        aggregate_id: string;
        message_id: string;
        receive_id: string;
        receive_id_type: "email" | "open_id";
        domain_version: number | null;
        user_id: string | null;
        email: string;
        binding_id: string;
        binding_status: string;
        binding_open_id: string | null;
      }>
    >`
      select d.id as delivery_id, d.tenant_id, d.team_id, d.partner_id,
        d.kind, d.aggregate_type, d.aggregate_id, d.message_id,
        d.receive_id, d.receive_id_type, d.domain_version,
        p.user_id, p.email, b.id as binding_id, b.status as binding_status,
        b.open_id as binding_open_id
      from feishu_deliveries d
      join partners p
        on p.id = d.partner_id and p.tenant_id = d.tenant_id
        and p.team_id = d.team_id and p.status = 'active'
      join feishu_partner_bindings b
        on b.partner_id = d.partner_id and b.tenant_id = d.tenant_id
        and b.team_id = d.team_id and b.app_id = ${input.appId}
      where d.id = ${input.deliveryId} and d.message_id = ${input.messageId}
        and d.kind = ${input.expectedKind}
        and d.aggregate_type = ${expectedAggregateType}
        and d.aggregate_id = ${input.aggregateId}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;

    if (input.expectedKind === "binding") {
      if (
        row.aggregate_id !== row.partner_id ||
        row.receive_id_type !== "email" ||
        row.receive_id.toLowerCase() !== row.email.toLowerCase() ||
        !["pending", "active"].includes(row.binding_status) ||
        (row.binding_status === "active" &&
          input.operatorOpenId &&
          row.binding_open_id !== input.operatorOpenId)
      )
        return null;
    } else if (input.expectedKind === "scope") {
      if (!input.operatorOpenId) return null;
      if (row.binding_status === "active") {
        if (
          !row.binding_open_id ||
          row.binding_open_id !== input.operatorOpenId ||
          row.receive_id_type !== "open_id" ||
          row.receive_id !== row.binding_open_id
        )
          return null;
      } else if (
        row.binding_status !== "pending" ||
        row.receive_id_type !== "email" ||
        row.receive_id.toLowerCase() !== row.email.toLowerCase()
      ) {
        return null;
      }
    } else {
      if (
        !input.operatorOpenId ||
        row.binding_status !== "active" ||
        !row.binding_open_id ||
        row.binding_open_id !== input.operatorOpenId ||
        row.receive_id_type !== "open_id" ||
        row.receive_id !== row.binding_open_id
      )
        return null;
    }

    return {
      tenantId: row.tenant_id,
      teamId: row.team_id,
      partnerId: row.partner_id,
      deliveryId: row.delivery_id,
      kind: row.kind,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      messageId: row.message_id,
      receiveId: row.receive_id,
      receiveIdType: row.receive_id_type,
      domainVersion: row.domain_version,
      partnerUserId: row.user_id,
      partnerEmail: row.email,
      bindingId: row.binding_id,
      bindingStatus: row.binding_status,
      bindingOpenId: row.binding_open_id,
    };
  }

  private async loadScopedPartner(
    scope: FeishuDeliveryScope,
  ): Promise<PartnerRow | null> {
    const partners = await this.database<PartnerRow[]>`
      select id, tenant_id, team_id, user_id, email, display_name
      from partners
      where id = ${scope.partnerId} and tenant_id = ${scope.tenantId}
        and team_id = ${scope.teamId} and status = 'active'
      limit 1
    `;
    return partners[0] ?? null;
  }

  private async ensurePendingBindingForPartner(
    partner: PartnerRow,
  ): Promise<BindingRow> {
    const rows = await this.database<BindingRow[]>`
      insert into feishu_partner_bindings (
        id, tenant_id, team_id, partner_id, app_id, status
      ) values (
        ${randomUUID()}, ${partner.tenant_id}, ${partner.team_id},
        ${partner.id}, ${this.appId}, 'pending'
      )
      on conflict (tenant_id, partner_id, app_id) do update set
        status = case
          when feishu_partner_bindings.status = 'active'
            and feishu_partner_bindings.open_id is not null
            then 'active'
          else 'pending'
        end,
        open_id = case
          when feishu_partner_bindings.status = 'active'
            then feishu_partner_bindings.open_id
          else null
        end,
        union_id = case
          when feishu_partner_bindings.status = 'active'
            then feishu_partner_bindings.union_id
          else null
        end,
        tenant_key = case
          when feishu_partner_bindings.status = 'active'
            then feishu_partner_bindings.tenant_key
          else null
        end,
        updated_at = now()
      returning id, status, open_id
    `;
    return rows[0]!;
  }

  private async deliverAggregate(
    kind: "recovery" | "scope" | "review" | "report",
    scope: FeishuDeliveryScope,
    aggregateId: string,
    domainVersion: number,
    render: (deliveryId: string) => FeishuCard,
  ): Promise<FeishuDeliveryResult> {
    const partner = await this.loadScopedPartner(scope);
    if (!partner)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      };
    const bindings = await this.database<BindingRow[]>`
      select id, status, open_id from feishu_partner_bindings
      where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
        and partner_id = ${scope.partnerId} and app_id = ${this.appId}
        and status = 'active' and open_id is not null
      limit 1
    `;
    const binding = bindings[0];
    if (!binding?.open_id) {
      if (kind === "scope") {
        await this.ensurePendingBindingForPartner(partner);
        // The first project card is a Feishu card addressed by the Partner's
        // Feishu account email; its callback supplies the trusted open_id.
        const delivery = await this.upsertAggregateDelivery({
          kind,
          scope,
          aggregateId,
          domainVersion,
          receiveId: partner.email,
          receiveIdType: "email",
          deferred: false,
        });
        const claimed = await this.claimDelivery(
          delivery.id,
          partner,
          Boolean(delivery.message_id),
          domainVersion,
        );
        if (!claimed)
          return this.unclaimedResult(delivery.id, scope, domainVersion);
        const card = render(claimed.id);
        return claimed.message_id
          ? this.patchClaimedDelivery(claimed, card, domainVersion)
          : this.sendClaimedDelivery(claimed, card, domainVersion);
      }
      const deferred = await this.upsertAggregateDelivery({
        kind,
        scope,
        aggregateId,
        domainVersion,
        receiveId: partner.email,
        receiveIdType: "email",
        deferred: true,
      });
      return {
        outcome: "deferred",
        deliveryId: deferred.id,
        reason: "binding_required",
      };
    }

    const delivery = await this.upsertAggregateDelivery({
      kind,
      scope,
      aggregateId,
      domainVersion,
      receiveId: binding.open_id,
      receiveIdType: "open_id",
      deferred: false,
    });
    const claimed = await this.claimDelivery(
      delivery.id,
      partner,
      Boolean(delivery.message_id),
      domainVersion,
    );
    if (!claimed)
      return this.unclaimedResult(delivery.id, scope, domainVersion);
    const card = render(claimed.id);
    return claimed.message_id
      ? this.patchClaimedDelivery(claimed, card, domainVersion)
      : this.sendClaimedDelivery(claimed, card, domainVersion);
  }

  private async patchAggregateStatus(
    kind: "recovery" | "scope" | "review" | "report",
    scope: FeishuDeliveryScope,
    aggregateId: string,
    card: FeishuCard,
    domainVersion?: number,
  ): Promise<FeishuDeliveryResult> {
    const partners = await this.database<PartnerRow[]>`
      select p.id, p.tenant_id, p.team_id, p.user_id, p.email, p.display_name
      from partners p
      where p.id = ${scope.partnerId} and p.tenant_id = ${scope.tenantId}
        and p.team_id = ${scope.teamId} and p.status = 'active'
      limit 1
    `;
    const partner = partners[0];
    if (!partner)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      };
    const deliveries = await this.database<DeliveryRow[]>`
      select d.* from feishu_deliveries d
      join feishu_partner_bindings b
        on b.tenant_id = d.tenant_id and b.team_id = d.team_id
        and b.partner_id = d.partner_id and b.app_id = ${this.appId}
        and b.status = 'active' and b.open_id = d.receive_id
      where d.tenant_id = ${scope.tenantId} and d.team_id = ${scope.teamId}
        and d.partner_id = ${scope.partnerId} and d.kind = ${kind}
        and d.aggregate_type = ${aggregateType(kind)}
        and d.aggregate_id = ${aggregateId} and d.receive_id_type = 'open_id'
        and d.message_id is not null
      order by d.updated_at desc
      limit 1
    `;
    const delivery = deliveries[0];
    if (!delivery)
      return {
        outcome: "skipped",
        deliveryId: null,
        reason: "not_reviewable",
      };
    const claimed = await this.claimDelivery(delivery.id, partner, true);
    if (!claimed) return this.unclaimedResult(delivery.id, scope);
    return this.patchClaimedDelivery(
      claimed,
      card,
      domainVersion ?? claimed.domain_version ?? 1,
    );
  }

  private async upsertAggregateDelivery(input: {
    kind: "recovery" | "scope" | "review" | "report";
    scope: FeishuDeliveryScope;
    aggregateId: string;
    domainVersion: number;
    receiveId: string;
    receiveIdType: "email" | "open_id";
    deferred: boolean;
  }): Promise<DeliveryRow> {
    const deliveryId = randomUUID();
    const rows = await this.database<DeliveryRow[]>`
      insert into feishu_deliveries (
        id, tenant_id, team_id, partner_id, kind, aggregate_type,
        aggregate_id, receive_id, receive_id_type, domain_version,
        status, idempotency_key
      ) values (
        ${deliveryId}, ${input.scope.tenantId}, ${input.scope.teamId},
        ${input.scope.partnerId}, ${input.kind}, ${aggregateType(input.kind)},
        ${input.aggregateId}, ${input.receiveId}, ${input.receiveIdType},
        null, ${input.deferred ? "deferred" : "pending"},
        ${idempotencyKey(
          this.appId,
          input.kind,
          input.scope.partnerId,
          input.aggregateId,
        )}
      )
      on conflict (tenant_id, idempotency_key) do update set
        receive_id = excluded.receive_id,
        receive_id_type = excluded.receive_id_type,
        message_id = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.message_id
          else null
        end,
        domain_version = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.domain_version
          else null
        end,
        status = case
          when feishu_deliveries.receive_id <> excluded.receive_id
            or feishu_deliveries.receive_id_type <> excluded.receive_id_type
            then excluded.status
          when excluded.status = 'deferred' then 'deferred'
          else feishu_deliveries.status
        end,
        attempt_count = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.attempt_count
          else feishu_deliveries.attempt_count + 1
        end,
        sent_at = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.sent_at
          else null
        end,
        next_retry_at = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.next_retry_at
          else null
        end,
        last_attempt_at = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.last_attempt_at
          else null
        end,
        last_error_code = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.last_error_code
          else null
        end,
        last_error_message = case
          when feishu_deliveries.receive_id = excluded.receive_id
            and feishu_deliveries.receive_id_type = excluded.receive_id_type
            then feishu_deliveries.last_error_message
          else null
        end,
        updated_at = now()
      returning *
    `;
    return rows[0]!;
  }

  private async claimDelivery(
    deliveryId: string,
    partner: PartnerRow,
    requiresMessage: boolean,
    targetDomainVersion?: number,
  ): Promise<DeliveryRow | null> {
    const rows = await this.database<DeliveryRow[]>`
      update feishu_deliveries set
        status = 'sending', attempt_count = attempt_count + 1,
        last_attempt_at = now(), updated_at = now()
      where id = ${deliveryId} and tenant_id = ${partner.tenant_id}
        and team_id = ${partner.team_id} and partner_id = ${partner.id}
        and (${requiresMessage} = (message_id is not null))
        and (
          ${targetDomainVersion ?? null}::integer is null
          or message_id is null
          or domain_version is null
          or domain_version < ${targetDomainVersion ?? null}::integer
        )
        and (
          status in ('pending', 'sent', 'failed')
          or (status = 'deferred' and receive_id_type = 'open_id')
          or (status = 'retry_wait' and next_retry_at <= now())
          or (status = 'sending' and last_attempt_at < now() - interval '2 minutes')
        )
      returning *
    `;
    return rows[0] ?? null;
  }

  private async unclaimedResult(
    deliveryId: string,
    scope: FeishuDeliveryScope,
    targetDomainVersion?: number,
  ): Promise<FeishuDeliveryResult> {
    const rows = await this.database<DeliveryRow[]>`
      select * from feishu_deliveries
      where id = ${deliveryId} and tenant_id = ${scope.tenantId}
        and team_id = ${scope.teamId} and partner_id = ${scope.partnerId}
      limit 1
    `;
    const delivery = rows[0];
    if (!delivery)
      return {
        outcome: "deferred",
        deliveryId,
        reason: "delivery_in_progress",
      };
    if (
      targetDomainVersion !== undefined &&
      delivery.message_id &&
      delivery.domain_version !== null &&
      delivery.domain_version >= targetDomainVersion
    )
      return {
        outcome: "skipped",
        deliveryId,
        messageId: delivery.message_id,
        domainVersion: delivery.domain_version,
        reason: "already_current",
      };
    if (delivery.status === "retry_wait")
      return {
        outcome: "deferred",
        deliveryId,
        ...(delivery.message_id ? { messageId: delivery.message_id } : {}),
        ...(delivery.next_retry_at
          ? { nextRetryAt: delivery.next_retry_at }
          : {}),
        reason: "retry_not_due",
      };
    if (
      targetDomainVersion === undefined &&
      delivery.message_id &&
      delivery.status === "sent"
    )
      return {
        outcome: "skipped",
        deliveryId,
        messageId: delivery.message_id,
        ...(delivery.domain_version !== null
          ? { domainVersion: delivery.domain_version }
          : {}),
        reason: "already_current",
      };
    return {
      outcome: "deferred",
      deliveryId,
      reason: "delivery_in_progress",
    };
  }

  private async sendClaimedDelivery(
    delivery: DeliveryRow,
    card: FeishuCard,
    domainVersion = delivery.domain_version,
  ): Promise<FeishuDeliveryResult> {
    try {
      const sent = await this.messageClient.sendInteractiveCard({
        receiveIdType:
          delivery.receive_id_type === "open_id" ? "open_id" : "email",
        receiveId: delivery.receive_id,
        card,
        idempotencyKey: messageIdempotencyKey(delivery),
      });
      const rows = await this.database<
        Array<{ domain_version: number | null }>
      >`
        update feishu_deliveries set
          message_id = ${sent.messageId},
          domain_version = case
            when ${domainVersion}::integer is null then domain_version
            else greatest(
              coalesce(domain_version, ${domainVersion}::integer),
              ${domainVersion}::integer
            )
          end,
          status = 'sent', sent_at = coalesce(sent_at, now()),
          next_retry_at = null, last_error_code = null,
          last_error_message = null, updated_at = now()
        where id = ${delivery.id} and tenant_id = ${delivery.tenant_id}
          and team_id = ${delivery.team_id} and partner_id = ${delivery.partner_id}
          and status = 'sending' and attempt_count = ${delivery.attempt_count}
          and receive_id = ${delivery.receive_id}
          and receive_id_type = ${delivery.receive_id_type}
        returning domain_version
      `;
      const persisted = rows[0];
      if (!persisted)
        return this.unclaimedResult(
          delivery.id,
          {
            tenantId: delivery.tenant_id,
            teamId: delivery.team_id,
            partnerId: delivery.partner_id,
          },
          domainVersion ?? undefined,
        );
      return {
        outcome: "sent",
        deliveryId: delivery.id,
        messageId: sent.messageId,
        ...(persisted.domain_version !== null
          ? { domainVersion: persisted.domain_version }
          : {}),
      };
    } catch (error) {
      return this.recordFailure(delivery, error, domainVersion ?? undefined);
    }
  }

  private async patchClaimedDelivery(
    delivery: DeliveryRow,
    card: FeishuCard,
    domainVersion: number,
  ): Promise<FeishuDeliveryResult> {
    try {
      await this.messageClient.updateInteractiveCard({
        messageId: delivery.message_id!,
        card,
      });
      const rows = await this.database<
        Array<{ domain_version: number | null }>
      >`
        update feishu_deliveries set
          domain_version = greatest(
            coalesce(domain_version, ${domainVersion}),
            ${domainVersion}
          ), status = 'sent',
          next_retry_at = null, last_error_code = null,
          last_error_message = null, updated_at = now()
        where id = ${delivery.id} and tenant_id = ${delivery.tenant_id}
          and team_id = ${delivery.team_id} and partner_id = ${delivery.partner_id}
          and status = 'sending' and attempt_count = ${delivery.attempt_count}
          and receive_id = ${delivery.receive_id}
          and receive_id_type = ${delivery.receive_id_type}
        returning domain_version
      `;
      const persisted = rows[0];
      if (!persisted)
        return this.unclaimedResult(
          delivery.id,
          {
            tenantId: delivery.tenant_id,
            teamId: delivery.team_id,
            partnerId: delivery.partner_id,
          },
          domainVersion,
        );
      return {
        outcome: "updated",
        deliveryId: delivery.id,
        messageId: delivery.message_id!,
        domainVersion: persisted.domain_version ?? domainVersion,
      };
    } catch (error) {
      return this.recordFailure(delivery, error, domainVersion);
    }
  }

  private async recordFailure(
    delivery: DeliveryRow,
    error: unknown,
    targetDomainVersion?: number,
  ): Promise<FeishuDeliveryResult> {
    const failure = safeFailure(error);
    const nextRetryAt = new Date(
      Date.now() + retryDelaySeconds(delivery.attempt_count) * 1_000,
    );
    const rows = await this.database<Array<{ id: string }>>`
      update feishu_deliveries set
        status = 'retry_wait', next_retry_at = ${nextRetryAt.toISOString()},
        last_error_code = ${failure.code}, last_error_message = ${failure.message},
        updated_at = now()
      where id = ${delivery.id} and tenant_id = ${delivery.tenant_id}
        and team_id = ${delivery.team_id} and partner_id = ${delivery.partner_id}
        and status = 'sending' and attempt_count = ${delivery.attempt_count}
        and receive_id = ${delivery.receive_id}
        and receive_id_type = ${delivery.receive_id_type}
      returning id
    `;
    if (!rows[0])
      return this.unclaimedResult(
        delivery.id,
        {
          tenantId: delivery.tenant_id,
          teamId: delivery.team_id,
          partnerId: delivery.partner_id,
        },
        targetDomainVersion,
      );
    return {
      outcome: "deferred",
      deliveryId: delivery.id,
      ...(delivery.message_id ? { messageId: delivery.message_id } : {}),
      nextRetryAt,
      reason: "delivery_failed",
    };
  }
}

export function createFeishuDeliveryService(
  config: FeishuConfig = requireFeishuConfig(),
) {
  return new FeishuDeliveryService({
    appId: config.appId,
    messageClient: createFeishuMessageClient(config),
    ...(process.env.WEB_ORIGIN ? { webOrigin: process.env.WEB_ORIGIN } : {}),
  });
}

export async function loadDeliveryForAction(
  input: LoadDeliveryForActionInput,
  service: FeishuDeliveryService = createFeishuDeliveryService(),
) {
  return service.loadDeliveryForAction(input);
}

export async function deliverReview(
  input: FeishuDeliveryScope & { reviewId: string },
  service: FeishuDeliveryService = createFeishuDeliveryService(),
) {
  return service.deliverReview(input);
}

export async function deliverReport(
  input: FeishuDeliveryScope & { reportId: string },
  service: FeishuDeliveryService = createFeishuDeliveryService(),
) {
  return service.deliverReport(input);
}

export async function patchReviewStatus(
  input: FeishuDeliveryScope & { reviewId: string; card: FeishuCard },
  service: FeishuDeliveryService = createFeishuDeliveryService(),
) {
  return service.patchReviewStatus(input);
}

export async function patchReportStatus(
  input: FeishuDeliveryScope & { reportId: string; card: FeishuCard },
  service: FeishuDeliveryService = createFeishuDeliveryService(),
) {
  return service.patchReportStatus(input);
}

export async function syncPartnerPendingApprovals(
  scope: FeishuDeliveryScope,
  service: FeishuDeliveryService = createFeishuDeliveryService(),
) {
  return service.syncPartnerPendingApprovals(scope);
}
