import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  reviewChangeRequestSchema,
  workStatusSchema,
} from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, audit, requireWebActor, stableJsonHash } from "../common.js";

type WorkItemRow = {
  id: string;
  review_id: string;
  project_id: string | null;
  title: string;
  status: string;
  review_status: string;
  version: number;
  fact_ids: string[];
  payload: Record<string, any>;
  lineage: Record<string, any>;
};

function patchWorkItem(item: WorkItemRow, operation: string, value: unknown) {
  const after = structuredClone(item);
  switch (operation) {
    case "approve":
      after.review_status = "approved";
      break;
    case "exclude":
      after.review_status = "excluded";
      break;
    case "restore":
      after.review_status = "pending";
      break;
    case "update_status":
      after.status = workStatusSchema.parse(value);
      break;
    case "update_fact": {
      const patch = z
        .object({
          title: z.string().min(1).max(200).optional(),
          summary: z.string().max(1200).optional(),
          outcomes: z.array(z.string().max(500)).optional(),
          blockers: z.array(z.string().max(500)).optional(),
          nextSteps: z.array(z.string().max(500)).optional(),
        })
        .parse(value);
      if (patch.title) after.title = patch.title;
      after.payload = {
        ...after.payload,
        ...Object.fromEntries(
          Object.entries(patch).filter(([key]) => key !== "title"),
        ),
      };
      break;
    }
    case "set_emphasis":
      after.payload = { ...after.payload, emphasis: z.boolean().parse(value) };
      break;
    case "assign_project":
      after.project_id = z.string().uuid().nullable().parse(value);
      break;
    case "add_fact": {
      const fact = z
        .object({
          title: z.string().min(1).max(200),
          detail: z.string().min(1).max(1200),
          status: workStatusSchema.optional(),
        })
        .parse(value);
      after.payload = {
        ...after.payload,
        partnerFacts: [
          ...(after.payload.partnerFacts ?? []),
          { ...fact, origin: "partner_supplied" },
        ],
      };
      if (fact.status) after.status = fact.status;
      break;
    }
    default:
      break;
  }
  after.version += 1;
  return after;
}

async function loadReview(
  actor: { tenantId: string; partnerId: string | null },
  reviewId: string,
) {
  if (!actor.partnerId)
    throw new ApiError(
      403,
      "PARTNER_REQUIRED",
      "当前账号没有 Partner Profile。",
    );
  const rows = await sql<any[]>`
    select * from reviews
    where id = ${reviewId} and tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
    limit 1
  `;
  const review = rows[0];
  if (!review) throw new ApiError(404, "REVIEW_NOT_FOUND", "Review 不存在。");
  return review;
}

async function recalculateReview(tx: any, reviewId: string) {
  const counts = await tx<any[]>`
    select
      count(*) filter (where review_status = 'approved')::int as approved,
      count(*) filter (where review_status = 'excluded')::int as excluded,
      count(*) filter (where review_status = 'pending')::int as pending
    from work_items where review_id = ${reviewId}
  `;
  const count = counts[0];
  await tx`
    update reviews set
      state = 'IN_PROGRESS', version = version + 1,
      approved_count = ${count.approved}, excluded_count = ${count.excluded}, pending_count = ${count.pending},
      updated_at = now()
    where id = ${reviewId}
  `;
}

