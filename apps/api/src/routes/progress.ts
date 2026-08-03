import type { FastifyInstance } from "fastify";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, requireWebActor } from "../common.js";

type WorkItemRow = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  status: string;
  payload: Record<string, unknown>;
  fact_ids: string[];
  updated_at: string;
};

export async function progressRoutes(app: FastifyInstance) {
  app.get("/v1/partner/progress", async (request) => {
    const actor = await requireWebActor(request, "partner");
    if (!actor.partnerId)
      throw new ApiError(
        403,
        "PARTNER_REQUIRED",
        "当前账号没有 Partner Profile。",
      );

    const periodRows = await sql<any[]>`
      select * from report_periods
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status in ('open', 'closed') and starts_at <= now()
      order by starts_at desc limit 1
    `;
    const period = periodRows[0] ?? null;
    if (!period) {
      return {
        period: null,
        aggregation: null,
        coverage: null,
        summary: {
          projectCount: 0,
          itemCount: 0,
          completedCount: 0,
          blockedCount: 0,
        },
        projects: [],
      };
    }

    const [itemRows, aggregationRows, coverageRows] = await Promise.all([
      sql<WorkItemRow[]>`
        select wi.id, wi.project_id, p.name as project_name, wi.title, wi.status,
          wi.payload, wi.fact_ids, wi.updated_at
        from work_items wi
        left join projects p on p.id = wi.project_id and p.tenant_id = wi.tenant_id
        where wi.tenant_id = ${actor.tenantId} and wi.partner_id = ${actor.partnerId}
          and wi.period_id = ${period.id} and wi.review_status != 'excluded'
        order by p.name nulls last,
          ((wi.payload->'importance'->>'partnerEmphasis')::numeric) desc nulls last,
          wi.updated_at desc
      `,
      sql<any[]>`
        select id, status, attempt_count, error_code, created_at, updated_at, completed_at
        from agent_jobs
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
          and type = 'AGGREGATE_WORK_ITEMS'
          and input_payload->'period'->>'id' = ${period.id}
        order by created_at desc limit 1
      `,
      sql<any[]>`
        select payload, created_at from coverage_snapshots
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
          and period_id = ${period.id}
        order by created_at desc limit 1
      `,
    ]);

    const grouped = new Map<
      string,
      { id: string | null; name: string; items: WorkItemRow[] }
    >();
    for (const item of itemRows) {
      const key = item.project_id ?? "unassigned";
      const project = grouped.get(key) ?? {
        id: item.project_id,
        name: item.project_name ?? "未归类事项",
        items: [],
      };
      project.items.push(item);
      grouped.set(key, project);
    }

    return {
      period,
      aggregation: aggregationRows[0] ?? null,
      coverage: coverageRows[0]?.payload ?? null,
      summary: {
        projectCount: [...grouped.values()].filter((project) => project.id)
          .length,
        itemCount: itemRows.length,
        completedCount: itemRows.filter((item) => item.status === "completed")
          .length,
        blockedCount: itemRows.filter((item) => item.status === "blocked")
          .length,
      },
      projects: [...grouped.values()].map((project) => ({
        ...project,
        statusCounts: project.items.reduce<Record<string, number>>(
          (counts, item) => {
            counts[item.status] = (counts[item.status] ?? 0) + 1;
            return counts;
          },
          {},
        ),
      })),
    };
  });
}
