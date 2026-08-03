import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import semver from "semver";
import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, randomToken, requireWebActor, sha256 } from "../common.js";

const inviteSchema = z.object({
  email: z.string().email(),
  roles: z.array(z.enum(["admin", "partner"])).min(1)
});

const projectSchema = z.object({
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).default([]),
  allowedPaths: z.array(z.string().max(1000)).default([]),
  externalIds: z.array(z.string().max(200)).default([])
});

const teamUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(100).optional(),
  evidenceExcerptEnabled: z.boolean().optional(),
  sessionQuietPeriodMinutes: z.number().int().min(15).max(24 * 60).optional(),
  minimumPluginVersion: z.string().min(1).max(40).optional()
});

const partnerUpdateSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  preferences: z.record(z.unknown()).optional()
});

const templateSchema = z.object({
  name: z.string().min(1).max(120),
  sections: z.array(z.string().min(1).max(100)).length(7),
  isDefault: z.boolean().default(false)
});

const periodSchema = z.object({
  periodKey: z.string().min(1).max(80),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  cutoffAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).max(100),
  templateId: z.string().uuid().optional(),
  status: z.enum(["open", "closed"]).default("open")
}).superRefine((value, context) => {
  if (new Date(value.startsAt) >= new Date(value.endsAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt 必须晚于 startsAt" });
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["timezone"], message: "无效 IANA 时区" });
  }
});

export function pluginHealth(row: {
  status: string;
  version: string;
  minimumPluginVersion: string;
  lastHeartbeatAt: Date | string | null;
  retryCount: number;
  lastErrorCode: string | null;
  runnerState?: string | null;
}) {
  if (row.status !== "active") return "blocked";
  if (!semver.valid(row.version) || !semver.gte(row.version, row.minimumPluginVersion)) return "blocked";
  const heartbeat = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : 0;
  const ageMinutes = (Date.now() - heartbeat) / 60_000;
  if (ageMinutes > 60) return "offline";
  if (ageMinutes > 15 || ["unknown", "delayed", "error"].includes(row.runnerState ?? "") || row.retryCount > 0 || row.lastErrorCode) return "delayed";
  return "healthy";
}

