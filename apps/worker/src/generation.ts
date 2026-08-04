import { randomUUID } from "node:crypto";
import {
  aggregationResultSchema,
  assertReportSemantics,
  assertTeamReportSemantics,
  individualReportResultSchema,
  teamReportResultSchema,
} from "@partner-report/contracts";
import { centralModelIdSchema } from "@partner-report/contracts/models";
import { sqlClient as sql } from "@partner-report/db";
import { generateStructured, modelGatewayConfigured } from "./model.js";

type Job = {
  id: string;
  tenant_id: string;
  team_id: string;
  partner_id: string | null;
  type: string;
  input_payload: any;
  attempt_count: number;
  max_attempts: number;
};

const aggregationInstructions = (model: string) =>
  `You aggregate structured Partner work facts across Sessions into reviewable Work Items. Account for every Fact ID exactly once in a group or unassignedFactIds. Prefer explicit project IDs and configured aliases; never invent an ID. Merge only facts that clearly describe the same work thread and keep low-confidence work independent. Preserve uncertainty and completion evidence. Return production metadata {"skillVersion":"partner-report-platform/0.2.0","promptVersion":"2026-08-03.central.v1","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const reportInstructions = (model: string) =>
  `You generate an individual Partner report from an approved immutable Work Item Snapshot. Use previousReport only to compare prior state with current approved Work Items. Include each of the seven required sections exactly once. Every current factual claim must cite one or more allowed Work Item IDs. Preferences may change presentation but never facts. State coverage limits plainly and do not invent percentages. Return production metadata {"skillVersion":"partner-report-platform/0.2.0","promptVersion":"2026-08-04.individual.v2","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const teamReportInstructions = (model: string) =>
  `Generate a Team Report only from locked individual report versions supplied in individualReports. Never infer missing Partner work and never read or request Session Facts. Account for missingPartnerIds explicitly. Use previousTeamReport only for sourced status comparisons. Include exactly five sections: summary, project_progress, risks, next_priorities, coverage. Every factual claim must cite one or more supplied individual report version IDs. Return production metadata {"skillVersion":"partner-report-platform/0.2.0","promptVersion":"2026-08-04.team.v1","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

async function selectedModelFor(job: Job) {
  const rows = await sql<{ central_model: string }[]>`
    select central_model from teams
    where id = ${job.team_id} and tenant_id = ${job.tenant_id}
    limit 1
  `;
  if (!rows[0]) throw new Error("TEAM_NOT_FOUND");
  return centralModelIdSchema.parse(rows[0].central_model);
}

async function leaseNextJob(onlyTenantId?: string) {
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
        lease_until = now() + interval '3 minutes', updated_at = now()
      where id = ${job.id}
    `;
    return { ...job, attempt_count: job.attempt_count + 1 };
  });
}

function validateAggregation(job: Job, output: unknown) {
  const result = aggregationResultSchema.parse(output);
  const expected = new Set<string>(
    job.input_payload.facts.map((fact: any) => fact.id),
  );
  const used = new Set<string>();
  for (const group of result.groups) {
    for (const id of group.factIds) {
      if (!expected.has(id)) throw new Error(`UNKNOWN_FACT_REFERENCE:${id}`);
      if (used.has(id)) throw new Error(`DUPLICATE_FACT_REFERENCE:${id}`);
      used.add(id);
    }
  }
  for (const id of result.unassignedFactIds) {
    if (!expected.has(id)) throw new Error(`UNKNOWN_FACT_REFERENCE:${id}`);
    if (used.has(id)) throw new Error(`DUPLICATE_FACT_REFERENCE:${id}`);
    used.add(id);
  }
  for (const id of expected)
    if (!used.has(id)) throw new Error(`FACT_COVERAGE_INCOMPLETE:${id}`);
  return result;
}

