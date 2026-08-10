import { randomUUID } from "node:crypto";
import {
  aggregationResultSchema,
  assertChineseTeamReport,
  assertReportSemantics,
  assertTeamReportSemantics,
  individualReportResultSchema,
  teamReportGenerationResultSchema,
  teamReportResultSchema,
} from "@partner-report/contracts";
import { centralModelIdSchema } from "@partner-report/contracts/models";
import { sqlClient as sql } from "@partner-report/db";
import {
  generateStructured,
  ModelRequestTimeoutError,
  modelGatewayConfigured,
  modelRequestTimeoutMs,
} from "./model.js";

type Job = {
  id: string;
  tenant_id: string;
  team_id: string;
  partner_id: string | null;
  type: string;
  input_payload: any;
  attempt_count: number;
  max_attempts: number;
  created_at: Date | string;
};

const aggregationInstructions = (model: string) =>
  `You generate one reviewable Project Work Card for every supplied projectBuckets entry. Return exactly one group for every projectKey and never merge, split, rename, add, or omit a project. Write a concise overview of the project's progress across the period, then dailyProgress entries in ascending YYYY-MM-DD order. Combine contributions from the same date into one entry. Treat reviewInstruction, when present, as a requested correction to the card, but never add facts not supported by the supplied bucket. Preserve uncertainty. Mark work completed only when the supplied contributions support completion. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-04.project-card.v1","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const reportInstructions = (model: string) =>
  `You generate an individual Partner report from an approved immutable Work Item Snapshot. When currentReport and reviewInstruction are supplied, revise the current report according to that natural-language instruction while keeping every statement grounded in the approved Work Items. Use previousReport only to compare prior state with current approved Work Items. Include each of the seven required sections exactly once. Every current factual claim must cite one or more allowed Work Item IDs. Never alter facts merely to satisfy a wording request. State coverage limits plainly and do not invent percentages. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-04.individual-review.v1","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const teamReportInstructions = (
  model: string,
  allowedIndividualReportIds: string[],
) =>
  `Generate a Chinese Team Report strictly from the locked current-period reports in individualReports. Write the summary and all section prose in Chinese; preserve original project names, product names, people names, and technical identifiers when needed. These reports are the sole source of current-period facts: never use project master data, Session Facts, assumptions, or general knowledge.

Include exactly three sections in this order: summary, project_progress, risks. Do not create coverage or next-priorities sections.

The top-level summary field is the short introduction displayed directly below the report title. Write it as one concise Chinese prose paragraph that synthesizes the team's main work and outcomes for the week. Do not enumerate projects or people separately. Do not use bullets, numbered lists, headings, or line breaks.

In summary, do not write an opening narrative paragraph or combine all projects into one prose block. Organize the entire section by project as a Markdown bullet list: create one top-level bullet for every represented project, then add nested bullets for every person who contributed to that project. Each person bullet must state their concrete work, result, decision, or blocker for that project. This section is the project-first inverse index of project_progress, and it must not omit any represented project or contributor.

In project_progress, group content by concrete Partner/person first, using the supplied partnerName when present and partnerId only as a fallback. Under each person, organize their work by project and describe concrete work, deliverables, decisions, validation results, and blockers directly. Do not start a project entry with phrases such as "当前状态为" or "状态为". Do not expose raw status enum identifiers such as awaiting_validation, in_progress, or completed. When status is materially relevant, express it naturally in Chinese after the concrete work, for example "已完成" or "待验证", and only when supported by the report. Do not start project_progress with project-level headings, do not merge people, and do not omit any Partner/project contribution.

Include risks only when supported by the current individual reports and state plainly when none were reported. previousTeamReport is null for the first report. When it is present, it is exactly the immediately preceding period's final Team Report and may only support progress comparisons; never copy its prior-period work into the current period or use it to introduce an uncited current fact. Every current factual claim must cite one or more supplied individual report IDs. In every claim's individualReportIds, copy only exact values from individualReports[].reportId. For this request, the complete allowlist is ${JSON.stringify(allowedIndividualReportIds)}. Every individualReportId must be copied exactly from this allowlist. Never use the top-level reportId, partnerId, project IDs, Work Item IDs, or any other identifier as an individualReportId.

Return section content only; the service assembles the top-level title and markdown deterministically. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-10.team.v8","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const teamReportSectionTitles = {
  summary: "本周团队工作摘要",
  project_progress: "项目与人员工作明细",
  risks: "风险与阻塞",
} as const;

export function formatReportDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function normalizeTeamReportSummary(summary: string) {
  return summary
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function finalizeTeamReport(result: any, reportDate: string) {
  const sections = result.sections.map((section: any) => ({
    ...section,
    title:
      teamReportSectionTitles[
        section.key as keyof typeof teamReportSectionTitles
      ],
  }));
  return {
    ...result,
    title: `团队周报 ${reportDate}`,
    summary: normalizeTeamReportSummary(result.summary),
    production: {
      ...result.production,
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-10.team.v8",
      schemaVersion: "1.0",
      producer: "data-platform",
    },
    sections,
    markdown: sections
      .map(
        (section: any) =>
          `## ${section.title}\n\n${section.markdown.trim() || "个人 Report 未提供相关内容。"}`,
      )
      .join("\n\n"),
  };
}

