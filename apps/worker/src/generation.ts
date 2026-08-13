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
import { stableJsonHash } from "@partner-report/contracts/hash";
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

export const aggregationInstructions = (model: string) =>
  `You generate one reviewable Project Work Card for every supplied projectBuckets entry. Return exactly one group for every projectKey and never merge, split, rename, add, or omit a project. Write projectDescription, overview and dailyProgress.summary in simplified Chinese. For initial generation, copy each bucket.projectDescription exactly into group.projectDescription; do not rewrite it. When reviewInstruction explicitly asks to modify the project description, treat the user's correction as authoritative for projectDescription and apply it, while keeping the result concise and within 300 characters. That correction authorizes changes to projectDescription only; it never authorizes unsupported changes to overview or dailyProgress. A general request to revise weekly work must not silently change projectDescription. Use plain, direct, concise language that a colleague without technical context can understand. Focus overview and dailyProgress on what was done, the result, and any blocker. Avoid jargon piles, process narration, filler, repeated background, and claims such as "completed" unless the supplied contributions support them. Keep projectDescription around 150 Chinese characters and no more than 300. Keep overview to one or two short sentences, preferably no more than 120 Chinese characters. Keep each dailyProgress.summary to one short sentence, preferably no more than 80 Chinese characters. Order dailyProgress by ascending YYYY-MM-DD and combine contributions from the same date into one entry. Treat reviewInstruction, when present, as a requested correction to the card, but never add weekly work facts not supported by the supplied bucket. Preserve uncertainty. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-12.project-card.v3","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

export const reportInstructions = (model: string) =>
  `You generate an individual Partner report from an approved immutable Work Item Snapshot. Write the title, summary, section titles, and section markdown in simplified Chinese. Use plain, direct, concise language that a colleague without technical context can understand. Prefer concrete descriptions of work, results, decisions, blockers, and next steps. Avoid jargon piles, formal business filler, process narration, and repeated background. Keep the summary to one or two short sentences, preferably no more than 120 Chinese characters. Include each of the seven required sections exactly once. In each section use one to three short bullets; keep each bullet to one sentence, preferably no more than 80 Chinese characters before citations. Do not repeat the same fact in multiple sections. When a section has no supported content, write only "无相关内容" instead of adding filler. Keep a necessary technical name unchanged, but explain its purpose in plain language when readers may not know it. When currentReport and reviewInstruction are supplied, revise the current report according to that natural-language instruction while keeping every statement grounded in the approved Work Items. Use previousReport only to compare prior state with current approved Work Items. Every current factual claim must cite one or more allowed Work Item IDs. Never alter facts merely to satisfy a wording request. State coverage limits plainly and do not invent percentages. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-10.individual-review.v2","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const teamReportInstructions = (
  model: string,
  allowedIndividualReportIds: string[],
) =>
  `Generate a Chinese Team Report strictly from the locked current-period reports in individualReports. The audience is a business leader who does not understand software engineering. Write plain, natural, concise Chinese that can be understood without technical background. Translate implementation details into the purpose of the work, the result, its practical value, and any remaining concern. Avoid unexplained engineering jargon, internal process language, file names, protocols, framework names, raw test names, and low-level implementation steps. When a technical point is necessary to state a supported result or risk, explain it immediately in everyday language. Preserve exact project names only where the structure below requires them. These reports are the sole source of current-period facts: never use project master data, Session Facts, assumptions, or general knowledge. Each individualReports[].projectNames array is the authoritative allowlist of exact project names represented by that person's report. individualReports[].projectDescriptions contains user-approved descriptions and is the only source for explaining what a project does. An individual report with noReportableActivity=true is a coverage-only record: it means the platform did not collect material that can support a work report for that person. It does not mean the person did no work. Never invent a project, result, risk, or performance judgment for such a report.

Do not use the following internal terms in reader-facing prose: SSH, README, 状态机, 聚合调度, 贡献模型, 类型校验, 依赖安装, 依赖未安装, 主分支, 代码仓库, 远程仓库, 前端架构, 本地开发服务, 飞书网关, 测试用例, 实验元数据, 历史快照, 报表凭证, 同步解析, 数据接入. Translate them into plain outcomes instead. For example: say project materials were submitted and synchronized, the work page is available, a complete quality check is still pending, the Feishu message connection still has an issue, or experiment information is available for comparison and analysis. Exact project names are exempt from this vocabulary rule.

Include exactly three sections in this order: summary, project_progress, risks. Do not create coverage or next-priorities sections.

The top-level summary field is the executive overview displayed directly below the report title. Write one cohesive Chinese prose paragraph of about 500 Chinese characters, targeting 450 to 600 characters. It must contain exactly five substantial sentences in this order: (1) the overall conclusion supported by the available reports; (2) the main completed work or process improvement; (3) delivery, collaboration, or validation results; (4) another supported capability or area of progress; (5) the supported issues or reporting-coverage limits that require management attention. Target 80 to 120 Chinese characters per sentence. If a requested sentence has no supporting work record, use that sentence to state the reporting-coverage limit instead of inventing progress. Write a management-level overview, not a compressed inventory of every source detail. Do not mention Partner names, project names, code, repositories, configuration, files, protocols, internal models, internal workflow states, or specialized test terminology in this paragraph. Do not enumerate projects or people separately. Do not use bullets, numbered lists, headings, or line breaks. Use the available source detail without adding business impact that the reports do not support.

In summary, do not write an opening narrative paragraph or combine all projects into one prose block. Organize the entire section by project as a Markdown bullet list. Create exactly one top-level bullet for every distinct name in individualReports[].projectNames, and start that bullet with the exact project name copied verbatim, followed by a Chinese colon. When an approved description exists in projectDescriptions for that name, copy that exact description immediately after the colon; do not paraphrase, shorten, or replace it with weekly progress. Never invent a category label, rename a project, or merge several projects under a generalized label. Add nested bullets for every person who contributed to that project. Each person bullet must describe the work and result in language a non-technical leader can understand. Prefer outcomes such as improved stability, completed validation, clearer process, working delivery, or an unresolved issue over implementation mechanics. This section is the project-first inverse index of project_progress. Reports with noReportableActivity=true must not create a project bullet and must not be inserted under an unrelated project.

In project_progress, group content by concrete Partner/person first, using the supplied partnerName when present and partnerId only as a fallback. Under each person, organize their work by project, using only exact names copied from that person's projectNames array. Explain what was advanced, what usable result was reached, and what remains, using everyday Chinese. Combine related technical actions into one management-level statement instead of listing implementation steps. Do not start a project entry with phrases such as "当前状态为" or "状态为". Do not expose raw status enum identifiers such as awaiting_validation, in_progress, or completed. When status is materially relevant, express it naturally in Chinese after the concrete work, for example "已完成" or "待验证", and only when supported by the report. For every report with noReportableActivity=true, include that person exactly once without a project name and state only that the platform did not collect a work record suitable for this report and therefore makes no judgment about actual work. Do not start project_progress with project-level headings, do not merge people, and do not omit any Partner/project contribution or coverage-only person.

Include risks only when supported by the current individual reports. State each risk in plain language, explain its practical consequence only when supported, and make the remaining action understandable without technical knowledge. State plainly when none were reported. Treat noReportableActivity=true as a reporting-coverage limit, not as evidence of a project risk or poor performance. previousTeamReport is null for the first report. When it is present, it is exactly the immediately preceding period's final Team Report and may only support progress comparisons; never copy its prior-period work into the current period or use it to introduce an uncited current fact. Every current factual claim must cite one or more supplied individual report IDs. In every claim's individualReportIds, copy only exact values from individualReports[].reportId. For this request, the complete allowlist is ${JSON.stringify(allowedIndividualReportIds)}. Every individualReportId must be copied exactly from this allowlist. Never use the top-level reportId, partnerId, project IDs, Work Item IDs, or any other identifier as an individualReportId.

Return section content only; the service assembles the top-level title and markdown deterministically. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-12.team.v14","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

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

export function buildNoActivityTeamReport(
  individualReports: Array<{
    partnerId: string;
    partnerName?: string;
    reportId: string;
  }>,
  model: string,
) {
  const reportIds = individualReports.map((report) => report.reportId);
  const summary =
    "本周期内，中台没有采集到可用于团队工作汇报的记录，因此本报告不对具体项目进展、工作成果或完成情况作出判断。" +
    "该结果只说明当前缺少能够进入报告的资料，不代表团队成员在本周期没有开展工作，也不能据此评价个人投入或工作表现。" +
    "团队报告仍按计划完成归档，并保留所有在职人员的记录状态，避免因个别人员没有数据而阻塞整个周期的报告生成。" +
    "由于缺少可核对的项目材料，本报告不会补写项目名称、成果、风险或后续安排，相关信息需要结合其他管理记录了解。" +
    "管理人员查看本报告时，应将其理解为本周期的数据覆盖说明，而不是工作结论；后续周期一旦采集到新的有效记录，将继续按正常流程形成工作卡片和报告。";
  return teamReportGenerationResultSchema.parse({
    schemaVersion: "1.0",
    summary,
    sections: [
      {
        key: "summary",
        markdown:
          "本周期未采集到可用于汇报的项目记录，因此没有可列出的项目摘要。",
        claims: [
          {
            claim: "本周期没有可用于汇报的项目记录。",
            individualReportIds: reportIds,
          },
        ],
      },
      {
        key: "project_progress",
        markdown: individualReports
          .map(
            (report) =>
              `- ${report.partnerName ?? report.partnerId}：本周期未采集到可用于汇报的工作记录，本报告不对其实际工作作出判断。`,
          )
          .join("\n"),
        claims: individualReports.map((report) => ({
          claim: `${report.partnerName ?? report.partnerId}本周期没有可用于汇报的工作记录。`,
          individualReportIds: [report.reportId],
        })),
      },
      {
        key: "risks",
        markdown:
          "本周期缺少可用于汇报的记录，无法仅根据本报告判断项目进展和风险；这属于报告覆盖范围限制，不代表实际工作存在异常。",
        claims: [
          {
            claim: "本周期报告存在记录覆盖范围限制。",
            individualReportIds: reportIds,
          },
        ],
      },
    ],
    missingPartnerIds: [],
    qualityWarnings: ["NO_REPORTABLE_ACTIVITY_COLLECTED"],
    production: {
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-12.team.v14",
      schemaVersion: "1.0",
      producer: "data-platform",
      modelVersion: model,
    },
  });
}

function approvedProjectDescriptions(
  individualReports: Array<{ projectDescriptions?: unknown }>,
) {
  const descriptions = new Map<string, string>();
  for (const individualReport of individualReports) {
    if (!Array.isArray(individualReport.projectDescriptions)) continue;
    for (const item of individualReport.projectDescriptions) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (
        typeof value.name === "string" &&
        value.name.trim() &&
        typeof value.description === "string" &&
        value.description.trim()
      )
        descriptions.set(value.name.trim(), value.description.trim());
    }
  }
  return descriptions;
}

export function injectApprovedProjectDescriptions(
  markdown: string,
  individualReports: Array<{ projectDescriptions?: unknown }>,
) {
  const descriptions = approvedProjectDescriptions(individualReports);
  if (descriptions.size === 0) return markdown;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (!/^[-*+]\s+/.test(line)) return line;
      const prefix = line.match(/^[-*+]\s+/)?.[0] ?? "- ";
      const rawLabel = line.slice(prefix.length).split(/[：:]/, 1)[0]!.trim();
      const label = rawLabel.replace(/\*\*/g, "").trim();
      const description = descriptions.get(label);
      return description ? `${prefix}${rawLabel}：${description}` : line;
    })
    .join("\n");
}

function finalizeTeamReport(
  result: any,
  reportDate: string,
  individualReports: Array<{ projectDescriptions?: unknown }>,
) {
  const sections = result.sections.map((section: any) => ({
    ...section,
    title:
      teamReportSectionTitles[
        section.key as keyof typeof teamReportSectionTitles
      ],
    markdown:
      section.key === "summary"
        ? injectApprovedProjectDescriptions(section.markdown, individualReports)
        : section.markdown,
  }));
  return {
    ...result,
    title: `团队周报 ${reportDate}`,
    summary: normalizeTeamReportSummary(result.summary),
    production: {
      ...result.production,
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-12.team.v14",
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
    const bucket = buckets.get(group.projectKey);
    if (!bucket) throw new Error(`UNKNOWN_PROJECT_BUCKET:${group.projectKey}`);
    if (used.has(group.projectKey))
      throw new Error(`DUPLICATE_PROJECT_BUCKET:${group.projectKey}`);
    used.add(group.projectKey);
    const dates = group.dailyProgress.map((entry: any) => entry.date);
    if (new Set(dates).size !== dates.length)
      throw new Error(`DUPLICATE_PROGRESS_DATE:${group.projectKey}`);
    if (JSON.stringify(dates) !== JSON.stringify([...dates].sort()))
      throw new Error(`UNSORTED_DAILY_PROGRESS:${group.projectKey}`);
    const reviewInstruction = job.input_payload.reviewInstruction;
    const descriptionChangeRequested =
      typeof reviewInstruction === "string" &&
      /(项目描述|项目介绍|项目定位|项目用途|这个项目是做什么|这个项目做什么|description)/i.test(
        reviewInstruction,
      );
    if (
      !descriptionChangeRequested &&
      group.projectDescription !== (bucket.projectDescription ?? "")
    )
      throw new Error(`PROJECT_DESCRIPTION_CHANGED:${group.projectKey}`);
    if (bucket.projectDescription && !group.projectDescription.trim())
      throw new Error(`PROJECT_DESCRIPTION_EMPTY:${group.projectKey}`);
    const supportedStatus = projectStatusWithCompletionSupport(
      group.status,
      bucket,
    );
    if (supportedStatus !== group.status) {
      group.status = supportedStatus;
      if (!result.qualityWarnings.includes("COMPLETION_EVIDENCE_MISSING"))
        result.qualityWarnings.push("COMPLETION_EVIDENCE_MISSING");
    }
  }
  for (const projectKey of buckets.keys())
    if (!used.has(projectKey))
      throw new Error(`PROJECT_BUCKET_MISSING:${projectKey}`);
  return result;
}

export function bucketHasCompletionSupport(bucket: {
  facts?: Array<{ payload?: Record<string, unknown> }>;
}) {
  return (bucket.facts ?? []).some(({ payload = {} }) => {
    if (
      payload.completionSupport === "evidence" ||
      payload.factOrigin === "partner_supplied"
    )
      return true;
    if (
      payload.recordType !== "session_contribution" ||
      !Array.isArray(payload.contributions)
    )
      return false;
    return payload.contributions.some(
      (contribution) =>
        contribution &&
        typeof contribution === "object" &&
        (contribution as Record<string, unknown>).kind === "outcome" &&
        ["high", "medium"].includes(
          String((contribution as Record<string, unknown>).confidence),
        ),
    );
  });
}

export function projectStatusWithCompletionSupport(
  status: string,
  bucket: { facts?: Array<{ payload?: Record<string, unknown> }> },
) {
  return status === "completed" && !bucketHasCompletionSupport(bucket)
    ? "awaiting_validation"
    : status;
}

function projectCardPayload(group: any, bucket?: any) {
  return {
    projectKey: group.projectKey,
    projectDescription: group.projectDescription,
    projectDescriptionCandidateId:
      bucket?.projectDescriptionCandidateId ?? null,
    projectDescriptionSourceFingerprint:
      bucket?.projectDescriptionSourceFingerprint ?? null,
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
          payload = ${JSON.stringify(projectCardPayload(group, bucket))}::jsonb,
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
      const payload = projectCardPayload(group, bucket);
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
        approved_count = 0, excluded_count = 0,
        pending_count = ${result.groups.length}, updated_at = now()
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
        status = 'REPORT_REVIEW',
        content_revision = content_revision + 1,
        title = ${result.title}, summary = ${result.summary},
        markdown = ${result.markdown}, payload = ${JSON.stringify(result)}::jsonb,
        preferences = ${JSON.stringify(job.input_payload.preferences ?? {})}::jsonb,
        source_checksum = ${job.input_payload.sourceChecksum},
        generator_version = ${`partner-report-platform/0.2.0 (${model})`},
        submitted_at = null,
        locked_at = null,
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
    finalizeTeamReport(
      generated,
      reportDate,
      job.input_payload.individualReports,
    ),
  );
  assertTeamReportSemantics(result);
  assertChineseTeamReport(result);
  assertLeaderReadableTeamReport(result, job.input_payload.individualReports);
  assertExactTeamReportProjectNames(
    result,
    job.input_payload.individualReports,
  );
  assertExactTeamReportProjectDescriptions(
    result,
    job.input_payload.individualReports,
  );
  assertNoActivityTeamCoverage(result, job.input_payload.individualReports);
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
        error_code = coalesce(error_code, 'SUPERSEDED_BY_COMPLETED_TEAM_REPORT'),
        error_message = coalesce(
          error_message,
          'Superseded by a completed Team Report job'
        ), updated_at = now()
      where tenant_id = ${job.tenant_id} and id <> ${job.id}
        and type in ('GENERATE_TEAM_REPORT', 'REGENERATE_TEAM_REPORT')
        and input_payload->>'reportId' = ${report.id}
        and status in ('PENDING', 'RETRY_WAIT', 'LEASED', 'FAILED')
    `;
  });
  return result;
}

