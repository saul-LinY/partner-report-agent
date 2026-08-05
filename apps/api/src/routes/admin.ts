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
  displayName: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  preferences: z.record(z.unknown()).optional(),
});

const partnerCreateSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
});

const bindingCodeSchema = z.object({
  label: z.string().min(1).max(120).default("Codex Plugin"),
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

export const pluginHealth = pluginRunStatus;

export type FeishuBindingState =
  "disabled" | "not_connected" | "pending" | "connected" | "invalid";

export type FeishuDeliveryState =
  | "idle"
  | "pending"
  | "sending"
  | "healthy"
  | "retrying"
  | "failed"
  | "deferred"
  | "unknown";

export type FeishuConnectionState =
  FeishuBindingState | "delivery_error" | "delivery_pending";

export function feishuBindingState(row: {
  enabled: boolean;
  status: string | null;
  openIdPresent: boolean;
}): FeishuBindingState {
  if (!row.enabled) return "disabled";
  if (!row.status) return "not_connected";
  if (row.status === "pending") return "pending";
  if (row.status === "active" && row.openIdPresent) return "connected";
  return "invalid";
}

export function feishuDeliveryState(
  status: string | null,
): FeishuDeliveryState {
  if (!status) return "idle";
  if (["sent", "confirmed"].includes(status)) return "healthy";
  if (status === "retry_wait") return "retrying";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  if (status === "sending") return "sending";
  if (status === "deferred") return "deferred";
  return "unknown";
}

export function feishuConnectionState(
  binding: FeishuBindingState,
  delivery: FeishuDeliveryState,
): FeishuConnectionState {
  if (["disabled", "not_connected", "invalid"].includes(binding))
    return binding;
  if (["retrying", "failed", "unknown"].includes(delivery))
    return "delivery_error";
  if (binding === "pending") return "pending";
  if (["pending", "sending", "deferred"].includes(delivery))
    return "delivery_pending";
  return "connected";
}

export async function adminRoutes(app: FastifyInstance) {
  const feishuAppId = process.env.FEISHU_APP_ID?.trim() || null;
  app.get("/v1/admin/overview", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const [
      teamRows,
      partnerRows,
      periodRows,
      projectRows,
      pluginRows,
      jobRows,
      bindingRows,
      queueRows,
    ] = await Promise.all([
      sql<
        any[]
      >`select * from teams where id = ${actor.teamId} and tenant_id = ${actor.tenantId}`,
      sql<any[]>`
        select p.id, p.display_name, p.email, p.status, p.preferences, p.user_id, p.created_at,
          fb.status as feishu_binding_status,
          (fb.open_id is not null) as feishu_open_id_present,
          fb.verified_at as feishu_verified_at,
          fd.kind as feishu_delivery_kind,
          fd.status as feishu_delivery_status,
          fd.updated_at as feishu_delivery_updated_at,
          fd.last_error_code as feishu_delivery_error_code,
          fd.next_retry_at as feishu_delivery_next_retry_at
        from partners p
        left join lateral (
          select b.app_id, b.status, b.open_id, b.verified_at
          from feishu_partner_bindings b
          where b.tenant_id = p.tenant_id and b.team_id = p.team_id
            and b.partner_id = p.id
            and b.app_id = ${feishuAppId}
          order by b.updated_at desc
          limit 1
        ) fb on true
        left join lateral (
          select d.kind, d.status, d.updated_at, d.last_error_code, d.next_retry_at
          from feishu_deliveries d
          where d.tenant_id = p.tenant_id and d.team_id = p.team_id
            and d.partner_id = p.id
            and split_part(d.idempotency_key, ':', 2) = fb.app_id
          order by case
            when d.status in ('retry_wait', 'failed') then 0
            when d.status in ('pending', 'sending', 'deferred') then 1
            when d.status in ('sent', 'confirmed') then 2
            else 0
          end, d.updated_at desc
          limit 1
        ) fd on fb.app_id is not null
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
          pi.id, pi.tenant_id, pi.team_id, pi.partner_id, pi.device_name, pi.version, pi.status,
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
        select r.id as review_id, r.state as review_state, r.version as review_version,
          r.pending_count, r.approved_count, r.excluded_count, r.updated_at,
          p.id as partner_id, p.display_name as partner_name, p.email as partner_email,
          rp.period_key, ir.id as report_id, ir.status as report_status, ir.content_revision
        from reviews r
        join partners p on p.id = r.partner_id and p.tenant_id = r.tenant_id
        join report_periods rp on rp.id = r.period_id and rp.tenant_id = r.tenant_id
        left join individual_reports ir on ir.partner_id = r.partner_id and ir.period_id = r.period_id
          and ir.tenant_id = r.tenant_id
        where r.tenant_id = ${actor.tenantId} and r.team_id = ${actor.teamId}
          and (
            r.state in ('PENDING', 'IN_PROGRESS')
            or ir.status in ('REPORT_DRAFT', 'REPORT_REVIEW')
          )
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
      const bindingState = feishuBindingState({
        enabled: feishuAppId !== null,
        status: partner.feishu_binding_status,
        openIdPresent: partner.feishu_open_id_present === true,
      });
      const deliveryState = feishuDeliveryState(partner.feishu_delivery_status);
      return {
        partnerId: partner.id,
        partnerName: partner.display_name,
        partnerEmail: partner.email,
        connectionState,
        verifiedAt: plugin?.connectivity_verified_at ?? null,
        lastUploadAt: plugin?.last_sync_at ?? null,
        deviceName: plugin?.device_name ?? null,
        version: plugin?.version ?? null,
        feishu: {
          state: feishuConnectionState(bindingState, deliveryState),
          bindingState,
          deliveryState,
          verifiedAt: partner.feishu_verified_at ?? null,
          lastDeliveryKind: partner.feishu_delivery_kind ?? null,
          lastDeliveryStatus: partner.feishu_delivery_status ?? null,
          lastDeliveryAt: partner.feishu_delivery_updated_at ?? null,
          lastErrorCode: partner.feishu_delivery_error_code ?? null,
          nextRetryAt: partner.feishu_delivery_next_retry_at ?? null,
        },
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
      connections,
      jobs: jobRows,
      bindingCodes: bindingRows,
      reviewQueue: queueRows,
    };
  });

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
    const code = `PR-${userCode()}`;
    const bindingId = randomUUID();
    await sql`
      insert into plugin_binding_codes (
        id, tenant_id, team_id, partner_id, code_hash, code_value, code_prefix, label, created_by
      ) values (
        ${bindingId}, ${actor.tenantId}, ${actor.teamId}, ${id}, ${sha256(code)}, ${code},
        ${code.slice(0, 7)}, ${input.label}, ${actor.userId}
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
      },
    );
    return {
      id: bindingId,
      code,
      codePrefix: code.slice(0, 7),
      label: input.label,
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
          and team_id = ${actor.teamId} and status = 'active'
        returning id
      `;
      const feishuBindings = await tx<{ id: string }[]>`
        update feishu_partner_bindings set
          status = 'revoked', open_id = null, union_id = null,
          tenant_key = null, verified_at = null, updated_at = now()
        where partner_id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and status <> 'revoked'
        returning id
      `;
      const feishuDeliveries = await tx<{ id: string }[]>`
        update feishu_deliveries set
          status = 'cancelled', next_retry_at = null,
          last_error_code = 'PARTNER_REMOVED', last_error_message = null,
          updated_at = now()
        where partner_id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId}
          and status in ('pending', 'sending', 'retry_wait', 'failed', 'deferred')
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
        revokedFeishuBindingCount: feishuBindings.length,
        cancelledFeishuDeliveryCount: feishuDeliveries.length,
      };
    });
    if (!removed)
      throw new ApiError(404, "PARTNER_NOT_FOUND", "人员不存在或已经删除。");
    await audit(request, actor, "partner.deleted", "partner", id, {
      email: removed.email,
      revokedPluginCount: removed.revokedPluginCount,
      revokedBindingCodeCount: removed.revokedBindingCodeCount,
      revokedFeishuBindingCount: removed.revokedFeishuBindingCount,
      cancelledFeishuDeliveryCount: removed.cancelledFeishuDeliveryCount,
    });
    return {
      ok: true,
      partnerId: id,
      revokedPluginCount: removed.revokedPluginCount,
      revokedBindingCodeCount: removed.revokedBindingCodeCount,
      revokedFeishuBindingCount: removed.revokedFeishuBindingCount,
      cancelledFeishuDeliveryCount: removed.cancelledFeishuDeliveryCount,
    };
  });

  app.delete("/v1/admin/binding-codes/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<{ id: string }[]>`
      update plugin_binding_codes set status = 'revoked', updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'active' returning id
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
    const rows = await sql<any[]>`
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
    if (rows[0] && input.periodRule) {
      const period = weeklyPeriodAt(
        new Date(),
        "Asia/Shanghai",
        rows[0].period_rule,
      );
      await sql`
        update report_periods set
          starts_at = ${period.startsAt.toISOString()},
          ends_at = ${period.endsAt.toISOString()},
          cutoff_at = ${period.cutoffAt.toISOString()},
          submission_deadline_at = ${period.submissionDeadlineAt.toISOString()},
          timezone = 'Asia/Shanghai', updated_at = now()
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and status = 'open' and period_key = ${period.periodKey}
      `;
    }
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
      inviteUrl: `${process.env.WEB_ORIGIN ?? "http://127.0.0.1:4311"}/accept-invite?token=${encodeURIComponent(token)}`,
    };
  });

  app.patch("/v1/admin/partners/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = partnerUpdateSchema.parse(request.body);
    const rows = await sql<any[]>`
      update partners set
        display_name = coalesce(${input.displayName ?? null}, display_name),
        status = coalesce(${input.status ?? null}, status),
        preferences = coalesce(${input.preferences ? JSON.stringify(input.preferences) : null}::jsonb, preferences),
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      returning *
    `;
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Partner 不存在。");
    await audit(request, actor, "partner.updated", "partner", id, input);
    return rows[0];
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
      select id, partner_id, plugin_instance_id, type, status, attempt_count, max_attempts,
        error_code, lease_until, completed_at, created_at, updated_at
      from agent_jobs
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and (${query.status ?? null}::text is null or status = ${query.status ?? null})
        and (${query.type ?? null}::text is null or type = ${query.type ?? null})
      order by created_at desc limit 200
    `;
  });

  app.get("/v1/admin/agent-jobs/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await sql<any[]>`
      select id, partner_id, plugin_instance_id, type, status, attempt_count, max_attempts,
        error_code, error_message, lease_until, completed_at, created_at, updated_at
      from agent_jobs where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
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
}