async function selectedTeamSettingsFor(job: Job) {
  const rows = await sql<{ central_model: string; timezone: string }[]>`
    select central_model, timezone from teams
    where id = ${job.team_id} and tenant_id = ${job.tenant_id}
    limit 1
  `;
  if (!rows[0]) throw new Error("TEAM_NOT_FOUND");
  return {
    model: centralModelIdSchema.parse(rows[0].central_model),
    timezone: rows[0].timezone,
  };
}

async function leaseNextJob(onlyTenantId?: string) {
  const leaseMs = modelRequestTimeoutMs() + 60_000;
  return sql.begin(async (tx) => {
    const rows = await tx<Job[]>`
      select * from agent_jobs
      where status in ('PENDING', 'RETRY_WAIT')
        and (${onlyTenantId ?? null}::uuid is null or tenant_id = ${onlyTenantId ?? null})
        and type in (
          'AGGREGATE_WORK_ITEMS', 'GENERATE_INDIVIDUAL_REPORT',
          'REGENERATE_INDIVIDUAL_REPORT', 'GENERATE_TEAM_REPORT',
          'REGENERATE_TEAM_REPORT'
        )
        and attempt_count < max_attempts
        and (status = 'PENDING' or updated_at < now() - interval '1 minute')
      order by created_at asc
      for update skip locked limit 1
    `;
    const job = rows[0];
    if (!job) return null;
    await tx`
      update agent_jobs set status = 'LEASED', attempt_count = attempt_count + 1,
        lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where id = ${job.id}
    `;
    return { ...job, attempt_count: job.attempt_count + 1 };
  });
}

function validateAggregation(job: Job, output: unknown) {
  const result = aggregationResultSchema.parse(output);
  const buckets = new Map<string, any>(
    job.input_payload.projectBuckets.map((bucket: any) => [
      bucket.projectKey,
      bucket,
    ]),
  );
  const used = new Set<string>();
  for (const group of result.groups) {
    if (!buckets.has(group.projectKey))
      throw new Error(`UNKNOWN_PROJECT_BUCKET:${group.projectKey}`);
    if (used.has(group.projectKey))
      throw new Error(`DUPLICATE_PROJECT_BUCKET:${group.projectKey}`);
    used.add(group.projectKey);
    const dates = group.dailyProgress.map((entry: any) => entry.date);
    if (new Set(dates).size !== dates.length)
      throw new Error(`DUPLICATE_PROGRESS_DATE:${group.projectKey}`);
    if (JSON.stringify(dates) !== JSON.stringify([...dates].sort()))
      throw new Error(`UNSORTED_DAILY_PROGRESS:${group.projectKey}`);
  }
  for (const projectKey of buckets.keys())
    if (!used.has(projectKey))
      throw new Error(`PROJECT_BUCKET_MISSING:${projectKey}`);
  return result;
}