async function applyAggregation(job: Job, output: unknown) {
  const result = validateAggregation(job, output);
  const reviewId = job.input_payload.reviewId as string;
  const existing = await sql<{ review_status: string }[]>`
    select review_status from work_items where tenant_id = ${job.tenant_id} and review_id = ${reviewId}
  `;
  if (existing.some((item) => item.review_status !== "pending"))
    throw new Error("REVIEW_ALREADY_STARTED");
  await sql.begin(async (tx) => {
    await tx`delete from work_item_facts where work_item_id in (select id from work_items where review_id = ${reviewId})`;
    await tx`delete from work_items where review_id = ${reviewId}`;
    for (const group of result.groups) {
      const workItemId = randomUUID();
      const payload = {
        summary: group.summary,
        outcomes: group.outcomes,
        blockers: group.blockers,
        nextSteps: group.nextSteps,
        importance: group.importance,
        projectConfidence: group.projectConfidence,
        assignmentMethod: group.assignmentMethod,
        mergeConfidence: group.mergeConfidence,
        rationaleCodes: group.rationaleCodes,
        emphasis: false,
      };
      await tx`
        insert into work_items (
          id, tenant_id, team_id, partner_id, period_id, review_id, project_id,
          title, status, fact_ids, payload
        ) values (
          ${workItemId}, ${job.tenant_id}, ${job.team_id}, ${job.partner_id},
          ${job.input_payload.period.id}, ${reviewId}, ${group.projectId ?? null},
          ${group.title}, ${group.status}, ${JSON.stringify(group.factIds)}::jsonb,
          ${JSON.stringify(payload)}::jsonb
        )
      `;
      for (const factId of group.factIds) {
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
  const reports = await sql<any[]>`
    select * from individual_reports where id = ${job.input_payload.reportId}
      and tenant_id = ${job.tenant_id} limit 1
  `;
  const report = reports[0];
  if (!report || ["SUBMITTED", "LOCKED"].includes(report.status))
    throw new Error("REPORT_NOT_EDITABLE");
  const version = report.current_version + 1;
  await sql.begin(async (tx) => {
    await tx`
      insert into individual_report_versions (
        id, tenant_id, report_id, version, title, summary, markdown, payload,
        preferences, source_checksum, generator_version
      ) values (
        ${randomUUID()}, ${job.tenant_id}, ${report.id}, ${version}, ${result.title}, ${result.summary},
        ${result.markdown}, ${JSON.stringify(result)}::jsonb,
        ${JSON.stringify(job.input_payload.preferences ?? {})}::jsonb,
        ${job.input_payload.sourceChecksum}, ${`partner-report-platform/0.2.0 (${model})`}
      )
    `;
    await tx`
      update individual_reports set status = 'REPORT_REVIEW', current_version = ${version}, updated_at = now()
      where id = ${report.id} and tenant_id = ${job.tenant_id}
    `;
    await tx`
      insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values (${randomUUID()}, ${job.tenant_id}, 'individual_report.draft.created', 'individual_report', ${report.id},
        ${JSON.stringify({ version, warnings: result.qualityWarnings })}::jsonb)
    `;
  });
  return result;
}

async function applyTeamReport(job: Job, output: unknown, model: string) {
  const result = teamReportResultSchema.parse(output);
  assertTeamReportSemantics(result);
  const allowed = new Set<string>(
    job.input_payload.individualReports.map((report: any) => report.versionId),
  );
  for (const section of result.sections)
    for (const claim of section.claims)
      for (const id of claim.individualReportVersionIds)
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
        ${`partner-report-platform/0.2.0 (${model})`}
      )
    `;
    await tx`
      update team_reports set status = 'TEAM_DRAFT', current_version = ${version},
        missing_partner_ids = ${JSON.stringify(result.missingPartnerIds)}::jsonb,
        generated_at = now(), updated_at = now()
      where id = ${report.id} and tenant_id = ${job.tenant_id}
    `;
  });
  return result;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 900);
}

export async function processNextGenerationJob(onlyTenantId?: string) {
  const job = await leaseNextJob(onlyTenantId);
  if (!job) return { processed: false };
  try {
    const model = await selectedModelFor(job);
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
            schema: teamReportResultSchema,
            instructions: teamReportInstructions(model),
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
        ? await applyTeamReport(job, output, model)
        : await applyReport(job, output, model);
    await sql`
      update agent_jobs set status = 'COMPLETED', output_payload = ${JSON.stringify(applied)}::jsonb,
        completed_at = now(), lease_until = null, error_code = null, error_message = null, updated_at = now()
      where id = ${job.id}
    `;
    return { processed: true, jobId: job.id, type: job.type };
  } catch (error) {
    const terminal = job.attempt_count >= job.max_attempts;
    await sql`
      update agent_jobs set status = ${terminal ? "FAILED" : "RETRY_WAIT"},
        error_code = ${modelGatewayConfigured() ? "CENTRAL_GENERATION_FAILED" : "MODEL_NOT_CONFIGURED"},
        error_message = ${safeError(error)}, lease_until = null, updated_at = now()
      where id = ${job.id}
    `;
    return { processed: true, jobId: job.id, type: job.type, failed: true };
  }
}
