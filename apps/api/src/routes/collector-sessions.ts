import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collectorSessionSchema } from "@partner-report/contracts";
import {
  latestSessionsCte,
  projectNameJoin,
  sqlClient as sql,
  syncSessionPreprocess,
} from "@partner-report/db";
import { ApiError, requireWebActor } from "../common.js";

type SessionRow = {
  upload_id: string;
  session_id: string;
  partner_id: string;
  partner_name: string;
  period_id: string;
  period_key: string;
  agent: string;
  title: string;
  modified_at: Date;
  turn_count: number;
  preview: string | null;
  project_name: string;
};

export async function collectorSessionRoutes(app: FastifyInstance) {
  app.get("/v1/admin/collector-sessions", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({
        partnerId: z.string().uuid().optional(),
        periodId: z.string().uuid().optional(),
        project: z.string().min(1).max(200).optional(),
        agent: z.string().min(1).max(50).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(10),
      })
      .strict()
      .parse(request.query);
    const rows = await sql<SessionRow[]>`
      with ${latestSessionsCte({ tenantId: actor.tenantId, teamId: actor.teamId, partnerId: query.partnerId, periodId: query.periodId })}
      select l.upload_id, l.session_id, l.partner_id, pa.display_name as partner_name,
        l.period_id, l.period_key, l.agent, l.title, l.modified_at,
        l.turn_count, l.preview, coalesce(e.display_name, '未命名项目') as project_name
      from latest l
      join partners pa on pa.id = l.partner_id
      ${projectNameJoin}
      order by l.modified_at desc, l.session_id
    `;
    const projects = [...new Set(rows.map((row) => row.project_name))].sort(
      (a, b) => a.localeCompare(b, "zh-CN"),
    );
    const agents = [...new Set(rows.map((row) => row.agent))].sort();
    const matched = rows.filter(
      (row) =>
        (!query.project || row.project_name === query.project) &&
        (!query.agent || row.agent === query.agent),
    );
    const offset = (query.page - 1) * query.pageSize;
    return {
      items: matched
        .slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      projects,
      agents,
    };
  });

  app.get("/v1/admin/collector-sessions/detail", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({
        uploadId: z.string().uuid(),
        sessionId: z.string().min(1).max(1024),
      })
      .strict()
      .parse(request.query);
    const [row] = await sql<
      Array<{
        session: unknown;
        partner_name: string;
        period_key: string;
        project_name: string;
      }>
    >`
      select s.item as session, pa.display_name as partner_name, u.period_key,
        coalesce(e.display_name, '未命名项目') as project_name
      from collector_uploads u
      join collector_devices d on d.id = u.device_id
      join partners pa on pa.id = d.partner_id
      join collector_upload_parts p on p.upload_id = u.id
      cross join lateral jsonb_array_elements(p.sessions) s(item)
      left join project_scope_aliases a on a.plugin_instance_id = d.scope_instance_id
        and a.alias_kind = 'scope' and a.alias_key = s.item->>'scopeKey'
      left join project_scope_entries e on e.plugin_instance_id = d.scope_instance_id
        and e.scope_key = coalesce(a.scope_key, s.item->>'scopeKey')
      where u.id = ${query.uploadId} and u.status = 'completed'
        and d.tenant_id = ${actor.tenantId} and d.team_id = ${actor.teamId}
        and s.item->>'id' = ${query.sessionId}
      limit 1
    `;
    if (!row) throw new ApiError(404, "SESSION_NOT_FOUND", "会话不存在。");
    const session = collectorSessionSchema.parse(row.session);
    return {
      uploadId: query.uploadId,
      sessionId: session.id,
      agent: session.agent,
      title: session.title,
      modifiedAt: session.modifiedAt,
      partnerName: row.partner_name,
      periodKey: row.period_key,
      projectName: row.project_name,
      turns: session.turns,
    };
  });
}