const teamReportForbiddenTerms = [
  "SSH",
  "README",
  "状态机",
  "聚合调度",
  "贡献模型",
  "类型校验",
  "依赖安装",
  "依赖未安装",
  "主分支",
  "代码仓库",
  "远程仓库",
  "前端架构",
  "本地开发服务",
  "飞书网关",
  "测试用例",
  "实验元数据",
  "历史快照",
  "报表凭证",
  "同步解析",
  "数据接入",
] as const;

export function assertLeaderReadableTeamReport(
  report: {
    summary: string;
    sections: Array<{ markdown: string }>;
  },
  individualReports: Array<{ projectDescriptions?: unknown }> = [],
) {
  const summaryLength = Array.from(report.summary.replace(/\s/gu, "")).length;
  if (summaryLength < 250 || summaryLength > 650) {
    throw new Error(`TEAM_REPORT_SUMMARY_LENGTH:${summaryLength}`);
  }
  let prose = [
    report.summary,
    ...report.sections.map((section) => section.markdown),
  ].join("\n");
  for (const individualReport of individualReports) {
    if (!Array.isArray(individualReport.projectDescriptions)) continue;
    for (const item of individualReport.projectDescriptions) {
      if (!item || typeof item !== "object") continue;
      const description = (item as Record<string, unknown>).description;
      if (typeof description === "string" && description.trim())
        prose = prose.replaceAll(description.trim(), "");
    }
  }
  const forbidden = teamReportForbiddenTerms.find((term) =>
    prose.includes(term),
  );
  if (forbidden) throw new Error(`TEAM_REPORT_TECHNICAL_JARGON:${forbidden}`);
}

