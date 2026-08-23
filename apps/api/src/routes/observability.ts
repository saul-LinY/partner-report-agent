import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pluginLogBatchSchema } from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  requirePluginActor,
  requireWebActor,
} from "../common.js";

const adminLogQuerySchema = z
  .object({
    pluginInstanceId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    level: z.enum(["debug", "info", "warning", "error"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

const secretPatterns: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi, "Bearer <REDACTED>"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<REDACTED_API_KEY>"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "<REDACTED_PRIVATE_KEY>",
  ],
  [
    /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s,;"']{4,}/gi,
    "$1$2<REDACTED>",
  ],
  [/\/Users\/[^/\s]+/g, "<USER_HOME>"],
  [/[A-Za-z]:\\Users\\[^\\\s]+/g, "<USER_HOME>"],
];

export function sanitizePluginLogText(value: string) {
  return secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

export function sanitizePluginLogDetails(value: unknown): unknown {
  if (typeof value === "string") return sanitizePluginLogText(value);
  if (Array.isArray(value)) return value.map(sanitizePluginLogDetails);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|secret|password|authorization|credential/i.test(key)
          ? "<REDACTED>"
          : sanitizePluginLogDetails(item),
      ]),
    );
  return value;
}

export async function observabilityRoutes(app: FastifyInstance) {
  app.post("/v1/plugin-instances/me/log-events", async (request) => {
    const actor = await requirePluginActor(request);
    const input = pluginLogBatchSchema.parse(request.body) as {
      events: Array<{
        eventId: string;
        runId?: string;
        level: string;
        stage: string;
        eventCode: string;
        message: string;
        stack?: string;
        occurredAt: string;
        retryable: boolean;
        attempt?: number;
        durationMs?: number;
        requestId?: string;
        details?: Record<string, unknown>;
      }>;
    };
    let accepted = 0;
    await sql.begin(async (tx) => {
      for (const event of input.events) {
        const rows = await tx<{ id: string }[]>`
          insert into plugin_log_events (
            id, tenant_id, team_id, partner_id, plugin_instance_id, run_id,
            level, stage, event_code, message, stack, retryable, attempt,
            duration_ms, request_id, details, occurred_at
          ) values (
            ${event.eventId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
            ${actor.pluginInstanceId}, ${event.runId ?? null}, ${event.level},
            ${event.stage}, ${event.eventCode}, ${sanitizePluginLogText(event.message)},
            ${event.stack ? sanitizePluginLogText(event.stack) : null},
            ${event.retryable}, ${event.attempt ?? null}, ${event.durationMs ?? null},
            ${event.requestId ?? request.id},
            ${JSON.stringify(sanitizePluginLogDetails(event.details ?? {}))}::jsonb,
            ${event.occurredAt}
          ) on conflict (id) do nothing
          returning id
        `;
        accepted += rows.length;
      }
    });
    await audit(
      request,
      actor,
      "plugin.logs.received",
      "plugin_instance",
      actor.pluginInstanceId,
      { accepted, submitted: input.events.length },
    );
    return { ok: true, accepted, submitted: input.events.length };
  });

  app.get("/v1/admin/plugin-logs", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = adminLogQuerySchema.parse(request.query);
    const plugins = await sql<Array<{ id: string; partner_id: string }>>`
      select id, partner_id from plugin_instances
      where id = ${query.pluginInstanceId} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId}
      limit 1
    `;
    const plugin = plugins[0];
    if (!plugin)
      throw new ApiError(404, "PLUGIN_NOT_FOUND", "Plugin Instance 不存在。");

    const events = await sql<any[]>`
      select id, run_id, level, stage, event_code, message, stack, retryable,
        attempt, duration_ms, request_id, details, occurred_at, created_at
      from plugin_log_events
      where tenant_id = ${actor.tenantId}
        and plugin_instance_id = ${query.pluginInstanceId}
        and (${query.runId ?? null}::uuid is null or run_id = ${query.runId ?? null})
        and (${query.level ?? null}::text is null or level = ${query.level ?? null})
      order by occurred_at desc, created_at desc
      limit ${query.limit}
    `;
    const generationJobs = await sql<any[]>`
      select aj.id, aj.type, aj.status, aj.attempt_count, aj.max_attempts,
        aj.error_code, aj.error_message, aj.created_at, aj.updated_at,
        aj.completed_at
      from agent_jobs aj
      where aj.tenant_id = ${actor.tenantId} and aj.team_id = ${actor.teamId}
        and aj.partner_id = ${plugin.partner_id}
      order by aj.updated_at desc limit 100
    `;
    const runs = await sql<any[]>`
      select run_id,
        min(occurred_at) as started_at,
        max(occurred_at) as last_event_at,
        count(*)::int as event_count,
        count(*) filter (where level = 'error')::int as error_count,
        count(*) filter (where level = 'warning')::int as warning_count
      from plugin_log_events
      where tenant_id = ${actor.tenantId}
        and plugin_instance_id = ${query.pluginInstanceId}
        and run_id is not null
      group by run_id
      order by max(occurred_at) desc limit 50
    `;
    return { pluginInstanceId: plugin.id, events, runs, generationJobs };
  });
}