export async function reviewRoutes(app: FastifyInstance) {
  app.get("/v1/partner/dashboard", async (request) => {
    const actor = await requireWebActor(request, "partner");
    if (!actor.partnerId)
      throw new ApiError(
        403,
        "PARTNER_REQUIRED",
        "当前账号没有 Partner Profile。",
      );
    const [periodRows, pluginRows, jobRows] = await Promise.all([
      sql<any[]>`
        select * from report_periods
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and status in ('open', 'closed') and starts_at <= now()
        order by (status = 'open') desc, starts_at desc limit 1
      `,
      sql<any[]>`
        select id, device_name, version, status, last_heartbeat_at, last_scan_at, last_sync_at,
          pending_local_jobs, retry_count, last_error_code
        from plugin_instances
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        order by created_at desc limit 1
      `,
      sql<any[]>`
        select id, type, status, attempt_count, error_code, created_at, updated_at
        from agent_jobs
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        order by created_at desc limit 20
      `,
    ]);
    const period = periodRows[0];
    if (!period)
      return {
        period: null,
        plugin: pluginRows[0] ?? null,
        jobs: jobRows,
        review: null,
        report: null,
        coverage: null,
        collection: null,
      };
    const [reviewRows, reportRows, coverageRows, collectionRows] =
      await Promise.all([
        sql<any[]>`
        select r.*, rp.period_key, rp.cutoff_at
        from reviews r
        join report_periods rp on rp.id = r.period_id
        where r.tenant_id = ${actor.tenantId} and r.partner_id = ${actor.partnerId}
        order by rp.starts_at desc, r.created_at desc limit 1
      `,
        sql<any[]>`
        select r.*, v.title, v.summary, v.markdown, rp.period_key
        from individual_reports r
        join report_periods rp on rp.id = r.period_id
        left join individual_report_versions v on v.report_id = r.id and v.version = r.current_version
        where r.tenant_id = ${actor.tenantId} and r.partner_id = ${actor.partnerId}
        order by rp.starts_at desc, r.created_at desc limit 1
      `,
        sql<any[]>`
        select * from coverage_snapshots where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
          and period_id = ${period.id} order by created_at desc limit 1
      `,
        sql<any[]>`
        select count(*)::int as fact_count
        from session_facts
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
          and period_id = ${period.id} and current = true and excluded = false
      `,
      ]);
    return {
      period,
      plugin: pluginRows[0] ?? null,
      jobs: jobRows,
      review: reviewRows[0] ?? null,
      report: reportRows[0] ?? null,
      coverage: coverageRows[0]?.payload ?? null,
      collection: {
        factCount: collectionRows[0]?.fact_count ?? 0,
        cutoffAt: period.cutoff_at,
        state: period.status === "open" ? "COLLECTING" : "CLOSED",
      },
    };
  });

  app.get("/v1/reviews/:id", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const review = await loadReview(actor, id);
    const [items, changes, coverage, snapshot, projects] = await Promise.all([
      sql<any[]>`
        select wi.*, p.name as project_name
        from work_items wi left join projects p on p.id = wi.project_id
        where wi.review_id = ${id} and wi.tenant_id = ${actor.tenantId}
        order by ((wi.payload->'importance'->>'partnerEmphasis')::numeric) desc nulls last, wi.created_at
      `,
      sql<any[]>`
        select * from review_changes where review_id = ${id} and tenant_id = ${actor.tenantId}
        order by created_at desc limit 30
      `,
      sql<any[]>`
        select payload, immutable, created_at from coverage_snapshots
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and period_id = ${review.period_id}
        order by created_at desc limit 1
      `,
      sql<any[]>`
        select id, checksum, approved_at from work_item_snapshots
        where review_id = ${id} and tenant_id = ${actor.tenantId}
        order by created_at desc limit 1
      `,
      sql<any[]>`
        select id, name from projects
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and status = 'active'
        order by name
      `,
    ]);
    return {
      review,
      items,
      changes,
      coverage: coverage[0] ?? null,
      snapshot: snapshot[0] ?? null,
      projects,
    };
  });

  app.post("/v1/reviews/:id/changes/preview", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = reviewChangeRequestSchema.parse(request.body);
    const review = await loadReview(actor, id);
    if (review.state !== "IN_PROGRESS") {
      throw new ApiError(
        409,
        "REVIEW_NOT_EDITABLE",
        "Review 当前不是可编辑状态，请先重新打开事项审核。",
      );
    }
    if (review.version !== input.baseVersion) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Review 已更新，请刷新后重试。",
        { currentVersion: review.version },
      );
    }
    const items = await sql<WorkItemRow[]>`
      select * from work_items
      where review_id = ${id} and tenant_id = ${actor.tenantId} and id = any(${input.workItemIds}::uuid[])
      order by created_at
    `;
    if (items.length !== input.workItemIds.length)
      throw new ApiError(
        404,
        "WORK_ITEM_NOT_FOUND",
        "一个或多个 Work Item 不存在。",
      );

    let after: unknown;
    if (input.operation === "merge") {
      if (items.length < 2)
        throw new ApiError(
          422,
          "MERGE_REQUIRES_MULTIPLE",
          "Merge 至少需要两个 Work Item。",
        );
      const [primary, ...rest] = items;
      if (!primary)
        throw new ApiError(
          422,
          "MERGE_REQUIRES_MULTIPLE",
          "Merge 至少需要两个 Work Item。",
        );
      after = {
        primary: {
          ...primary,
          title: z
            .object({ title: z.string().min(1).max(200) })
            .parse(input.value).title,
          fact_ids: [...new Set(items.flatMap((item) => item.fact_ids))],
          payload: {
            ...primary.payload,
            outcomes: [
              ...new Set(items.flatMap((item) => item.payload.outcomes ?? [])),
            ],
            blockers: [
              ...new Set(items.flatMap((item) => item.payload.blockers ?? [])),
            ],
            nextSteps: [
              ...new Set(items.flatMap((item) => item.payload.nextSteps ?? [])),
            ],
          },
          lineage: {
            ...primary.lineage,
            mergedFrom: rest.map((item) => item.id),
          },
          version: primary.version + 1,
        },
        removedIds: rest.map((item) => item.id),
      };
    } else if (input.operation === "split") {
      const source = items[0];
      if (!source || items.length !== 1)
        throw new ApiError(
          422,
          "SPLIT_REQUIRES_ONE",
          "Split 必须选择一个 Work Item。",
        );
      const split = z
        .object({
          groups: z
            .array(
              z.object({
                title: z.string().min(1).max(200),
                factIds: z.array(z.string().uuid()).min(1),
              }),
            )
            .min(2),
        })
        .parse(input.value);
      const flattened = split.groups.flatMap((group) => group.factIds).sort();
      const expected = [...source.fact_ids].sort();
      if (
        new Set(flattened).size !== flattened.length ||
        JSON.stringify(flattened) !== JSON.stringify(expected)
      ) {
        throw new ApiError(
          422,
          "SPLIT_FACT_MISMATCH",
          "Split 必须且只能分配原 Work Item 的全部 Fact。",
        );
      }
      after = { sourceId: source.id, groups: split.groups };
    } else if (input.operation === "change_period") {
      after = { action: "create_reanalysis_job", scope: input.value };
    } else {
      after = items.map((item) =>
        patchWorkItem(item, input.operation, input.value),
      );
    }

    const changeId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await sql`
      insert into review_changes (
        id, tenant_id, review_id, actor_user_id, operation, source, base_version,
        before_payload, after_payload, expires_at
      ) values (
        ${changeId}, ${actor.tenantId}, ${id}, ${actor.userId}, ${input.operation}, ${input.source},
        ${input.baseVersion}, ${JSON.stringify(items)}::jsonb, ${JSON.stringify(after)}::jsonb, ${expiresAt.toISOString()}
      )
    `;
    await audit(
      request,
      actor,
      "review.change.previewed",
      "review_change",
      changeId,
      { operation: input.operation },
    );
    return {
      changeId,
      operation: input.operation,
      before: items,
      after,
      expiresAt,
      baseVersion: input.baseVersion,
    };
  });

  app.post("/v1/reviews/:id/changes/apply", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { changeId } = z
      .object({ changeId: z.string().uuid() })
      .parse(request.body);
    const review = await loadReview(actor, id);
    if (review.state !== "IN_PROGRESS") {
      throw new ApiError(
        409,
        "REVIEW_NOT_EDITABLE",
        "Review 当前不是可编辑状态，请先重新打开事项审核。",
      );
    }
    const changeRows = await sql<any[]>`
      select * from review_changes
      where id = ${changeId} and review_id = ${id} and tenant_id = ${actor.tenantId}
      limit 1
    `;
    const change = changeRows[0];
    if (!change || new Date(change.expires_at).getTime() < Date.now())
      throw new ApiError(409, "PREVIEW_EXPIRED", "Change Preview 已过期。");
    if (change.status === "applied")
      return { ok: true, version: review.version, idempotent: true };
    if (change.base_version !== review.version)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Review 已更新，请重新 Preview。",
      );

    await sql.begin(async (tx) => {
      if (
        [
          "approve",
          "exclude",
          "restore",
          "update_status",
          "update_fact",
          "set_emphasis",
          "assign_project",
          "add_fact",
        ].includes(change.operation)
      ) {
        for (const item of change.after_payload as WorkItemRow[]) {
          await tx`
            update work_items set
              project_id = ${item.project_id}, title = ${item.title}, status = ${item.status},
              review_status = ${item.review_status}, version = ${item.version}, payload = ${JSON.stringify(item.payload)}::jsonb,
              updated_at = now()
            where id = ${item.id} and tenant_id = ${actor.tenantId} and review_id = ${id}
          `;
        }
      } else if (change.operation === "merge") {
        const merged = change.after_payload as {
          primary: WorkItemRow;
          removedIds: string[];
        };
        const primary = merged.primary;
        await tx`
          update work_items set title = ${primary.title}, fact_ids = ${JSON.stringify(primary.fact_ids)}::jsonb,
            payload = ${JSON.stringify(primary.payload)}::jsonb, lineage = ${JSON.stringify(primary.lineage)}::jsonb,
            version = ${primary.version}, updated_at = now()
          where id = ${primary.id} and tenant_id = ${actor.tenantId}
        `;
        for (const removedId of merged.removedIds) {
          await tx`delete from work_item_facts where work_item_id = ${removedId}`;
          await tx`delete from work_items where id = ${removedId} and tenant_id = ${actor.tenantId}`;
        }
        await tx`delete from work_item_facts where work_item_id = ${primary.id}`;
        for (const factId of primary.fact_ids)
          await tx`insert into work_item_facts (work_item_id, fact_id) values (${primary.id}, ${factId})`;
      } else if (change.operation === "split") {
        const split = change.after_payload as {
          sourceId: string;
          groups: Array<{ title: string; factIds: string[] }>;
        };
        const sourceRows = await tx<
          WorkItemRow[]
        >`select * from work_items where id = ${split.sourceId} and tenant_id = ${actor.tenantId}`;
        const source = sourceRows[0];
        if (!source)
          throw new ApiError(
            404,
            "WORK_ITEM_NOT_FOUND",
            "待拆分 Work Item 不存在。",
          );
        await tx`delete from work_item_facts where work_item_id = ${source.id}`;
        await tx`delete from work_items where id = ${source.id}`;
        for (const group of split.groups) {
          const newId = randomUUID();
          await tx`
            insert into work_items (
              id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
              title, status, fact_ids, payload, lineage
            ) values (
              ${newId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${review.period_id}, ${id},
              ${source.project_id}, ${group.title}, ${source.status}, ${JSON.stringify(group.factIds)}::jsonb,
              ${JSON.stringify(source.payload)}::jsonb, ${JSON.stringify({ splitFrom: source.id })}::jsonb
            )
          `;
          for (const factId of group.factIds)
            await tx`insert into work_item_facts (work_item_id, fact_id) values (${newId}, ${factId})`;
        }
      } else if (change.operation === "change_period") {
        const activePlugins = await tx<any[]>`
          select id from plugin_instances
          where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and status = 'active'
          order by created_at desc limit 1
        `;
        const plugin = activePlugins[0];
        if (!plugin)
          throw new ApiError(
            409,
            "PLUGIN_OFFLINE",
            "没有可领取重新分析任务的活动 Plugin。",
          );
        await tx`
          insert into agent_jobs (
            id, tenant_id, team_id, partner_id, plugin_instance_id, type, idempotency_key, input_payload
          ) values (
            ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${plugin.id}, 'REANALYZE_SESSIONS',
            ${`reanalysis:${id}:${change.id}`}, ${JSON.stringify(change.after_payload)}::jsonb
          )
        `;
      } else {
        throw new ApiError(
          422,
          "OPERATION_UNSUPPORTED",
          `不支持的审核操作: ${change.operation}`,
        );
      }
      await recalculateReview(tx, id);
      if (change.operation === "change_period") {
        await tx`update reviews set state = 'WAITING_LOCAL_REANALYSIS', updated_at = now() where id = ${id}`;
      }
      await tx`update review_changes set status = 'applied', applied_at = now() where id = ${changeId}`;
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (
          ${randomUUID()}, ${actor.tenantId}, 'review.change.applied', 'review', ${id},
          ${JSON.stringify({ changeId, operation: change.operation, source: change.source })}::jsonb
        )
      `;
    });
    const versions = await sql<
      { version: number }[]
    >`select version from reviews where id = ${id}`;
    await audit(
      request,
      actor,
      "review.change.applied",
      "review_change",
      changeId,
      { operation: change.operation },
    );
    return { ok: true, version: versions[0]?.version };
  });

  app.post("/v1/reviews/:id/complete", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { baseVersion } = z
      .object({ baseVersion: z.number().int().positive() })
      .parse(request.body);
    const review = await loadReview(actor, id);
    if (review.state !== "IN_PROGRESS") {
      throw new ApiError(
        409,
        "REVIEW_NOT_EDITABLE",
        "只有进行中的 Review 可以完成审核。",
      );
    }
    if (review.version !== baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Review 已更新，请刷新后重试。",
      );
    const items = await sql<
      any[]
    >`select * from work_items where review_id = ${id} and tenant_id = ${actor.tenantId} order by created_at`;
    if (
      items.length === 0 ||
      items.some((item) => item.review_status === "pending")
    ) {
      throw new ApiError(409, "REVIEW_INCOMPLETE", "仍有未确认的 Work Item。");
    }
    const activeJobs = await sql`
      select 1 from agent_jobs where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and status in ('PENDING', 'LEASED', 'RETRY_WAIT') and type in ('AGGREGATE_WORK_ITEMS', 'REANALYZE_SESSIONS')
      limit 1
    `;
    if (activeJobs.length > 0)
      throw new ApiError(
        409,
        "AGENT_JOB_PENDING",
        "仍有待处理的聚合或重新分析任务。",
      );

    const completedItems = items.filter(
      (item) =>
        item.review_status === "approved" && item.status === "completed",
    );
    for (const item of completedItems) {
      const facts = await sql<any[]>`
        select sf.payload from work_item_facts wf join session_facts sf on sf.id = wf.fact_id
        where wf.work_item_id = ${item.id} and sf.tenant_id = ${actor.tenantId}
      `;
      const hasSupport =
        facts.some(
          (fact) =>
            fact.payload.completionSupport === "evidence" ||
            fact.payload.factOrigin === "partner_supplied",
        ) || (item.payload.partnerFacts ?? []).length > 0;
      if (!hasSupport)
        throw new ApiError(
          409,
          "COMPLETION_EVIDENCE_REQUIRED",
          `完成事项“${item.title}”缺少 Evidence 或 Partner 补充。`,
        );
    }

    const coverageRows = await sql<any[]>`
      select * from coverage_snapshots
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and period_id = ${review.period_id}
      order by created_at desc limit 1
    `;
    const coverage = coverageRows[0];
    if (!coverage)
      throw new ApiError(409, "COVERAGE_MISSING", "缺少 Coverage Snapshot。");
    const payload = {
      reviewId: id,
      reviewVersion: review.version,
      periodId: review.period_id,
      workItems: items.filter((item) => item.review_status === "approved"),
      excludedWorkItemIds: items
        .filter((item) => item.review_status === "excluded")
        .map((item) => item.id),
      coverage: coverage.payload,
    };
    const checksum = stableJsonHash(payload);
    const snapshotId = randomUUID();
    const reportId = randomUUID();
    const activePlugins = await sql<any[]>`
      select id from plugin_instances where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId} and status = 'active'
      order by created_at desc limit 1
    `;
    const plugin = activePlugins[0];
    if (!plugin)
      throw new ApiError(
        409,
        "PLUGIN_OFFLINE",
        "没有可生成 Report 的活动 Plugin。",
      );
    let templates = await sql<any[]>`
      select rt.* from report_periods rp
      join report_templates rt on rt.id = rp.template_id and rt.tenant_id = rp.tenant_id
      where rp.id = ${review.period_id} and rp.tenant_id = ${actor.tenantId} and rp.team_id = ${actor.teamId}
      limit 1
    `;
    if (!templates[0]) {
      templates = await sql<any[]>`
        select * from report_templates where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and is_default = true
        order by version desc limit 1
      `;
    }
    const partners = await sql<
      any[]
    >`select preferences from partners where id = ${actor.partnerId} and tenant_id = ${actor.tenantId}`;

    await sql.begin(async (tx) => {
      await tx`update coverage_snapshots set immutable = true where id = ${coverage.id}`;
      await tx`
        insert into work_item_snapshots (
          id, tenant_id, team_id, partner_id, period_id, review_id, review_version,
          checksum, payload, approved_by, approved_at
        ) values (
          ${snapshotId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${review.period_id},
          ${id}, ${review.version}, ${checksum}, ${JSON.stringify(payload)}::jsonb, ${actor.userId}, now()
        )
      `;
      await tx`update reviews set state = 'ITEMS_APPROVED', updated_at = now() where id = ${id}`;
      await tx`
        insert into individual_reports (
          id, tenant_id, team_id, partner_id, period_id, snapshot_id
        ) values (${reportId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${review.period_id}, ${snapshotId})
      `;
      await tx`
        insert into agent_jobs (
          id, tenant_id, team_id, partner_id, plugin_instance_id, type, idempotency_key, input_payload
        ) values (
          ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, ${plugin.id},
          'GENERATE_INDIVIDUAL_REPORT', ${`report:${snapshotId}:${checksum}`},
          ${JSON.stringify({
            schemaVersion: "1.0",
            reportId,
            snapshotId,
            sourceChecksum: checksum,
            generatorVersion: "partner-report-sync/0.1.0",
            workItems: payload.workItems,
            coverage: coverage.payload,
            template: templates[0] ?? null,
            preferences: partners[0]?.preferences ?? {},
            constraints: {
              claimsRequireWorkItemIds: true,
              noUnsupportedPercentages: true,
            },
          })}::jsonb
        )
      `;
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (
          ${randomUUID()}, ${actor.tenantId}, 'work_items.snapshot.approved', 'work_item_snapshot', ${snapshotId},
          ${JSON.stringify({ reportId, checksum })}::jsonb
        )
      `;
    });
    await audit(
      request,
      actor,
      "work_items.snapshot.approved",
      "work_item_snapshot",
      snapshotId,
      { reportId, checksum },
    );
    return { snapshotId, reportId, checksum };
  });

  app.post("/v1/reviews/:id/reopen", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { baseVersion } = z
      .object({ baseVersion: z.number().int().positive() })
      .parse(request.body);
    const review = await loadReview(actor, id);
    if (review.version !== baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Review 已更新，请刷新后重试。",
      );
    if (review.state !== "ITEMS_APPROVED")
      throw new ApiError(
        409,
        "REVIEW_NOT_REOPENABLE",
        "当前 Review 不能重新打开。",
      );
    const reports = await sql<any[]>`
      select ir.id, ir.status from individual_reports ir
      join work_item_snapshots wis on wis.id = ir.snapshot_id
      where wis.review_id = ${id} and ir.tenant_id = ${actor.tenantId}
      order by ir.created_at desc limit 1
    `;
    const report = reports[0];
    if (report && ["SUBMITTED", "LOCKED"].includes(report.status)) {
      throw new ApiError(
        409,
        "REPORT_LOCKED",
        "Report 已提交，不能重新打开事实审核。",
      );
    }
    await sql.begin(async (tx) => {
      await tx`update reviews set state = 'IN_PROGRESS', version = version + 1, updated_at = now() where id = ${id} and tenant_id = ${actor.tenantId}`;
      if (report)
        await tx`update individual_reports set status = 'RETURNED_TO_ITEMS', updated_at = now() where id = ${report.id} and tenant_id = ${actor.tenantId}`;
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (${randomUUID()}, ${actor.tenantId}, 'review.reopened', 'review', ${id}, ${JSON.stringify({ reportId: report?.id ?? null })}::jsonb)
      `;
    });
    await audit(request, actor, "review.reopened", "review", id, {
      reportId: report?.id ?? null,
    });
    const versions = await sql<
      { version: number }[]
    >`select version from reviews where id = ${id} and tenant_id = ${actor.tenantId}`;
    return { id, state: "IN_PROGRESS", version: versions[0]?.version };
  });
}
