import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import semver from "semver";
import { z } from "zod";
import { centralModelIdSchema } from "@partner-report/contracts/models";
import { sqlClient as sql, weeklyPeriodAt } from "@partner-report/db";
import {
  ApiError,
  audit,
  randomToken,
  requireWebActor,
  sha256,
  userCode,
} from "../common.js";
import { reopenProjectScopeReview } from "../project-scope.js";

const inviteSchema = z.object({
  email: z.string().email(),
  roles: z.array(z.enum(["admin", "partner"])).min(1),
});

const projectSchema = z.object({
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).default([]),
  allowedPaths: z.array(z.string().max(1000)).default([]),
  externalIds: z.array(z.string().max(200)).default([]),
});

const teamUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  evidenceExcerptEnabled: z.boolean().optional(),
  sessionQuietPeriodMinutes: z
    .number()
    .int()
    .min(15)
    .max(24 * 60)
    .optional(),
  minimumPluginVersion: z.string().min(1).max(40).optional(),
  centralModel: centralModelIdSchema.optional(),
  periodRule: z
    .object({
      frequency: z.literal("weekly").default("weekly"),
      weekStartsOn: z.number().int().min(1).max(7).default(1),
      factCutoffWeekday: z.number().int().min(1).max(7),
      factCutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .optional(),
});

const partnerUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  preferences: z.record(z.unknown()).optional(),
});

const partnerCreateSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
});

const bindingCodeSchema = z.object({
  label: z.string().min(1).max(120).default("Codex Plugin"),
  pluginInstanceId: z.string().uuid().optional(),
});

const templateSchema = z.object({
  name: z.string().min(1).max(120),
  sections: z.array(z.string().min(1).max(100)).length(7),
  isDefault: z.boolean().default(false),
});

const periodSchema = z
  .object({
    periodKey: z.string().min(1).max(80),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    cutoffAt: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    templateId: z.string().uuid().optional(),
    status: z
      .enum(["open", "closing", "facts_frozen", "closed", "completed"])
      .default("open"),
  })
  .superRefine((value, context) => {
    if (new Date(value.startsAt) >= new Date(value.endsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "endsAt 必须晚于 startsAt",
      });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.timezone });
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: "无效 IANA 时区",
      });
    }
  });

export function pluginConnectivityStatus(row: {
  status: string;
  connectivityStatus: string | null;
  connectivityChallengeExpiresAt: Date | string | null;
}) {
  if (row.status !== "active") return "expired";
  if (row.connectivityStatus === "verified") return "verified";
  if (row.connectivityStatus === "failed") return "failed";
  const challengeExpiresAt = row.connectivityChallengeExpiresAt
    ? new Date(row.connectivityChallengeExpiresAt).getTime()
    : 0;
  if (challengeExpiresAt && challengeExpiresAt <= Date.now()) return "expired";
  return "pending";
}

export function feishuConnectionStatus(row: {
  configured: boolean;
  hasPlugin: boolean;
  bindingStatus: string | null;
  openId: string | null;
  deliveryStatus: string | null;
  lastSuccessfulAt: Date | string | null;
  lastAttemptAt: Date | string | null;
}) {
  if (!row.configured) return "unavailable";
  const lastSuccessfulAt = row.lastSuccessfulAt
    ? new Date(row.lastSuccessfulAt).getTime()
    : 0;
  const lastAttemptAt = row.lastAttemptAt
    ? new Date(row.lastAttemptAt).getTime()
    : 0;
  if (
    ["failed", "retry_wait"].includes(row.deliveryStatus ?? "") &&
    lastAttemptAt > lastSuccessfulAt
  )
    return "failed";
  if ((row.bindingStatus === "active" && row.openId) || lastSuccessfulAt > 0)
    return "connected";
  if (row.bindingStatus === "pending")
    return ["pending", "sending"].includes(row.deliveryStatus ?? "")
      ? "connecting"
      : "not_connected";
  return row.hasPlugin ? "not_connected" : "not_started";
}

export function nextManualRetryMaxAttempts(
  attemptCount: number,
  maxAttempts: number,
) {
  return Math.max(maxAttempts, attemptCount + 3);
}

export function pluginRunStatus(row: {
  status: string;
  version: string;
  minimumPluginVersion: string;
  lastCollectionCompletedAt: Date | string | null;
  retryCount: number;
  lastErrorCode: string | null;
  runnerState?: string | null;
  pendingLocalJobs?: number;
}) {
  if (row.status !== "active") return "blocked";
  if (
    !semver.valid(row.version) ||
    !semver.gte(row.version, row.minimumPluginVersion)
  )
    return "blocked";
  const completedAt = row.lastCollectionCompletedAt
    ? new Date(row.lastCollectionCompletedAt).getTime()
    : 0;
  if (!completedAt) {
    if (row.runnerState === "error" || row.retryCount > 0 || row.lastErrorCode)
      return "abnormal";
    return "waiting_first_run";
  }
  const ageDays = (Date.now() - completedAt) / 86_400_000;
  if (ageDays > 8) return "offline";
  if (
    ageDays > 7 ||
    ["error", "delayed", "working"].includes(row.runnerState ?? "") ||
    (row.pendingLocalJobs ?? 0) > 0 ||
    row.retryCount > 0 ||
    row.lastErrorCode
  )
    return "abnormal";
  return "healthy";
}