export function assertExactTeamReportProjectNames(
  report: { sections: Array<{ key: string; markdown: string }> },
  individualReports: Array<{ projectNames?: unknown }>,
) {
  const expected = [
    ...new Set(
      individualReports.flatMap((individualReport) =>
        Array.isArray(individualReport.projectNames)
          ? individualReport.projectNames.filter(
              (name): name is string =>
                typeof name === "string" && name.trim().length > 0,
            )
          : [],
      ),
    ),
  ].sort();
  if (expected.length === 0) return;

  const summary = report.sections.find((section) => section.key === "summary");
  const actual = (summary?.markdown ?? "")
    .split(/\r?\n/)
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => {
      const label = line
        .replace(/^[-*+]\s+/, "")
        .split(/[：:]/, 1)[0]!
        .replace(/\*\*/g, "")
        .trim();
      return label;
    })
    .filter(Boolean)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("TEAM_REPORT_PROJECT_NAMES_MISMATCH");
  }
}

export function assertExactTeamReportProjectDescriptions(
  report: { sections: Array<{ key: string; markdown: string }> },
  individualReports: Array<{ projectDescriptions?: unknown }>,
) {
  const approved = approvedProjectDescriptions(individualReports);
  if (approved.size === 0) return;
  const summary =
    report.sections.find((section) => section.key === "summary")?.markdown ??
    "";
  for (const [name, description] of approved) {
    const line = summary
      .split(/\r?\n/)
      .filter((candidate) => /^[-*+]\s+/.test(candidate))
      .find((candidate) => {
        const label = candidate
          .replace(/^[-*+]\s+/, "")
          .split(/[：:]/, 1)[0]!
          .replace(/\*\*/g, "")
          .trim();
        return label === name;
      });
    if (!line || !line.includes(description))
      throw new Error(`TEAM_REPORT_PROJECT_DESCRIPTION_MISSING:${name}`);
  }
}