function projectCardPayload(group: any) {
  return {
    projectKey: group.projectKey,
    overview: group.overview,
    dailyProgress: group.dailyProgress,
  };
}

async function applyAggregation(job: Job, output: unknown) {
  const result = validateAggregation(job, output);
  const reviewId = job.input_payload.reviewId as string;
  const targetWorkItemId = job.input_payload.targetWorkItemId as
    string | undefined;
  if (targetWorkItemId) {
    const group = result.groups[0];
    const bucket = job.input_payload.projectBuckets[0];
    if (!group || !bucket || result.groups.length !== 1)
      throw new Error("PROJECT_CARD_REGENERATION_INVALID");
    await sql.begin(async (tx) => {
      const updated = await tx<{ id: string }[]>`
        update work_items set
          project_id = ${bucket.projectId}, title = ${bucket.projectName},
          status = ${group.status}, review_status = 'pending',
          fact_ids = ${JSON.stringify(bucket.factIds)}::jsonb,
          payload = ${JSON.stringify(projectCardPayload(group))}::jsonb,
          updated_at = now()
        where id = ${targetWorkItemId} and tenant_id = ${job.tenant_id}
          and review_id = ${reviewId}
        returning id
      `;
      if (!updated[0]) throw new Error("PROJECT_CARD_NOT_FOUND");
      await tx`delete from work_item_facts where work_item_id = ${targetWorkItemId}`;
      for (const factId of bucket.factIds) {
        await tx`insert into work_item_facts (work_item_id, fact_id) values (${targetWorkItemId}, ${factId})`;
      }
      const counts = await tx<any[]>`
        select
          count(*) filter (where review_status = 'approved')::int as approved,
          count(*) filter (where review_status = 'excluded')::int as excluded,
          count(*) filter (where review_status = 'pending')::int as pending
        from work_items where review_id = ${reviewId}
      `;
      await tx`
        update reviews set state = 'IN_PROGRESS', version = version + 1,
          approved_count = ${counts[0].approved}, excluded_count = ${counts[0].excluded},
          pending_count = ${counts[0].pending}, updated_at = now()
        where id = ${reviewId} and tenant_id = ${job.tenant_id}
      `;
      await tx`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${randomUUID()}, ${job.tenant_id}, 'work_items.draft.created', 'review', ${reviewId},
          ${JSON.stringify({
            count: 1,
            targetWorkItemId,
            regenerated: true,
            warnings: result.qualityWarnings,
          })}::jsonb
        )
      `;
    });
    return result;
  }
  const existing = await sql<{ review_status: string }[]>`
    select review_status from work_items where tenant_id = ${job.tenant_id} and review_id = ${reviewId}
  `;
  if (existing.some((item) => item.review_status !== "pending"))
    throw new Error("REVIEW_ALREADY_STARTED");
  await sql.begin(async (tx) => {
    await tx`delete from work_item_facts where work_item_id in (select id from work_items where review_id = ${reviewId})`;
    await tx`delete from work_items where review_id = ${reviewId}`;
    for (const group of result.groups) {
      const bucket = job.input_payload.projectBuckets.find(
        (candidate: any) => candidate.projectKey === group.projectKey,
      );
      if (!bucket)
        throw new Error(`PROJECT_BUCKET_MISSING:${group.projectKey}`);
      const workItemId = randomUUID();
      const payload = projectCardPayload(group);
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
          title, status, fact_ids, payload
        ) values (
          ${workItemId}, ${job.tenant_id}, ${job.team_id}, ${job.partner_id},
          ${job.input_payload.period.id}, ${reviewId}, ${bucket.projectId},
          ${bucket.projectName}, ${group.status}, ${JSON.stringify(bucket.factIds)}::jsonb,
          ${JSON.stringify(payload)}::jsonb
        )
      `;
      for (const factId of bucket.factIds) {
        await tx`insert into work_item_facts (work_item_id, fact_id) values (${workItemId}, ${factId})`;
      }
    }
    await tx`
      update reviews set state = 'IN_PROGRESS', version = version + 1,
        approved_count = 0, excluded_count = 0, pending_count = ${result.groups.length}, updated_at = now()
      where id = ${reviewId} and tenant_id = ${job.tenant_id}
    `;
    await tx`
      insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values (${randomUUID()}, ${job.tenant_id}, 'work_items.draft.created', 'review', ${reviewId},
        ${JSON.stringify({ count: result.groups.length, warnings: result.qualityWarnings })}::jsonb)
    `;
  });
  return result;
}

async function applyReport(job: Job, output: unknown, model: string) {
  const result = individualReportResultSchema.parse(output);
  assertReportSemantics(result);
  const allowed = new Set<string>(
    job.input_payload.workItems.map((item: any) => item.id),
  );
  for (const section of result.sections)
    for (const claim of section.claims) {
      for (const id of claim.workItemIds)
        if (!allowed.has(id))
          throw new Error(`UNKNOWN_WORK_ITEM_REFERENCE:${id}`);
    }
  await sql.begin(async (tx) => {
    const updated = await tx<{ content_revision: number }[]>`
      update individual_reports set
        status = 'REPORT_REVIEW', content_revision = content_revision + 1,
        title = ${result.title}, summary = ${result.summary},
        markdown = ${result.markdown}, payload = ${JSON.stringify(result)}::jsonb,
        preferences = ${JSON.stringify(job.input_payload.preferences ?? {})}::jsonb,
        source_checksum = ${job.input_payload.sourceChecksum},
        generator_version = ${`partner-report-platform/0.2.0 (${model})`},
        updated_at = now()
      where id = ${job.input_payload.reportId} and tenant_id = ${job.tenant_id}
        and status not in ('SUBMITTED', 'LOCKED')
        and (source_checksum = ${job.input_payload.sourceChecksum} or source_checksum is null)
      returning content_revision
    `;
    if (!updated[0]) throw new Error("REPORT_NOT_EDITABLE");
    await tx`
      insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values (${randomUUID()}, ${job.tenant_id}, 'individual_report.draft.created', 'individual_report', ${job.input_payload.reportId},
        ${JSON.stringify({ contentRevision: updated[0].content_revision, warnings: result.qualityWarnings })}::jsonb)
    `;
  });
  return result;
}

async function applyTeamReport(
  job: Job,
  output: unknown,
  model: string,
  timezone: string,
) {
  const generated = teamReportGenerationResultSchema.parse(output);
  const reportDate = formatReportDate(new Date(job.created_at), timezone);
  const result = teamReportResultSchema.parse(
    finalizeTeamReport(generated, reportDate),
  );
  assertTeamReportSemantics(result);
  assertChineseTeamReport(result);
  const allowed = new Set<string>(
    job.input_payload.individualReports.map((report: any) => report.reportId),
  );
  for (const section of result.sections)
    for (const claim of section.claims)
      for (const id of claim.individualReportIds)
        if (!allowed.has(id))
          throw new Error(`UNKNOWN_INDIVIDUAL_REPORT_REFERENCE:${id}`);
  const expectedMissing = [...job.input_payload.missingPartnerIds].sort();
  if (
    JSON.stringify([...result.missingPartnerIds].sort()) !==
    JSON.stringify(expectedMissing)
  )
    throw new Error("TEAM_REPORT_MISSING_PARTNERS_MISMATCH");
  const reports = await sql<any[]>`
    select * from team_reports where id = ${job.input_payload.reportId}
      and tenant_id = ${job.tenant_id} limit 1
  `;
  const report = reports[0];
  if (!report || report.status === "LOCKED")
    throw new Error("TEAM_REPORT_NOT_EDITABLE");
  const version = report.current_version + 1;
  await sql.begin(async (tx) => {
    await tx`
      insert into team_report_versions (
        id, tenant_id, report_id, version, title, summary, markdown, payload,
        source_checksum, generator_version
      ) values (
        ${randomUUID()}, ${job.tenant_id}, ${report.id}, ${version},
        ${result.title}, ${result.summary}, ${result.markdown},
        ${JSON.stringify(result)}::jsonb, ${job.input_payload.sourceChecksum},
        ${`partner-report-platform/0.3.0 (${model})`}
      )
    `;
    await tx`
      update team_reports set status = 'LOCKED', current_version = ${version},
        missing_partner_ids = ${JSON.stringify(result.missingPartnerIds)}::jsonb,
        generated_at = now(), locked_at = now(), locked_by = null,
        updated_at = now()
      where id = ${report.id} and tenant_id = ${job.tenant_id}
    `;
    await tx`
      update report_periods set status = 'completed', updated_at = now()
      where id = ${report.period_id} and tenant_id = ${job.tenant_id}
        and team_id = ${job.team_id}
    `;
    await tx`
      update agent_jobs set status = 'CANCELLED', lease_until = null,
        error_code = 'SUPERSEDED_BY_COMPLETED_TEAM_REPORT',
        error_message = 'Superseded by a completed Team Report job', updated_at = now()
      where tenant_id = ${job.tenant_id} and id <> ${job.id}
        and type in ('GENERATE_TEAM_REPORT', 'REGENERATE_TEAM_REPORT')
        and input_payload->>'reportId' = ${report.id}
        and status in ('PENDING', 'RETRY_WAIT', 'LEASED', 'FAILED')
    `;
  });
  return result;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 900);
}

function generationErrorCode(error: unknown) {
  if (error instanceof ModelRequestTimeoutError) return error.code;
  return modelGatewayConfigured()
    ? "CENTRAL_GENERATION_FAILED"
    : "MODEL_NOT_CONFIGURED";
}

export async function processNextGenerationJob(onlyTenantId?: string) {
  const job = await leaseNextJob(onlyTenantId);
  if (!job) return { processed: false };
  try {
    const { model, timezone } = await selectedTeamSettingsFor(job);
    const isAggregation = job.type === "AGGREGATE_WORK_ITEMS";
    const isTeamReport = [
      "GENERATE_TEAM_REPORT",
      "REGENERATE_TEAM_REPORT",
    ].includes(job.type);
    const output = isAggregation
      ? await generateStructured({
          name: "partner_work_item_aggregation",
          schema: aggregationResultSchema,
          instructions: aggregationInstructions(model),
          input: job.input_payload,
          model,
        })
      : isTeamReport
        ? await generateStructured({
            name: "partner_team_report",
            schema: teamReportGenerationResultSchema,
            instructions: teamReportInstructions(
              model,
              job.input_payload.individualReports.map(
                (report: any) => report.reportId,
              ),
            ),
            input: job.input_payload,
            model,
          })
        : await generateStructured({
            name: "partner_individual_report",
            schema: individualReportResultSchema,
            instructions: reportInstructions(model),
            input: job.input_payload,
            model,
          });
    const applied = isAggregation
      ? await applyAggregation(job, output)
      : isTeamReport
        ? await applyTeamReport(job, output, model, timezone)
        : await applyReport(job, output, model);
    await sql`
      update agent_jobs set status = 'COMPLETED', output_payload = ${JSON.stringify(applied)}::jsonb,
        completed_at = now(), lease_until = null, error_code = null, error_message = null, updated_at = now()
      where id = ${job.id} and status = 'LEASED'
    `;
    return { processed: true, jobId: job.id, type: job.type };
  } catch (error) {
    const terminal = job.attempt_count >= job.max_attempts;
    await sql`
      update agent_jobs set status = ${terminal ? "FAILED" : "RETRY_WAIT"},
        error_code = ${generationErrorCode(error)},
        error_message = ${safeError(error)}, lease_until = null, updated_at = now()
      where id = ${job.id} and status = 'LEASED'
    `;
    return { processed: true, jobId: job.id, type: job.type, failed: true };
  }
}