export type PartnerReviewStage =
  "not_started" | "reviewing_cards" | "completed";

export function partnerReviewProgress(row: {
  reviewId: string | null;
  periodKey: string | null;
  reviewState: string | null;
  pendingCount: number | null;
  approvedCount: number | null;
  excludedCount: number | null;
}) {
  const pending = Math.max(0, row.pendingCount ?? 0);
  const approved = Math.max(0, row.approvedCount ?? 0);
  const excluded = Math.max(0, row.excludedCount ?? 0);
  const reviewed = approved + excluded;
  const total = pending + reviewed;
  let stage: PartnerReviewStage = "not_started";
  if (row.reviewId) {
    stage = ["ITEMS_APPROVED", "ITEMS_DISMISSED"].includes(
      row.reviewState ?? "",
    )
      ? "completed"
      : "reviewing_cards";
  }
  return {
    periodKey: row.periodKey,
    stage,
    reviewed,
    total,
    pending,
    approved,
    excluded,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  app.get("/v1/admin/overview", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const feishuAppId = process.env.FEISHU_APP_ID?.trim() ?? "";
    const [
      teamRows,
      partnerRows,
      periodRows,
      projectRows,
      pluginRows,
      jobRows,
      bindingRows,
      feishuBindingRows,
      queueRows,
    ] = await Promise.all([
      sql<
        any[]
      >`select * from teams where id = ${actor.teamId} and tenant_id = ${actor.tenantId}`,
      sql<any[]>`
        select p.id, p.display_name, p.email, p.status,
          p.preferences, p.user_id, p.created_at,
          latest_review.review_id, latest_review.period_key as review_period_key,
          latest_review.review_state, latest_review.pending_count,
          latest_review.approved_count, latest_review.excluded_count
        from partners p
        left join lateral (
          select r.id as review_id, r.state as review_state,
            r.pending_count, r.approved_count, r.excluded_count,
            rp.period_key
          from reviews r
          join report_periods rp on rp.id = r.period_id
            and rp.tenant_id = r.tenant_id and rp.team_id = r.team_id
          where r.tenant_id = p.tenant_id and r.team_id = p.team_id
            and r.partner_id = p.id
          order by rp.starts_at desc, r.created_at desc
          limit 1
        ) latest_review on true
        where p.team_id = ${actor.teamId} and p.tenant_id = ${actor.tenantId}
          and p.status = 'active'
        order by p.display_name
      `,
      sql<any[]>`
        select * from report_periods
        where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId}
        order by starts_at desc limit 8
      `,
      sql<any[]>`
        select id, name
        from projects
        where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId}
          and status = 'active'
        order by name
      `,
      sql<any[]>`
        select
          pi.id, pi.tenant_id, pi.team_id, pi.partner_id, pi.device_name, pi.version,
          pi.status,
          pi.access_expires_at, pi.last_heartbeat_at, pi.last_hook_at, pi.last_runner_at,
          pi.last_scan_at, pi.last_sync_at, pi.next_due_at, pi.runner_state, pi.dirty_sessions,
          pi.extracting_sessions, pi.pending_local_jobs, pi.retry_count, pi.last_error_code,
          pi.last_collection_started_at, pi.last_collection_completed_at,
          pi.last_collection_period_key, pi.last_collection_session_count, pi.last_collection_fact_count,
          pi.connectivity_status, pi.connectivity_verified_at, pi.last_connectivity_attempt_at,
          pi.last_connectivity_error_code, pi.last_connectivity_error_at,
          pi.last_connectivity_request_id, pi.connectivity_challenge_expires_at,
          pi.created_at, pi.updated_at,
          p.display_name as partner_name, t.minimum_plugin_version, coverage.payload as coverage,
          coalesce(pending_jobs.count, 0)::int as pending_agent_jobs,
          diagnostic.stage as last_diagnostic_stage,
          diagnostic.error_code as last_diagnostic_error_code,
          diagnostic.occurred_at as last_diagnostic_at,
          diagnostic.retryable as last_diagnostic_retryable,
          diagnostic.request_id as last_diagnostic_request_id,
          diagnostic.safe_message as last_diagnostic_message,
          current_run.id as current_run_id,
          current_run.status as current_run_status,
          current_run.discovered_count as current_run_discovered_count,
          current_run.eligible_count as current_run_eligible_count,
          current_run.deferred_count as current_run_deferred_count,
          current_run.excluded_count as current_run_excluded_count,
          current_run.synced_session_count as current_run_synced_session_count,
          current_run.synced_fact_count as current_run_synced_fact_count,
          current_run.pending_local_jobs as current_run_pending_local_jobs,
          current_run.continuation_count as current_run_continuation_count
        from plugin_instances pi
        join partners p on p.id = pi.partner_id and p.tenant_id = pi.tenant_id
        join teams t on t.id = pi.team_id and t.tenant_id = pi.tenant_id
        left join lateral (
          select cs.payload from coverage_snapshots cs
          where cs.tenant_id = pi.tenant_id and cs.partner_id = pi.partner_id
          order by cs.created_at desc limit 1
        ) coverage on true
        left join lateral (
          select count(*)::int as count from agent_jobs aj
          where aj.tenant_id = pi.tenant_id and aj.plugin_instance_id = pi.id
            and aj.status in ('PENDING', 'LEASED', 'RETRY_WAIT')
        ) pending_jobs on true
        left join lateral (
          select pde.stage, pde.error_code, pde.occurred_at, pde.retryable,
            pde.request_id, pde.safe_message
          from plugin_diagnostic_events pde
          where pde.tenant_id = pi.tenant_id and pde.plugin_instance_id = pi.id
          order by pde.occurred_at desc limit 1
        ) diagnostic on true
        left join lateral (
          select cr.* from collection_runs cr
          where cr.tenant_id = pi.tenant_id and cr.plugin_instance_id = pi.id
          order by cr.created_at desc limit 1
        ) current_run on true
        where pi.team_id = ${actor.teamId} and pi.tenant_id = ${actor.tenantId}
        order by pi.created_at desc
      `,
      sql<any[]>`
        select status, type, count(*)::int as count from agent_jobs
        where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId}
        group by status, type
      `,
      sql<any[]>`
        select id, partner_id, code_value, code_prefix, label, status, plugin_instance_id,
          claimed_at, last_used_at, created_at
        from plugin_binding_codes
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        order by created_at desc
      `,
      sql<any[]>`
        select b.partner_id, b.status as binding_status, b.open_id, b.verified_at,
          delivery.status as delivery_status,
          delivery.last_attempt_at, delivery.last_error_code,
          delivery.last_successful_at
        from feishu_partner_bindings b
        left join lateral (
          select latest.status, latest.last_attempt_at, latest.last_error_code,
            successful.last_successful_at
          from lateral (
            select d.status, d.last_attempt_at, d.last_error_code
            from feishu_deliveries d
            where d.tenant_id = b.tenant_id and d.team_id = b.team_id
              and d.partner_id = b.partner_id and d.last_attempt_at is not null
            order by d.last_attempt_at desc
            limit 1
          ) latest
          cross join lateral (
            select max(d.sent_at) as last_successful_at
            from feishu_deliveries d
            where d.tenant_id = b.tenant_id and d.team_id = b.team_id
              and d.partner_id = b.partner_id and d.sent_at is not null
          ) successful
        ) delivery on true
        where b.tenant_id = ${actor.tenantId} and b.team_id = ${actor.teamId}
          and b.app_id = ${feishuAppId}
        order by b.created_at desc
      `,
      sql<any[]>`
        select r.id as review_id, r.state as review_state, r.version as review_version,
          r.pending_count, r.approved_count, r.excluded_count, r.updated_at,
          p.id as partner_id, p.display_name as partner_name, p.email as partner_email,
          rp.period_key
        from reviews r
        join partners p on p.id = r.partner_id and p.tenant_id = r.tenant_id
        join report_periods rp on rp.id = r.period_id and rp.tenant_id = r.tenant_id
        where r.tenant_id = ${actor.tenantId} and r.team_id = ${actor.teamId}
          and r.state in ('PENDING', 'IN_PROGRESS')
        order by r.updated_at desc limit 100
      `,
    ]);

    const plugins = pluginRows.map((row) => ({
      ...row,
      connectivityStatus: pluginConnectivityStatus({
        status: row.status,
        connectivityStatus: row.connectivity_status,
        connectivityChallengeExpiresAt: row.connectivity_challenge_expires_at,
      }),
      runStatus: pluginRunStatus({
        status: row.status,
        version: row.version,
        minimumPluginVersion: row.minimum_plugin_version,
        lastCollectionCompletedAt: row.last_collection_completed_at,
        retryCount: row.retry_count,
        lastErrorCode: row.last_error_code,
        runnerState: row.runner_state,
        pendingLocalJobs: row.pending_local_jobs,
      }),
    }));
    const activePlugins = plugins.filter(
      (plugin) => plugin.status === "active",
    );
    const connections = partnerRows.map((partner) => {
      const plugin =
        plugins.find(
          (candidate) =>
            candidate.partner_id === partner.id &&
            candidate.status === "active",
        ) ?? plugins.find((candidate) => candidate.partner_id === partner.id);
      const connectionState = !plugin
        ? "not_connected"
        : plugin.status !== "active"
          ? "expired"
          : plugin.connectivityStatus !== "verified"
            ? plugin.connectivityStatus
            : plugin.last_sync_at
              ? "active"
              : "connected";
      const feishuBinding = feishuBindingRows.find(
        (candidate) => candidate.partner_id === partner.id,
      );
      return {
        partnerId: partner.id,
        partnerName: partner.display_name,
        partnerEmail: partner.email,
        connectionState,
        feishuConnectionState: feishuConnectionStatus({
          configured: Boolean(feishuAppId),
          hasPlugin: Boolean(plugin),
          bindingStatus: feishuBinding?.binding_status ?? null,
          openId: feishuBinding?.open_id ?? null,
          deliveryStatus: feishuBinding?.delivery_status ?? null,
          lastSuccessfulAt: feishuBinding?.last_successful_at ?? null,
          lastAttemptAt: feishuBinding?.last_attempt_at ?? null,
        }),
        feishuConnectedAt:
          feishuBinding?.verified_at ??
          feishuBinding?.last_successful_at ??
          null,
        feishuLastAttemptAt: feishuBinding?.last_attempt_at ?? null,
        feishuLastErrorCode: feishuBinding?.last_error_code ?? null,
        verifiedAt: plugin?.connectivity_verified_at ?? null,
        lastUploadAt: plugin?.last_sync_at ?? null,
        deviceName: plugin?.device_name ?? null,
        pluginInstanceId: plugin?.id ?? null,
        version: plugin?.version ?? null,
        reviewProgress: partnerReviewProgress({
          reviewId: partner.review_id ?? null,
          periodKey: partner.review_period_key ?? null,
          reviewState: partner.review_state ?? null,
          pendingCount: partner.pending_count ?? null,
          approvedCount: partner.approved_count ?? null,
          excludedCount: partner.excluded_count ?? null,
        }),
      };
    });
    const partners = partnerRows.map((partner) => ({
      id: partner.id,
      display_name: partner.display_name,
      email: partner.email,
      status: partner.status,
      preferences: partner.preferences,
      user_id: partner.user_id,
      created_at: partner.created_at,
    }));

    return {
      team: teamRows[0],
      partners,
      periods: periodRows,
      projects: projectRows,
      plugins: activePlugins,
      connections,
      jobs: jobRows,
      bindingCodes: bindingRows,
      reviewQueue: queueRows,
    };
  });

  app.get("/v1/admin/partners/:id/project-scopes", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const partners = await sql<
      Array<{ id: string; display_name: string; email: string }>
    >`
      select id, display_name, email from partners
      where id = ${id} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId} and status = 'active'
      limit 1
    `;
    const partner = partners[0];
    if (!partner) throw new ApiError(404, "NOT_FOUND", "Partner 不存在。");

    const [instanceRows, entryRows] = await Promise.all([
      sql<
        Array<{
          id: string;
          device_name: string;
          version: string;
          policy_version: number | null;
          initialized: boolean | null;
          initialized_at: Date | null;
        }>
      >`
        select pi.id, pi.device_name, pi.version,
          psp.version as policy_version, psp.initialized, psp.initialized_at
        from plugin_instances pi
        left join project_scope_policies psp
          on psp.plugin_instance_id = pi.id
          and psp.tenant_id = pi.tenant_id and psp.team_id = pi.team_id
          and psp.partner_id = pi.partner_id
        where pi.tenant_id = ${actor.tenantId} and pi.team_id = ${actor.teamId}
          and pi.partner_id = ${id} and pi.status = 'active'
        order by pi.created_at desc
      `,
      sql<
        Array<{
          plugin_instance_id: string;
          display_name: string;
          status: "pending" | "allowed" | "denied";
          effective_from: Date | null;
          first_seen_period_key: string;
          first_seen_at: Date;
          last_seen_at: Date;
          session_count: number;
        }>
      >`
        select pse.plugin_instance_id, pse.display_name, pse.status,
          pse.effective_from, pse.first_seen_period_key, pse.first_seen_at,
          pse.last_seen_at, pse.session_count
        from project_scope_entries pse
        join plugin_instances pi on pi.id = pse.plugin_instance_id
          and pi.tenant_id = pse.tenant_id and pi.team_id = pse.team_id
          and pi.partner_id = pse.partner_id and pi.status = 'active'
        where pse.tenant_id = ${actor.tenantId} and pse.team_id = ${actor.teamId}
          and pse.partner_id = ${id}
        order by case pse.status
          when 'pending' then 0 when 'allowed' then 1 else 2 end,
          pse.display_name, pse.first_seen_at
      `,
    ]);

    const instances = instanceRows.map((instance) => ({
      id: instance.id,
      deviceName: instance.device_name,
      version: instance.version,
      policyVersion: instance.policy_version ?? 0,
      initialized: instance.initialized ?? false,
      initializedAt: instance.initialized_at,
      projects: entryRows
        .filter((entry) => entry.plugin_instance_id === instance.id)
        .map((entry) => ({
          name: entry.display_name,
          permission: entry.status,
          effectiveFrom: entry.effective_from,
          firstSeenPeriodKey: entry.first_seen_period_key,
          firstSeenAt: entry.first_seen_at,
          lastSeenAt: entry.last_seen_at,
          sessionCount: entry.session_count,
        })),
    }));
    const projects = instances.flatMap((instance) => instance.projects);

    return {
      partner: {
        id: partner.id,
        displayName: partner.display_name,
        email: partner.email,
      },
      summary: {
        total: projects.length,
        allowed: projects.filter((project) => project.permission === "allowed")
          .length,
        pending: projects.filter((project) => project.permission === "pending")
          .length,
        denied: projects.filter((project) => project.permission === "denied")
          .length,
      },
      instances,
    };
  });

  app.post(
    "/v1/admin/plugin-instances/:id/project-scopes/reapproval",
    async (request) => {
      const actor = await requireWebActor(request, "admin");
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const policy = await reopenProjectScopeReview(actor, id, request.body);
      await audit(
        request,
        actor,
        "project_scope.reapproval_requested",
        "plugin_instance",
        id,
        { version: policy.version, projectCount: policy.entries.length },
      );
      return {
        status: "reapproval_requested",
        version: policy.version,
        pending: policy.entries.length,
      };
    },
  );

  app.post("/v1/admin/partners", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = partnerCreateSchema.parse(request.body);
    const email = input.email.trim().toLowerCase();
    const id = randomUUID();
    try {
      const rows = await sql<any[]>`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (${id}, ${actor.tenantId}, ${actor.teamId}, ${email}, ${input.displayName.trim()})
        returning *
      `;
      await audit(request, actor, "partner.created", "partner", id, { email });
      return rows[0];
    } catch (error: any) {
      if (error?.code === "23505")
        throw new ApiError(
          409,
          "PARTNER_EMAIL_EXISTS",
          "该工作邮箱已存在 Partner。",
        );
      throw error;
    }
  });

  app.post("/v1/admin/partners/:id/binding-codes", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = bindingCodeSchema.parse(request.body ?? {});
    const partners = await sql<{ id: string }[]>`
      select id from partners where id = ${id} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId} and status = 'active' limit 1
    `;
    if (!partners[0])
      throw new ApiError(404, "NOT_FOUND", "Partner 不存在或未启用。");
    if (input.pluginInstanceId) {
      const instances = await sql<{ id: string }[]>`
        select id from plugin_instances
        where id = ${input.pluginInstanceId} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and partner_id = ${id}
          and status = 'active'
        limit 1
      `;
      if (!instances[0])
        throw new ApiError(
          404,
          "PLUGIN_INSTANCE_NOT_FOUND",
          "要恢复的插件连接不存在或已失效。",
        );
    }
    const code = `PR-${userCode()}`;
    const bindingId = randomUUID();
    await sql`
      insert into plugin_binding_codes (
        id, tenant_id, team_id, partner_id, code_hash, code_value, code_prefix,
        label, plugin_instance_id, created_by
      ) values (
        ${bindingId}, ${actor.tenantId}, ${actor.teamId}, ${id}, ${sha256(code)}, ${code},
        ${code.slice(0, 7)}, ${input.label}, ${input.pluginInstanceId ?? null},
        ${actor.userId}
      )
    `;
    await audit(
      request,
      actor,
      "plugin.binding_code.created",
      "plugin_binding_code",
      bindingId,
      {
        partnerId: id,
        label: input.label,
        recovery: Boolean(input.pluginInstanceId),
      },
    );
    return {
      id: bindingId,
      code,
      codePrefix: code.slice(0, 7),
      label: input.label,
      recovery: Boolean(input.pluginInstanceId),
    };
  });

  app.delete("/v1/admin/partners/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const removed = await sql.begin(async (tx) => {
      const partners = await tx<
        Array<{
          id: string;
          user_id: string | null;
          display_name: string;
          email: string;
        }>
      >`
        select id, user_id, display_name, email from partners
        where id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and status = 'active'
        for update
      `;
      const partner = partners[0];
      if (!partner) return null;

      await tx`
        update partners set status = 'suspended', updated_at = now()
        where id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId}
      `;
      const plugins = await tx<{ id: string }[]>`
        update plugin_instances set
          status = 'revoked', access_expires_at = now(),
          connectivity_status = 'expired', connectivity_challenge_hash = null,
          connectivity_challenge_expires_at = null, updated_at = now()
        where partner_id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and status <> 'revoked'
        returning id
      `;
      const bindingCodes = await tx<{ id: string }[]>`
        update plugin_binding_codes set status = 'revoked', updated_at = now()
        where partner_id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId}
          and status in ('active', 'connecting')
        returning id
      `;
      if (partner.user_id) {
        await tx`
          update memberships m set
            roles = coalesce((
              select jsonb_agg(role.value)
              from jsonb_array_elements_text(m.roles) as role(value)
              where role.value <> 'partner'
            ), '[]'::jsonb),
            partner_id = null
          where m.tenant_id = ${actor.tenantId} and m.team_id = ${actor.teamId}
            and m.partner_id = ${id} and m.user_id = ${partner.user_id}
        `;
        await tx`
          delete from memberships
          where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
            and user_id = ${partner.user_id} and roles = '[]'::jsonb
        `;
      }
      return {
        ...partner,
        revokedPluginCount: plugins.length,
        revokedBindingCodeCount: bindingCodes.length,
      };
    });
    if (!removed)
      throw new ApiError(404, "PARTNER_NOT_FOUND", "人员不存在或已经删除。");
    await audit(request, actor, "partner.deleted", "partner", id, {
      email: removed.email,
      revokedPluginCount: removed.revokedPluginCount,
      revokedBindingCodeCount: removed.revokedBindingCodeCount,
    });
    return {
      ok: true,
      partnerId: id,
      revokedPluginCount: removed.revokedPluginCount,
      revokedBindingCodeCount: removed.revokedBindingCodeCount,
    };
  });

  app.delete("/v1/admin/binding-codes/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<{ id: string }[]>`
      update plugin_binding_codes set status = 'revoked', updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status in ('active', 'connecting') returning id
    `;
    if (!rows[0])
      throw new ApiError(
        409,
        "BINDING_CODE_NOT_REVOCABLE",
        "绑定码不存在或已使用。",
      );
    await audit(
      request,
      actor,
      "plugin.binding_code.revoked",
      "plugin_binding_code",
      id,
    );
    return { ok: true };
  });

  app.patch("/v1/admin/team", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = teamUpdateSchema.parse(request.body);
    const rows = await sql.begin(async (tx) => {
      const updated = await tx<any[]>`
        update teams set
          name = coalesce(${input.name ?? null}, name),
          timezone = 'Asia/Shanghai',
          evidence_excerpt_enabled = coalesce(${input.evidenceExcerptEnabled ?? null}, evidence_excerpt_enabled),
          session_quiet_period_minutes = coalesce(${input.sessionQuietPeriodMinutes ?? null}, session_quiet_period_minutes),
          period_rule = coalesce(${input.periodRule ? JSON.stringify(input.periodRule) : null}::jsonb, period_rule),
          minimum_plugin_version = coalesce(${input.minimumPluginVersion ?? null}, minimum_plugin_version),
          central_model = coalesce(${input.centralModel ?? null}, central_model),
          updated_at = now()
        where id = ${actor.teamId} and tenant_id = ${actor.tenantId}
        returning *
      `;
      if (updated[0] && input.periodRule) {
        const period = weeklyPeriodAt(
          new Date(),
          "Asia/Shanghai",
          updated[0].period_rule,
        );
        await tx`
          update report_periods set
            ends_at = ${period.endsAt.toISOString()},
            cutoff_at = ${period.cutoffAt.toISOString()},
            submission_deadline_at = ${period.submissionDeadlineAt.toISOString()},
            timezone = 'Asia/Shanghai', updated_at = now()
          where id = (
            select id from report_periods
            where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
              and status = 'open'
            order by starts_at desc limit 1
          )
        `;
      }
      return updated;
    });
    await audit(request, actor, "team.updated", "team", actor.teamId, input);
    return rows[0];
  });

  app.post("/v1/admin/invitations", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = inviteSchema.parse(request.body);
    const existing =
      await sql`select 1 from users where email = ${input.email.trim().toLowerCase()} limit 1`;
    if (existing.length > 0)
      throw new ApiError(409, "EMAIL_EXISTS", "该邮箱已存在账号。");
    const token = randomToken();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await sql`
      insert into invitations (id, tenant_id, team_id, email, roles, token_hash, expires_at, created_by)
      values (
        ${id}, ${actor.tenantId}, ${actor.teamId}, ${input.email.trim().toLowerCase()},
        ${JSON.stringify(input.roles)}::jsonb, ${sha256(token)}, ${expiresAt.toISOString()}, ${actor.userId}
      )
    `;
    await audit(request, actor, "partner.invited", "invitation", id, {
      email: input.email,
      roles: input.roles,
    });
    return {
      id,
      expiresAt,
      inviteUrl: `${process.env.WEB_ORIGIN ?? "http://172.20.10.14:4311"}/accept-invite?token=${encodeURIComponent(token)}`,
    };
  });

  app.patch("/v1/admin/partners/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = partnerUpdateSchema.parse(request.body);
    const partner = await sql.begin(async (tx) => {
      const rows = await tx<any[]>`
        update partners set
          display_name = coalesce(${input.displayName ?? null}, display_name),
          status = coalesce(${input.status ?? null}, status),
          preferences = coalesce(${input.preferences ? JSON.stringify(input.preferences) : null}::jsonb, preferences),
          updated_at = now()
        where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        returning *
      `;
      if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Partner 不存在。");
      return rows[0];
    });
    await audit(request, actor, "partner.updated", "partner", id, input);
    return partner;
  });

  app.post("/v1/admin/report-templates", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = templateSchema.parse(request.body);
    const id = randomUUID();
    const result = await sql.begin(async (tx) => {
      if (input.isDefault) {
        await tx`update report_templates set is_default = false, updated_at = now() where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
      }
      const rows = await tx<any[]>`
        insert into report_templates (id, tenant_id, team_id, name, version, sections, is_default)
        values (${id}, ${actor.tenantId}, ${actor.teamId}, ${input.name}, 1, ${JSON.stringify(input.sections)}::jsonb, ${input.isDefault})
        returning *
      `;
      return rows[0];
    });
    await audit(
      request,
      actor,
      "report_template.created",
      "report_template",
      id,
      { name: input.name, isDefault: input.isDefault },
    );
    return result;
  });

  app.patch("/v1/admin/report-templates/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = templateSchema.partial().parse(request.body);
    const existingRows = await sql<any[]>`
      select * from report_templates where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
    `;
    const existing = existingRows[0];
    if (!existing) throw new ApiError(404, "NOT_FOUND", "报告模板不存在。");
    const nextId = randomUUID();
    const makeDefault = input.isDefault ?? existing.is_default;
    const result = await sql.begin(async (tx) => {
      if (makeDefault) {
        await tx`update report_templates set is_default = false, updated_at = now() where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
      }
      const rows = await tx<any[]>`
        insert into report_templates (id, tenant_id, team_id, name, version, sections, is_default)
        values (
          ${nextId}, ${actor.tenantId}, ${actor.teamId}, ${input.name ?? existing.name}, ${existing.version + 1},
          ${JSON.stringify(input.sections ?? existing.sections)}::jsonb, ${makeDefault}
        ) returning *
      `;
      return rows[0];
    });
    await audit(
      request,
      actor,
      "report_template.version_created",
      "report_template",
      nextId,
      { previousId: id, version: result.version },
    );
    return result;
  });

  app.post("/v1/admin/report-periods", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = periodSchema.parse(request.body);
    if (input.templateId) {
      const templates =
        await sql`select 1 from report_templates where id = ${input.templateId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
      if (templates.length === 0)
        throw new ApiError(
          400,
          "TEMPLATE_NOT_FOUND",
          "报告模板不属于当前 Team。",
        );
    }
    const id = randomUUID();
    const rows = await sql<any[]>`
      insert into report_periods (
        id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
        submission_deadline_at, timezone, status, template_id
      )
      values (
        ${id}, ${actor.tenantId}, ${actor.teamId}, ${input.periodKey}, ${input.startsAt}, ${input.endsAt},
        ${input.cutoffAt}, ${input.cutoffAt}, ${input.timezone}, ${input.status}, ${input.templateId ?? null}
      ) returning *
    `;
    await audit(request, actor, "report_period.created", "report_period", id, {
      periodKey: input.periodKey,
    });
    return rows[0];
  });

  app.patch("/v1/admin/report-periods/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z
      .object({
        status: z.enum([
          "open",
          "closing",
          "facts_frozen",
          "closed",
          "completed",
        ]),
        templateId: z.string().uuid().nullable().optional(),
        cutoffAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(request.body);
    if (input.templateId) {
      const templates =
        await sql`select 1 from report_templates where id = ${input.templateId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
      if (templates.length === 0)
        throw new ApiError(
          400,
          "TEMPLATE_NOT_FOUND",
          "报告模板不属于当前 Team。",
        );
    }
    const rows = await sql<any[]>`
      update report_periods set status = ${input.status},
        cutoff_at = coalesce(${input.cutoffAt ?? null}, cutoff_at),
        submission_deadline_at = coalesce(${input.cutoffAt ?? null}, submission_deadline_at),
        template_id = case when ${input.templateId === undefined} then template_id else ${input.templateId ?? null} end,
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      returning *
    `;
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "报告周期不存在。");
    await audit(
      request,
      actor,
      "report_period.updated",
      "report_period",
      id,
      input,
    );
    return rows[0];
  });

  app.post("/v1/admin/projects", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = projectSchema.parse(request.body);
    const id = randomUUID();
    const rows = await sql<any[]>`
      insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids)
      values (
        ${id}, ${actor.tenantId}, ${actor.teamId}, ${input.name},
        ${JSON.stringify(input.aliases)}::jsonb, ${JSON.stringify(input.allowedPaths)}::jsonb,
        ${JSON.stringify(input.externalIds)}::jsonb
      ) returning *
    `;
    await audit(request, actor, "project.created", "project", id, {
      name: input.name,
    });
    return rows[0];
  });

  app.patch("/v1/admin/projects/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = projectSchema.partial().parse(request.body);
    const rows = await sql<any[]>`
      update projects set
        name = coalesce(${input.name ?? null}, name),
        aliases = coalesce(${input.aliases ? JSON.stringify(input.aliases) : null}::jsonb, aliases),
        allowed_paths = coalesce(${input.allowedPaths ? JSON.stringify(input.allowedPaths) : null}::jsonb, allowed_paths),
        external_ids = coalesce(${input.externalIds ? JSON.stringify(input.externalIds) : null}::jsonb, external_ids),
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      returning *
    `;
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "项目不存在。");
    await audit(request, actor, "project.updated", "project", id, input);
    return rows[0];
  });

  app.get("/v1/admin/audit-events", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return sql<any[]>`
      select * from audit_events
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      order by created_at desc limit 200
    `;
  });

  app.get("/v1/admin/agent-jobs", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({
        status: z.string().max(40).optional(),
        type: z.string().max(80).optional(),
      })
      .parse(request.query);
    return sql<any[]>`
      select aj.id, aj.partner_id, aj.plugin_instance_id, aj.type, aj.status,
        aj.attempt_count, aj.max_attempts, aj.error_code, aj.error_message,
        aj.lease_until, aj.completed_at, aj.created_at, aj.updated_at,
        p.display_name as partner_name, pi.device_name as plugin_device_name
      from agent_jobs aj
      left join partners p on p.id = aj.partner_id and p.tenant_id = aj.tenant_id
      left join plugin_instances pi on pi.id = aj.plugin_instance_id
        and pi.tenant_id = aj.tenant_id
      where aj.tenant_id = ${actor.tenantId} and aj.team_id = ${actor.teamId}
        and (${query.status ?? null}::text is null or aj.status = ${query.status ?? null})
        and (${query.type ?? null}::text is null or aj.type = ${query.type ?? null})
      order by aj.updated_at desc limit 200
    `;
  });

  app.get("/v1/admin/agent-jobs/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<any[]>`
      select aj.id, aj.partner_id, aj.plugin_instance_id, aj.type, aj.status,
        aj.attempt_count, aj.max_attempts, aj.error_code, aj.error_message,
        aj.lease_until, aj.completed_at, aj.created_at, aj.updated_at,
        p.display_name as partner_name, pi.device_name as plugin_device_name
      from agent_jobs aj
      left join partners p on p.id = aj.partner_id and p.tenant_id = aj.tenant_id
      left join plugin_instances pi on pi.id = aj.plugin_instance_id
        and pi.tenant_id = aj.tenant_id
      where aj.id = ${id} and aj.tenant_id = ${actor.tenantId} and aj.team_id = ${actor.teamId}
    `;
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "任务不存在。");
    return rows[0];
  });

  app.post("/v1/admin/plugin-instances/:id/rescan", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const plugins = await sql<any[]>`
      select * from plugin_instances where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
    `;
    const plugin = plugins[0];
    if (!plugin)
      throw new ApiError(404, "NOT_FOUND", "Plugin Instance 不存在。");
    const jobId = randomUUID();
    const key = `rescan:${id}:${new Date().toISOString().slice(0, 13)}`;
    const jobs = await sql<any[]>`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, plugin_instance_id, type, idempotency_key, input_payload
      ) values (
        ${jobId}, ${actor.tenantId}, ${actor.teamId}, ${plugin.partner_id}, ${id},
        'RESCAN_SESSIONS', ${key}, ${JSON.stringify({ reason: "admin_requested" })}::jsonb
      ) on conflict (tenant_id, idempotency_key) do update set updated_at = agent_jobs.updated_at
      returning *
    `;
    await audit(
      request,
      actor,
      "plugin.rescan_requested",
      "plugin_instance",
      id,
      { jobId: jobs[0].id },
    );
    return jobs[0];
  });

  app.delete("/v1/admin/plugin-instances/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<any[]>`
      update plugin_instances set status = 'revoked', access_expires_at = now(), updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      returning id
    `;
    if (!rows[0])
      throw new ApiError(404, "NOT_FOUND", "Plugin Instance 不存在。");
    await audit(
      request,
      actor,
      "plugin.binding.revoked",
      "plugin_instance",
      id,
    );
    return { ok: true };
  });

  app.post("/v1/admin/agent-jobs/:id/cancel", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<any[]>`
      update agent_jobs set status = 'CANCELLED', updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
      returning id
    `;
    if (!rows[0])
      throw new ApiError(
        409,
        "JOB_NOT_CANCELLABLE",
        "任务不存在或当前不可取消。",
      );
    await audit(request, actor, "agent_job.cancelled", "agent_job", id);
    return { ok: true };
  });

  app.post("/v1/admin/agent-jobs/:id/retry", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await sql.begin(async (tx) => {
      const rows = await tx<any[]>`
        select id, type, status, attempt_count, max_attempts
        from agent_jobs
        where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        for update
      `;
      const current = rows[0];
      if (!current) throw new ApiError(404, "NOT_FOUND", "任务不存在。");
      if (!["FAILED", "RETRY_WAIT"].includes(current.status))
        throw new ApiError(
          409,
          "JOB_NOT_RETRYABLE",
          "任务当前不处于失败或等待重试状态。",
        );
      const maxAttempts = nextManualRetryMaxAttempts(
        current.attempt_count,
        current.max_attempts,
      );
      const updated = await tx<any[]>`
        update agent_jobs set status = 'PENDING', max_attempts = ${maxAttempts},
          lease_token_hash = null, lease_until = null, completed_at = null,
          updated_at = now()
        where id = ${id}
        returning id, type, status, attempt_count, max_attempts, updated_at
      `;
      return updated[0];
    });
    await audit(request, actor, "agent_job.retry_requested", "agent_job", id, {
      type: job.type,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
    });
    return job;
  });

  app.post("/v1/admin/agent-jobs/:id/clear", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<any[]>`
      update agent_jobs set status = 'CANCELLED', lease_token_hash = null,
        lease_until = null, updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status in ('FAILED', 'RETRY_WAIT')
      returning id, type, status, error_code, error_message, updated_at
    `;
    const job = rows[0];
    if (!job)
      throw new ApiError(
        409,
        "JOB_NOT_CLEARABLE",
        "任务当前不处于失败或等待重试状态。",
      );
    await audit(request, actor, "agent_job.cleared", "agent_job", id, {
      type: job.type,
      errorCode: job.error_code,
    });
    return job;
  });
}
