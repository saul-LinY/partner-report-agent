import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  reviewChangeRequestSchema,
  workStatusSchema,
} from "@partner-report/contracts";
import { sqlClient as sql } from "@partner-report/db";
import {
  ApiError,
  audit,
  type DomainActor,
  requireWebActor,
  stableJsonHash,
} from "../common.js";

type WorkItemRow = {
  id: string;
  review_id: string;
  project_id: string | null;
  title: string;
  status: string;
  review_status: string;
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
  return after;
}

async function loadReview(
  actor: Pick<DomainActor, "tenantId" | "partnerId">,
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

async function loadReviewForUpdate(
  tx: any,
  actor: Pick<DomainActor, "tenantId" | "partnerId">,
  reviewId: string,
) {
  if (!actor.partnerId)
    throw new ApiError(
      403,
      "PARTNER_REQUIRED",
      "当前账号没有 Partner Profile。",
    );
  const rows = await tx<any[]>`
    select * from reviews
    where id = ${reviewId} and tenant_id = ${actor.tenantId}
      and partner_id = ${actor.partnerId}
    for update
  `;
  const review = rows[0];
  if (!review) throw new ApiError(404, "REVIEW_NOT_FOUND", "Review 不存在。");
  return review;
}

async function recalculateReview(
  tx: any,
  actor: Pick<DomainActor, "tenantId">,
  reviewId: string,
  expectedVersion?: number,
) {
  const counts = await tx<any[]>`
    select
      count(*) filter (where review_status = 'approved')::int as approved,
      count(*) filter (where review_status = 'excluded')::int as excluded,
      count(*) filter (where review_status = 'pending')::int as pending
    from work_items where review_id = ${reviewId}
  `;
  const count = counts[0];
  const versions =
    expectedVersion === undefined
      ? await tx<{ version: number }[]>`
          update reviews set
            state = 'IN_PROGRESS', version = version + 1,
            approved_count = ${count.approved}, excluded_count = ${count.excluded}, pending_count = ${count.pending},
            updated_at = now()
          where id = ${reviewId} and tenant_id = ${actor.tenantId}
          returning version
        `
      : await tx<{ version: number }[]>`
          update reviews set
            state = 'IN_PROGRESS', version = version + 1,
            approved_count = ${count.approved}, excluded_count = ${count.excluded}, pending_count = ${count.pending},
            updated_at = now()
          where id = ${reviewId} and tenant_id = ${actor.tenantId}
            and state = 'IN_PROGRESS' and version = ${expectedVersion}
          returning version
        `;
  if (!versions[0])
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "审核内容已更新，请刷新后重试。",
    );
  return { ...count, version: versions[0]!.version };
}

export type CompleteReviewResult = {
  ignored?: boolean;
  snapshotId?: string;
  reportId?: string;
  checksum?: string;
  idempotent?: boolean;
};

async function loadCompletedReviewResult(
  db: any,
  actor: Pick<DomainActor, "tenantId">,
  reviewId: string,
): Promise<CompleteReviewResult | null> {
  const reviews = await db<any[]>`
    select state from reviews
    where id = ${reviewId} and tenant_id = ${actor.tenantId}
    limit 1
  `;
  if (reviews[0]?.state === "ITEMS_DISMISSED")
    return { ignored: true, idempotent: true };
  if (reviews[0]?.state !== "ITEMS_APPROVED") return null;
  const existing = await db<any[]>`
    select ir.id as report_id, ir.snapshot_id, wis.checksum
    from individual_reports ir
    join work_item_snapshots wis on wis.id = ir.snapshot_id
    where ir.tenant_id = ${actor.tenantId} and wis.review_id = ${reviewId}
    order by ir.created_at desc limit 1
  `;
  if (!existing[0]) return null;
  return {
    snapshotId: existing[0].snapshot_id,
    reportId: existing[0].report_id,
    checksum: existing[0].checksum,
    idempotent: true,
  };
}