export function assertNoActivityTeamCoverage(
  report: { sections: Array<{ key: string; markdown: string }> },
  individualReports: Array<{
    partnerId: string;
    partnerName?: string;
    noReportableActivity?: boolean;
  }>,
) {
  const noActivityReports = individualReports.filter(
    (individualReport) => individualReport.noReportableActivity === true,
  );
  if (noActivityReports.length === 0) return;
  const progress =
    report.sections.find((section) => section.key === "project_progress")
      ?.markdown ?? "";
  for (const individualReport of noActivityReports) {
    const label = individualReport.partnerName ?? individualReport.partnerId;
    if (!progress.includes(label))
      throw new Error(`TEAM_REPORT_NO_ACTIVITY_PARTNER_MISSING:${label}`);
  }
  if (progress.includes("没有工作") || progress.includes("未开展工作")) {
    throw new Error("TEAM_REPORT_NO_ACTIVITY_UNSUPPORTED_JUDGMENT");
  }
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
    const allReportsHaveNoActivity =
      isTeamReport &&
      job.input_payload.individualReports.length > 0 &&
      job.input_payload.individualReports.every(
        (report: any) => report.noReportableActivity === true,
      );
    const output = isAggregation
      ? await generateStructured({
          name: "partner_work_item_aggregation",
          schema: aggregationResultSchema,
          instructions: aggregationInstructions(model),
          input: job.input_payload,
          model,
        })
      : isTeamReport
        ? allReportsHaveNoActivity
          ? buildNoActivityTeamReport(
              job.input_payload.individualReports,
              model,
            )
          : await generateStructured({
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