export async function adminRoutes(app: FastifyInstance) {
  app.get("/v1/admin/overview", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const [teamRows, projectRows, partnerRows, templateRows, periodRows, pluginRows, jobRows, auditRows] = await Promise.all([
      sql<any[]>`select * from teams where id = ${actor.teamId} and tenant_id = ${actor.tenantId}`,
      sql<any[]>`select * from projects where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId} order by name`,
      sql<any[]>`
        select p.id, p.display_name, p.status, p.preferences, p.user_id, p.created_at, u.email,
          coalesce(m.roles, '[]'::jsonb) as roles
        from partners p
        left join users u on u.id = p.user_id
        left join memberships m on m.partner_id = p.id and m.tenant_id = p.tenant_id and m.team_id = p.team_id
        where p.team_id = ${actor.teamId} and p.tenant_id = ${actor.tenantId}
        order by p.display_name
      `,
      sql<any[]>`
        select * from report_templates
        where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId}
        order by is_default desc, version desc, name
      `,
      sql<any[]>`
        select * from report_periods
        where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId}
        order by starts_at desc limit 8
      `,
      sql<any[]>`
        select
          pi.id, pi.tenant_id, pi.team_id, pi.partner_id, pi.device_name, pi.version, pi.status,
          pi.access_expires_at, pi.last_heartbeat_at, pi.last_hook_at, pi.last_runner_at,
          pi.last_scan_at, pi.last_sync_at, pi.next_due_at, pi.runner_state, pi.dirty_sessions,
          pi.extracting_sessions, pi.pending_local_jobs, pi.retry_count, pi.last_error_code,
          pi.created_at, pi.updated_at,
          p.display_name as partner_name, t.minimum_plugin_version, coverage.payload as coverage,
          coalesce(pending_jobs.count, 0)::int as pending_agent_jobs
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
        where pi.team_id = ${actor.teamId} and pi.tenant_id = ${actor.tenantId}
        order by pi.created_at desc
      `,
      sql<any[]>`
        select status, type, count(*)::int as count from agent_jobs
        where team_id = ${actor.teamId} and tenant_id = ${actor.tenantId}
        group by status, type
      `,
      sql<any[]>`
        select * from audit_events
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        order by created_at desc limit 20
      `
    ]);

    return {
      team: teamRows[0],
      projects: projectRows,
      partners: partnerRows,
      templates: templateRows,
      periods: periodRows,
      plugins: pluginRows.map((row) => ({ ...row, health: pluginHealth({
        status: row.status,
        version: row.version,
        minimumPluginVersion: row.minimum_plugin_version,
        lastHeartbeatAt: row.last_heartbeat_at,
        retryCount: row.retry_count,
        lastErrorCode: row.last_error_code,
        runnerState: row.runner_state
      }) })),
      jobs: jobRows,
      auditEvents: auditRows
    };
  });

  app.patch("/v1/admin/team", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = teamUpdateSchema.parse(request.body);
    const rows = await sql<any[]>`
      update teams set
        name = coalesce(${input.name ?? null}, name),
        timezone = coalesce(${input.timezone ?? null}, timezone),
        evidence_excerpt_enabled = coalesce(${input.evidenceExcerptEnabled ?? null}, evidence_excerpt_enabled),
        session_quiet_period_minutes = coalesce(${input.sessionQuietPeriodMinutes ?? null}, session_quiet_period_minutes),
        minimum_plugin_version = coalesce(${input.minimumPluginVersion ?? null}, minimum_plugin_version),
        updated_at = now()
      where id = ${actor.teamId} and tenant_id = ${actor.tenantId}
      returning *
    `;
    await audit(request, actor, "team.updated", "team", actor.teamId, input);
    return rows[0];
  });

  app.post("/v1/admin/invitations", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = inviteSchema.parse(request.body);
    const existing = await sql`select 1 from users where email = ${input.email.trim().toLowerCase()} limit 1`;
    if (existing.length > 0) throw new ApiError(409, "EMAIL_EXISTS", "该邮箱已存在账号。");
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
    await audit(request, actor, "partner.invited", "invitation", id, { email: input.email, roles: input.roles });
    return {
      id,
      expiresAt,
      inviteUrl: `${process.env.WEB_ORIGIN ?? "http://127.0.0.1:4311"}/accept-invite?token=${encodeURIComponent(token)}`
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
    await audit(request, actor, "report_template.created", "report_template", id, { name: input.name, isDefault: input.isDefault });
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
    await audit(request, actor, "report_template.version_created", "report_template", nextId, { previousId: id, version: result.version });
    return result;
  });

  app.post("/v1/admin/report-periods", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const input = periodSchema.parse(request.body);
    if (input.templateId) {
      const templates = await sql`select 1 from report_templates where id = ${input.templateId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
      if (templates.length === 0) throw new ApiError(400, "TEMPLATE_NOT_FOUND", "报告模板不属于当前 Team。");
    }
    const id = randomUUID();
    const rows = await sql<any[]>`
      insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, timezone, status, template_id)
      values (
        ${id}, ${actor.tenantId}, ${actor.teamId}, ${input.periodKey}, ${input.startsAt}, ${input.endsAt},
        ${input.cutoffAt}, ${input.timezone}, ${input.status}, ${input.templateId ?? null}
      ) returning *
    `;
    await audit(request, actor, "report_period.created", "report_period", id, { periodKey: input.periodKey });
    return rows[0];
  });

  app.patch("/v1/admin/report-periods/:id", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ status: z.enum(["open", "closed"]), templateId: z.string().uuid().nullable().optional() }).parse(request.body);
    if (input.templateId) {
      const templates = await sql`select 1 from report_templates where id = ${input.templateId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}`;
      if (templates.length === 0) throw new ApiError(400, "TEMPLATE_NOT_FOUND", "报告模板不属于当前 Team。");
    }
    const rows = await sql<any[]>`
      update report_periods set status = ${input.status},
        template_id = case when ${input.templateId === undefined} then template_id else ${input.templateId ?? null} end,
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      returning *
    `;
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "报告周期不存在。");
    await audit(request, actor, "report_period.updated", "report_period", id, input);
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
    await audit(request, actor, "project.created", "project", id, { name: input.name });
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
    const query = z.object({ status: z.string().max(40).optional(), type: z.string().max(80).optional() }).parse(request.query);
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
    if (!plugin) throw new ApiError(404, "NOT_FOUND", "Plugin Instance 不存在。");
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
    await audit(request, actor, "plugin.rescan_requested", "plugin_instance", id, { jobId: jobs[0].id });
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
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Plugin Instance 不存在。");
    await audit(request, actor, "plugin.binding.revoked", "plugin_instance", id);
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
    if (!rows[0]) throw new ApiError(409, "JOB_NOT_CANCELLABLE", "任务不存在或当前不可取消。");
    await audit(request, actor, "agent_job.cancelled", "agent_job", id);
    return { ok: true };
  });
}