export async function completeReview(
  actor: DomainActor,
  reviewId: string,
  baseVersion: number,
): Promise<CompleteReviewResult> {
  const review = await loadReview(actor, reviewId);
  if (["ITEMS_DISMISSED", "ITEMS_APPROVED"].includes(review.state)) {
    const existing = await loadCompletedReviewResult(sql, actor, reviewId);
    if (existing) return existing;
  }
  if (review.state !== "IN_PROGRESS")
    throw new ApiError(
      409,
      "REVIEW_NOT_EDITABLE",
      "只有进行中的 Review 可以完成审核。",
    );
  if (review.version !== baseVersion)
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Review 已更新，请刷新后重试。",
    );

  const items = await sql<any[]>`
    select * from work_items
    where review_id = ${reviewId} and tenant_id = ${actor.tenantId}
    order by created_at
  `;
  if (
    items.length === 0 ||
    items.some((item) => item.review_status === "pending")
  )
    throw new ApiError(409, "REVIEW_INCOMPLETE", "仍有未确认的 Work Item。");
  const activeJobs = await sql`
    select 1 from agent_jobs where tenant_id = ${actor.tenantId}
      and partner_id = ${actor.partnerId}
      and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
      and type in ('AGGREGATE_WORK_ITEMS', 'REANALYZE_SESSIONS')
    limit 1
  `;
  if (activeJobs.length > 0)
    throw new ApiError(
      409,
      "AGENT_JOB_PENDING",
      "仍有待处理的聚合或重新分析任务。",
    );

  const approvedItems = items.filter(
    (item) => item.review_status === "approved",
  );
  if (approvedItems.length === 0) {
    return sql.begin(async (tx) => {
      const claimed = await tx<{ id: string }[]>`
        update reviews set state = 'ITEMS_DISMISSED', updated_at = now()
        where id = ${reviewId} and tenant_id = ${actor.tenantId}
          and state = 'IN_PROGRESS' and version = ${baseVersion}
        returning id
      `;
      if (!claimed[0]) {
        const existing = await loadCompletedReviewResult(tx, actor, reviewId);
        if (existing) return existing;
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Review 已更新，请刷新后重试。",
        );
      }
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (
          ${randomUUID()}, ${actor.tenantId}, 'work_items.all_dismissed', 'review', ${reviewId},
          ${JSON.stringify({ excludedWorkItemIds: items.map((item) => item.id) })}::jsonb
        )
      `;
      return { ignored: true };
    });
  }

  for (const item of approvedItems.filter(
    (item) => item.status === "completed",
  )) {
    const facts = await sql<any[]>`
      select sf.payload from work_item_facts wf
      join session_facts sf on sf.id = wf.fact_id
      where wf.work_item_id = ${item.id} and sf.tenant_id = ${actor.tenantId}
    `;
    const hasSupport =
      facts.some(
        (fact) =>
          fact.payload.completionSupport === "evidence" ||
          fact.payload.factOrigin === "partner_supplied" ||
          (fact.payload.recordType === "session_contribution" &&
            Array.isArray(fact.payload.contributions) &&
            fact.payload.contributions.some(
              (contribution: Record<string, unknown>) =>
                contribution.kind === "outcome" &&
                contribution.confidence !== "low",
            )),
      ) || (item.payload.partnerFacts ?? []).length > 0;
    if (!hasSupport)
      throw new ApiError(
        409,
        "COMPLETION_EVIDENCE_REQUIRED",
        `完成事项“${item.title}”缺少可信 Outcome 或 Partner 补充。`,
      );
  }

  const coverageRows = await sql<any[]>`
    select * from coverage_snapshots
    where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
      and period_id = ${review.period_id}
    order by created_at desc limit 1
  `;
  const coverage = coverageRows[0];
  if (!coverage)
    throw new ApiError(409, "COVERAGE_MISSING", "缺少 Coverage Snapshot。");

  const payload = {
    reviewId,
    reviewVersion: review.version,
    periodId: review.period_id,
    workItems: approvedItems,
    excludedWorkItemIds: items
      .filter((item) => item.review_status === "excluded")
      .map((item) => item.id),
    coverage: coverage.payload,
  };
  const checksum = stableJsonHash(payload);
  const snapshotId = randomUUID();
  const nextReportId = randomUUID();
  let templates = await sql<any[]>`
    select rt.* from report_periods rp
    join report_templates rt on rt.id = rp.template_id and rt.tenant_id = rp.tenant_id
    where rp.id = ${review.period_id} and rp.tenant_id = ${actor.tenantId}
      and rp.team_id = ${actor.teamId}
    limit 1
  `;
  if (!templates[0])
    templates = await sql<any[]>`
      select * from report_templates
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and is_default = true
      order by version desc limit 1
    `;
  const partners = await sql<any[]>`
    select preferences from partners
    where id = ${actor.partnerId} and tenant_id = ${actor.tenantId}
  `;
  const previousReports = await sql<any[]>`
    select previous_report.id as report_id, previous_report.payload
    from report_periods current_period
    join report_periods previous_period
      on previous_period.tenant_id = current_period.tenant_id
      and previous_period.team_id = current_period.team_id
      and previous_period.starts_at < current_period.starts_at
    join individual_reports previous_report
      on previous_report.period_id = previous_period.id
      and previous_report.tenant_id = current_period.tenant_id
      and previous_report.partner_id = ${actor.partnerId}
      and previous_report.status = 'LOCKED'
    where current_period.id = ${review.period_id}
    order by previous_period.starts_at desc limit 1
  `;

  return sql.begin(async (tx) => {
    const claimed = await tx<{ id: string }[]>`
      update reviews set state = 'ITEMS_APPROVED', updated_at = now()
      where id = ${reviewId} and tenant_id = ${actor.tenantId}
        and state = 'IN_PROGRESS' and version = ${baseVersion}
      returning id
    `;
    if (!claimed[0]) {
      const existing = await loadCompletedReviewResult(tx, actor, reviewId);
      if (existing) return existing;
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Review 已更新，请刷新后重试。",
      );
    }
    await tx`update coverage_snapshots set immutable = true where id = ${coverage.id}`;
    for (const item of approvedItems) {
      const candidateId = item.payload.projectDescriptionCandidateId;
      const description = item.payload.projectDescription;
      const sourceFingerprint =
        item.payload.projectDescriptionSourceFingerprint;
      if (
        !item.project_id ||
        typeof description !== "string" ||
        !description.trim() ||
        typeof sourceFingerprint !== "string"
      )
        continue;
      if (typeof candidateId === "string") {
        const promoted = await tx<{ id: string }[]>`
          update project_description_candidates set
            description = ${description.trim()}, status = 'approved',
            reviewed_at = now(), updated_at = now()
          where id = ${candidateId} and tenant_id = ${actor.tenantId}
            and partner_id = ${actor.partnerId} and project_id = ${item.project_id}
            and status = 'pending'
          returning id
        `;
        if (!promoted[0]) continue;
      }
      await tx`
        update projects set description = ${description.trim()},
          description_source_fingerprint = ${sourceFingerprint},
          description_updated_at = now(), updated_at = now()
        where id = ${item.project_id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId}
          and (
            description is distinct from ${description.trim()}
            or description_source_fingerprint is distinct from ${sourceFingerprint}
          )
      `;
      await tx`
        update project_description_candidates set status = 'superseded',
          reviewed_at = now(), updated_at = now()
        where tenant_id = ${actor.tenantId} and project_id = ${item.project_id}
          and (${typeof candidateId === "string" ? candidateId : null}::uuid is null
            or id <> ${typeof candidateId === "string" ? candidateId : null})
          and status = 'pending'
      `;
    }
    await tx`
      insert into work_item_snapshots (
        id, tenant_id, team_id, partner_id, period_id, review_id, review_version,
        checksum, payload, approved_by, approved_by_actor_type,
        approved_by_actor_id, approved_at
      ) values (
        ${snapshotId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
        ${review.period_id}, ${reviewId}, ${review.version}, ${checksum},
        ${JSON.stringify(payload)}::jsonb, ${actor.userId}, ${actor.actorType},
        ${actor.actorId}, now()
      )
    `;
    const reportRows = await tx<{ id: string }[]>`
      insert into individual_reports (
        id, tenant_id, team_id, partner_id, period_id, snapshot_id,
        status, source_checksum
      ) values (
        ${nextReportId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId},
        ${review.period_id}, ${snapshotId}, 'REPORT_DRAFT', ${checksum}
      )
      on conflict (tenant_id, partner_id, period_id) do update set
        team_id = excluded.team_id,
        snapshot_id = excluded.snapshot_id,
        status = 'REPORT_DRAFT',
        title = null,
        summary = null,
        markdown = null,
        payload = null,
        preferences = '{}'::jsonb,
        source_checksum = excluded.source_checksum,
        generator_version = null,
        submitted_at = null,
        locked_at = null,
        updated_at = now()
      returning id
    `;
    const reportId = reportRows[0]!.id;
    await tx`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, plugin_instance_id, type,
        idempotency_key, input_payload
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, null,
        'GENERATE_INDIVIDUAL_REPORT', ${`report:${snapshotId}:${checksum}`},
        ${JSON.stringify({
          schemaVersion: "1.0",
          reportId,
          snapshotId,
          sourceChecksum: checksum,
          generatorVersion: "partner-report-platform/0.3.0",
          workItems: payload.workItems,
          coverage: coverage.payload,
          template: templates[0] ?? null,
          preferences: partners[0]?.preferences ?? {},
          previousReport: previousReports[0] ?? null,
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
        ${randomUUID()}, ${actor.tenantId}, 'work_items.snapshot.approved',
        'work_item_snapshot', ${snapshotId},
        ${JSON.stringify({ reportId, checksum })}::jsonb
      )
    `;
    return { snapshotId, reportId, checksum };
  });
}

export type RegenerateReviewWorkItemCommand = {
  reviewId: string;
  workItemId: string;
  instruction: string;
  baseVersion: number;
};

const regenerateReviewWorkItemCommandSchema = z
  .object({
    reviewId: z.string().uuid(),
    workItemId: z.string().uuid(),
    instruction: z.string().trim().min(2).max(1200),
    baseVersion: z.number().int().positive(),
  })
  .strict();

export async function regenerateReviewWorkItem(
  actor: DomainActor,
  command: RegenerateReviewWorkItemCommand,
) {
  const { reviewId, workItemId, instruction, baseVersion } =
    regenerateReviewWorkItemCommandSchema.parse(command);
  return sql.begin(async (tx) => {
    const review = await loadReviewForUpdate(tx, actor, reviewId);
    if (review.state !== "IN_PROGRESS")
      throw new ApiError(409, "REVIEW_NOT_EDITABLE", "当前审核不能修改。");
    if (review.version !== baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "审核内容已更新，请刷新后重试。",
      );

    const itemRows = await tx<any[]>`
      select wi.*, p.name as project_name
      from work_items wi left join projects p on p.id = wi.project_id
      where wi.id = ${workItemId} and wi.review_id = ${reviewId}
        and wi.tenant_id = ${actor.tenantId}
      limit 1
      for update of wi
    `;
    const item = itemRows[0];
    if (!item)
      throw new ApiError(404, "WORK_ITEM_NOT_FOUND", "工作卡片不存在。");
    const pendingJobs = await tx<any[]>`
      select id from agent_jobs
      where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
        and type = 'AGGREGATE_WORK_ITEMS'
        and input_payload->>'targetWorkItemId' = ${workItemId}
        and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
      limit 1
    `;
    if (pendingJobs[0])
      throw new ApiError(409, "REGENERATION_PENDING", "这张卡片正在重新生成。");

    const facts = await tx<any[]>`
      select sf.id, sf.payload, sf.source_occurred_at
      from work_item_facts wf
      join session_facts sf on sf.id = wf.fact_id and sf.tenant_id = ${actor.tenantId}
      where wf.work_item_id = ${workItemId}
      order by sf.source_occurred_at nulls last, sf.created_at, sf.id
    `;
    if (facts.length === 0)
      throw new ApiError(
        409,
        "PROJECT_CARD_EMPTY",
        "这张卡片没有可用于重新生成的贡献。",
      );

    const projectKey =
      item.payload.projectKey ??
      (item.project_id ? `project:${item.project_id}` : `work-item:${item.id}`);
    const jobId = randomUUID();
    const projectBucket = {
      projectKey,
      projectId: item.project_id,
      projectName: item.project_name ?? item.title,
      projectDescription:
        typeof item.payload.projectDescription === "string"
          ? item.payload.projectDescription
          : "",
      projectDescriptionCandidateId:
        item.payload.projectDescriptionCandidateId ?? null,
      projectDescriptionSourceFingerprint:
        item.payload.projectDescriptionSourceFingerprint ?? null,
      factIds: facts.map((fact) => fact.id),
      facts,
    };
    await tx`
      update work_items set review_status = 'pending', updated_at = now()
      where id = ${workItemId} and review_id = ${reviewId}
        and tenant_id = ${actor.tenantId}
    `;
    const completion = await recalculateReview(
      tx,
      actor,
      reviewId,
      review.version,
    );
    await tx`
      insert into agent_jobs (
        id, tenant_id, team_id, partner_id, plugin_instance_id,
        type, idempotency_key, input_payload
      ) values (
        ${jobId}, ${actor.tenantId}, ${actor.teamId}, ${actor.partnerId}, null,
        'AGGREGATE_WORK_ITEMS',
        ${`project-card-regeneration:${workItemId}:${review.version}:${stableJsonHash(instruction)}`},
        ${JSON.stringify({
          schemaVersion: "1.0",
          aggregationMode: "project_card_regeneration",
          reviewId,
          targetWorkItemId: workItemId,
          period: { id: review.period_id },
          projectBuckets: [projectBucket],
          reviewInstruction: instruction,
        })}::jsonb
      )
    `;
    await tx`
      insert into outbox_events (
        id, tenant_id, event_type, aggregate_type, aggregate_id, payload
      ) values (
        ${randomUUID()}, ${actor.tenantId}, 'work_item.regeneration.requested',
        'review', ${reviewId},
        ${JSON.stringify({
          itemId: workItemId,
          jobId,
          version: completion.version,
        })}::jsonb
      )
    `;
    return { jobId, status: "PENDING" as const, version: completion.version };
  });
}

export type DecideReviewWorkItemCommand = {
  reviewId: string;
  workItemId: string;
  decision: "approve" | "exclude";
  baseVersion: number;
};

const decideReviewWorkItemCommandSchema = z
  .object({
    reviewId: z.string().uuid(),
    workItemId: z.string().uuid(),
    decision: z.enum(["approve", "exclude"]),
    baseVersion: z.number().int().positive(),
  })
  .strict();

export async function decideReviewWorkItem(
  actor: DomainActor,
  command: DecideReviewWorkItemCommand,
) {
  const { reviewId, workItemId, decision, baseVersion } =
    decideReviewWorkItemCommandSchema.parse(command);
  const targetStatus = decision === "approve" ? "approved" : "excluded";
  const result = await sql.begin(async (tx) => {
    const review = await loadReviewForUpdate(tx, actor, reviewId);
    const items = await tx<{ id: string; review_status: string }[]>`
      select id, review_status from work_items
      where id = ${workItemId} and review_id = ${reviewId}
        and tenant_id = ${actor.tenantId}
      for update
    `;
    const item = items[0];
    if (!item)
      throw new ApiError(404, "WORK_ITEM_NOT_FOUND", "工作卡片不存在。");

    if (item.review_status === targetStatus) {
      const snapshots =
        review.state === "IN_PROGRESS" && review.pending_count === 0
          ? await tx`
              select 1 from work_item_snapshots
              where review_id = ${reviewId} and tenant_id = ${actor.tenantId}
              limit 1
            `
          : [];
      return {
        version: review.version,
        pending: review.pending_count,
        state: review.state,
        hasSnapshot: snapshots.length > 0,
        decisionApplied: false,
      };
    }
    if (review.state !== "IN_PROGRESS")
      throw new ApiError(409, "REVIEW_NOT_EDITABLE", "当前审核不能修改。");
    if (review.version !== baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "审核内容已更新，请刷新后重试。",
      );
    if (item.review_status !== "pending")
      throw new ApiError(
        409,
        "WORK_ITEM_NOT_PENDING",
        "这张工作卡片已经处理。",
      );

    const updated = await tx<{ id: string }[]>`
      update work_items set
        review_status = ${targetStatus}, updated_at = now()
      where id = ${workItemId} and review_id = ${reviewId}
        and tenant_id = ${actor.tenantId} and review_status = 'pending'
      returning id
    `;
    if (!updated[0])
      throw new ApiError(
        409,
        "WORK_ITEM_NOT_PENDING",
        "这张工作卡片已经处理。",
      );
    const completion = await recalculateReview(
      tx,
      actor,
      reviewId,
      review.version,
    );
    await tx`
      insert into outbox_events (
        id, tenant_id, event_type, aggregate_type, aggregate_id, payload
      ) values (
        ${randomUUID()}, ${actor.tenantId}, 'work_item.review.changed',
        'review', ${reviewId},
        ${JSON.stringify({
          itemId: workItemId,
          decision,
          version: completion.version,
        })}::jsonb
      )
    `;
    return {
      ...completion,
      state: review.state,
      hasSnapshot: false,
      decisionApplied: true,
    };
  });

  const finalized =
    result.pending === 0 &&
    (result.decisionApplied ||
      ["ITEMS_APPROVED", "ITEMS_DISMISSED"].includes(result.state) ||
      !result.hasSnapshot)
      ? await completeReview(actor, reviewId, result.version)
      : null;
  return {
    version: result.version,
    decisionApplied: result.decisionApplied,
    finalized,
  };
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
        select r.*, rp.period_key
        from individual_reports r
        join report_periods rp on rp.id = r.period_id
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
          and period_id = ${period.id} and excluded = false
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
    const [items, regenerationJobs] = await Promise.all([
      sql<any[]>`
        select wi.*, p.name as project_name
        from work_items wi left join projects p on p.id = wi.project_id
        where wi.review_id = ${id} and wi.tenant_id = ${actor.tenantId}
        order by lower(coalesce(p.name, wi.title)), wi.created_at
      `,
      sql<any[]>`
        select id, status, error_code, error_message, input_payload->>'targetWorkItemId' as work_item_id
        from agent_jobs
        where tenant_id = ${actor.tenantId} and partner_id = ${actor.partnerId}
          and type = 'AGGREGATE_WORK_ITEMS'
          and input_payload->>'reviewId' = ${id}
          and input_payload ? 'targetWorkItemId'
        order by created_at desc limit 30
      `,
    ]);
    return {
      review,
      items,
      regenerationJobs,
    };
  });

  app.post("/v1/reviews/:id/items/:workItemId/regenerate", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id, workItemId } = z
      .object({ id: z.string().uuid(), workItemId: z.string().uuid() })
      .parse(request.params);
    const input = z
      .object({
        instruction: z.string().trim().min(2).max(1200),
        baseVersion: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    const result = await regenerateReviewWorkItem(actor, {
      reviewId: id,
      workItemId,
      ...input,
    });
    await audit(
      request,
      actor,
      "project_card.regeneration_requested",
      "work_item",
      workItemId,
      {
        jobId: result.jobId,
      },
    );
    return result;
  });

  app.post("/v1/reviews/:id/items/:workItemId/decision", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id, workItemId } = z
      .object({ id: z.string().uuid(), workItemId: z.string().uuid() })
      .parse(request.params);
    const input = z
      .object({
        decision: z.enum(["approve", "exclude"]),
        baseVersion: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    const result = await decideReviewWorkItem(actor, {
      reviewId: id,
      workItemId,
      ...input,
    });
    if (result.decisionApplied)
      await audit(
        request,
        actor,
        `project_card.${input.decision}d`,
        "work_item",
        workItemId,
      );
    if (result.finalized && !result.finalized.idempotent) {
      await audit(
        request,
        actor,
        result.finalized.ignored
          ? "work_items.all_dismissed"
          : "work_items.snapshot.approved",
        result.finalized.ignored ? "review" : "work_item_snapshot",
        result.finalized.ignored ? id : result.finalized.snapshotId!,
        result.finalized.ignored
          ? undefined
          : {
              reportId: result.finalized.reportId,
              checksum: result.finalized.checksum,
            },
      );
    }
    return {
      version: result.version,
      ...(!result.decisionApplied ? { idempotent: true } : {}),
      ...result.finalized,
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

    const applyResult = await sql.begin(async (tx) => {
      const lockedReview = await loadReviewForUpdate(tx, actor, id);
      const lockedChanges = await tx<any[]>`
        select status, base_version from review_changes
        where id = ${changeId} and review_id = ${id}
          and tenant_id = ${actor.tenantId}
        for update
      `;
      const lockedChange = lockedChanges[0];
      if (lockedChange?.status === "applied")
        return {
          version: lockedReview.version,
          pending: lockedReview.pending_count,
          idempotent: true,
        };
      if (
        !lockedChange ||
        lockedChange.base_version !== lockedReview.version ||
        lockedReview.state !== "IN_PROGRESS"
      )
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Review 已更新，请重新 Preview。",
        );
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
              review_status = ${item.review_status}, payload = ${JSON.stringify(item.payload)}::jsonb,
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
            updated_at = now()
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
      const completion = await recalculateReview(
        tx,
        actor,
        id,
        lockedReview.version,
      );
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
      return { ...completion, idempotent: false };
    });
    if (applyResult.idempotent)
      return { ok: true, version: applyResult.version, idempotent: true };
    await audit(
      request,
      actor,
      "review.change.applied",
      "review_change",
      changeId,
      { operation: change.operation },
    );
    const finalized =
      applyResult.pending === 0
        ? await completeReview(actor, id, applyResult.version)
        : null;
    return { ok: true, version: applyResult.version, ...finalized };
  });

  app.post("/v1/reviews/:id/complete", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { baseVersion } = z
      .object({ baseVersion: z.number().int().positive() })
      .parse(request.body);
    const result = await completeReview(actor, id, baseVersion);
    if (!result.idempotent)
      await audit(
        request,
        actor,
        result.ignored
          ? "work_items.all_dismissed"
          : "work_items.snapshot.approved",
        result.ignored ? "review" : "work_item_snapshot",
        result.ignored ? id : result.snapshotId!,
        result.ignored
          ? undefined
          : { reportId: result.reportId, checksum: result.checksum },
      );
    return result;
  });
  app.post("/v1/reviews/:id/reopen", async (request) => {
    const actor = await requireWebActor(request, "partner");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { baseVersion } = z
      .object({ baseVersion: z.number().int().positive() })
      .parse(request.body);
    const result = await sql.begin(async (tx) => {
      const review = await loadReviewForUpdate(tx, actor, id);
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

      const reports = await tx<any[]>`
        select ir.id, ir.status from individual_reports ir
        join work_item_snapshots wis
          on wis.id = ir.snapshot_id and wis.tenant_id = ir.tenant_id
          and wis.team_id = ir.team_id and wis.partner_id = ir.partner_id
        where wis.review_id = ${id} and ir.tenant_id = ${actor.tenantId}
          and ir.team_id = ${actor.teamId} and ir.partner_id = ${actor.partnerId}
        order by ir.created_at desc limit 1
        for update of ir
      `;
      const report = reports[0];
      if (report && ["SUBMITTED", "LOCKED"].includes(report.status))
        throw new ApiError(
          409,
          "REPORT_LOCKED",
          "Report 已提交，不能重新打开事实审核。",
        );

      const versions = await tx<Array<{ version: number }>>`
        update reviews set
          state = 'IN_PROGRESS', version = version + 1, updated_at = now()
        where id = ${id} and tenant_id = ${actor.tenantId}
          and team_id = ${actor.teamId} and partner_id = ${actor.partnerId}
          and state = 'ITEMS_APPROVED' and version = ${baseVersion}
        returning version
      `;
      if (!versions[0])
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Review 已更新，请刷新后重试。",
        );
      if (report) {
        const returned = await tx<Array<{ id: string }>>`
          update individual_reports set
            status = 'RETURNED_TO_ITEMS', updated_at = now()
          where id = ${report.id} and tenant_id = ${actor.tenantId}
            and team_id = ${actor.teamId} and partner_id = ${actor.partnerId}
            and status not in ('SUBMITTED', 'LOCKED')
          returning id
        `;
        if (!returned[0])
          throw new ApiError(
            409,
            "REPORT_LOCKED",
            "Report 已提交，不能重新打开事实审核。",
          );
      }
      await tx`
        insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
        values (${randomUUID()}, ${actor.tenantId}, 'review.reopened', 'review', ${id}, ${JSON.stringify({ reportId: report?.id ?? null })}::jsonb)
      `;
      return {
        reportId: typeof report?.id === "string" ? report.id : null,
        version: versions[0].version,
      };
    });
    await audit(request, actor, "review.reopened", "review", id, {
      reportId: result.reportId,
    });
    return { id, state: "IN_PROGRESS", version: result.version };
  });
}
