import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  latestSessionsCte,
  projectNameJoin,
  sqlClient as sql,
  syncSessionPreprocess,
} from "@partner-report/db";
import { ApiError, audit, requireWebActor } from "../common.js";

type PreprocessRow = {
  id: string;
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
  verdict: "keep" | "drop";
  reason: string | null;
  decided_by: "rule" | "human";
};

export async function sessionPreprocessRoutes(app: FastifyInstance) {
  app.get("/v1/admin/session-preprocess", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({
        partnerId: z.string().uuid().optional(),
        periodId: z.string().uuid().optional(),
        project: z.string().min(1).max(200).optional(),
        agent: z.string().min(1).max(50).optional(),
        verdict: z.enum(["keep", "drop"]).optional(),
        reason: z.string().min(1).max(50).optional(),
        decidedBy: z.enum(["rule", "human"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(10),
      })
      .strict()
      .parse(request.query);
    const scope = { tenantId: actor.tenantId, teamId: actor.teamId };
    await syncSessionPreprocess(scope);
    const rows = await sql<PreprocessRow[]>`
      with ${latestSessionsCte({ ...scope, partnerId: query.partnerId, periodId: query.periodId })}
      select sp.id, l.upload_id, l.session_id, l.partner_id, pa.display_name as partner_name,
        l.period_id, l.period_key, l.agent, l.title, l.modified_at, l.turn_count, l.preview,
        coalesce(e.display_name, '未命名项目') as project_name,
        sp.verdict, sp.reason, sp.decided_by
      from latest l
      join partners pa on pa.id = l.partner_id
      join session_preprocess sp on sp.tenant_id = l.tenant_id
        and sp.partner_id = l.partner_id and sp.scope_key = coalesce(l.scope_key, '')
        and sp.agent = l.agent and sp.session_id = l.session_id
      ${projectNameJoin}
      order by l.modified_at desc, l.session_id
    `;
    const projects = [...new Set(rows.map((row) => row.project_name))].sort(
      (a, b) => a.localeCompare(b, "zh-CN"),
    );
    const agents = [...new Set(rows.map((row) => row.agent))].sort();
    // The funnel ignores verdict/reason/decidedBy so its totals stay stable
    // while the list below is narrowed by them.
    const scoped = rows.filter(
      (row) =>
        (!query.project || row.project_name === query.project) &&
        (!query.agent || row.agent === query.agent),
    );
    const reasons: Record<string, number> = {};
    for (const row of scoped)
      if (row.verdict === "drop" && row.reason)
        reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    const dropped = scoped.filter((row) => row.verdict === "drop").length;
    const matched = scoped.filter(
      (row) =>
        (!query.verdict || row.verdict === query.verdict) &&
        (!query.reason || row.reason === query.reason) &&
        (!query.decidedBy || row.decided_by === query.decidedBy),
    );
    const offset = (query.page - 1) * query.pageSize;
    return {
      items: matched.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      projects,
      agents,
      summary: {
        total: scoped.length,
        keep: scoped.length - dropped,
        drop: dropped,
        reasons,
      },
    };
  });

  app.put("/v1/admin/session-preprocess/:id/verdict", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ verdict: z.enum(["keep", "drop", "auto"]) })
      .strict()
      .parse(request.body);
    const scope = { tenantId: actor.tenantId, teamId: actor.teamId };
    // "auto" hands the session back to the rules by marking its verdict stale.
    const rows =
      body.verdict === "auto"
        ? await sql`
            update session_preprocess set decided_by = 'rule', rule_version = 0, updated_at = now()
            where id = ${id} and tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
            returning id`
        : await sql`
            update session_preprocess set verdict = ${body.verdict},
              reason = ${body.verdict === "drop" ? "manual" : null},
              decided_by = 'human', updated_at = now()
            where id = ${id} and tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
            returning id`;
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "会话判定不存在。");
    if (body.verdict === "auto") await syncSessionPreprocess(scope);
    await audit(request, actor, "session_preprocess.verdict_set", "session_preprocess", id, {
      verdict: body.verdict,
    });
    return { ok: true };
  });

  app.post("/v1/admin/session-preprocess/rerun", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const scope = { tenantId: actor.tenantId, teamId: actor.teamId };
    // Human verdicts are left alone; only machine verdicts are re-judged.
    await sql`
      update session_preprocess set rule_version = 0
      where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
        and decided_by <> 'human'`;
    const judged = await syncSessionPreprocess(scope);
    await audit(request, actor, "session_preprocess.rerun", "team", actor.teamId, {
      judged,
    });
    return { ok: true, judged };
  });
}
