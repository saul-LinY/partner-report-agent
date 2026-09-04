import { randomUUID } from "node:crypto";
import {
  aggregationResultSchema,
  teamReportGenerationResultSchema,
  teamReportResultSchema,
  workStatusSchema,
} from "@partner-report/contracts";
import { stableJsonHash } from "@partner-report/contracts/hash";
import { centralModelIdSchema } from "@partner-report/contracts/models";
import { sqlClient as sql } from "@partner-report/db";
import { z } from "zod";
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
  plugin_instance_id: string | null;
  type: string;
  input_payload: any;
  attempt_count: number;
  max_attempts: number;
  created_at: Date | string;
};

const systemHealthJobTypes = [
  "SYSTEM_HEALTH_QUEUE",
  "SYSTEM_HEALTH_GENERATION",
  "SYSTEM_HEALTH_REPORTS",
] as const;

const modelHealthSchema = z.object({ ok: z.literal(true) });
const pluginLogAnalysisResultSchema = z.object({
  summary: z.string().min(1).max(300),
  failedStep: z.string().min(1).max(120),
  rootCause: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(240)).min(1).max(4),
  recommendedActions: z.array(z.string().min(1).max(240)).min(1).max(4),
  confidence: z.enum(["high", "medium", "low"]),
});
const pluginLogAnalysisModelSchema = z.record(z.string(), z.unknown());

function normalizedAnalysisText(value: unknown, fallback: string, max: number) {
  return (typeof value === "string" && value.trim() ? value : fallback)
    .trim()
    .slice(0, max);
}

function normalizedAnalysisList(value: unknown, fallback: string[]) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const normalized = values
    .filter(
      (item): item is string =>
        typeof item === "string" && Boolean(item.trim()),
    )
    .map((item) => item.trim().slice(0, 240))
    .slice(0, 4);
  return normalized.length > 0 ? normalized : fallback;
}

export function normalizePluginLogAnalysis(
  generated: Record<string, unknown>,
  fallbackStep: string,
) {
  const failedStep = normalizedAnalysisText(
    generated.failedStep,
    fallbackStep,
    120,
  );
  const rootCause = normalizedAnalysisText(
    generated.rootCause ?? generated.cause,
    "现有日志不足以确认唯一原因，请结合事件代码继续排查。",
    500,
  );
  return pluginLogAnalysisResultSchema.parse({
    summary: normalizedAnalysisText(
      generated.summary ?? generated.conclusion,
      failedStep,
      300,
    ),
    failedStep,
    rootCause,
    evidence: normalizedAnalysisList(generated.evidence, [
      "请查看本次运行时间线中的事件代码和计数。",
    ]),
    recommendedActions: normalizedAnalysisList(
      generated.recommendedActions ?? generated.actions,
      ["按即时诊断建议检查失败阶段后重新执行。"],
    ),
    confidence: ["high", "medium", "low"].includes(String(generated.confidence))
      ? generated.confidence
      : "low",
  });
}

function isSystemHealthJob(type: string) {
  return systemHealthJobTypes.includes(
    type as (typeof systemHealthJobTypes)[number],
  );
}

export const aggregationInstructions = (model: string) =>
  `You generate one reviewable Project Work Card for every supplied projectBuckets entry. Return exactly one group for every projectKey and never merge, split, rename, add, or omit a project. The card contains only status, overview and dailyProgress; do not output a project description. Write overview and dailyProgress.summary in simplified Chinese. Treat reviewInstruction as an authoritative first-hand correction from the Partner: it may correct wording, emphasis, dates, results, or add weekly work facts explicitly stated by the user. Never invent anything beyond the supplied bucket and the explicit reviewInstruction, and preserve uncertainty when neither source proves a result. Use plain, direct, everyday Chinese that a colleague without technical context can understand. Explain necessary technical terms in ordinary language instead of stacking jargon. In overview, give a management-level summary of this project's progress for the week: what was advanced, the supported result or current state, and any remaining issue when available. Target 80 to 100 Chinese characters and never exceed 120. For each dailyProgress.summary, combine all meaningful activities from that date into one overall project-progress statement. State the main action and supported result in about 50 Chinese characters, usually 40 to 50 and never more than 60. Avoid step-by-step implementation details, process narration, filler, repeated background, unsupported business impact, and claims such as "completed" unless the supplied contributions or explicit reviewInstruction support them. Order dailyProgress by ascending YYYY-MM-DD and return exactly one entry per date. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-28.project-card.v7","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

export function projectAggregationInputs(inputPayload: any) {
  const projectBuckets = Array.isArray(inputPayload.projectBuckets)
    ? inputPayload.projectBuckets
    : [];
  return projectBuckets.map((projectBucket: any) => ({
    ...inputPayload,
    projectBuckets: [projectBucket],
  }));
}

async function generateAggregationByProject(job: Job, model: string) {
  const projectInputs = projectAggregationInputs(job.input_payload);
  if (projectInputs.length === 0) throw new Error("PROJECT_BUCKETS_REQUIRED");

  const results = await Promise.all(
    projectInputs.map((input: any) =>
      generateStructured<any>({
        name: "partner_work_item_aggregation",
        schema: aggregationResultSchema,
        instructions: aggregationInstructions(model),
        input,
        model,
      }),
    ),
  );

  return {
    schemaVersion: "1.0",
    groups: results.flatMap((result) => result.groups),
    qualityWarnings: [
      ...new Set(results.flatMap((result) => result.qualityWarnings)),
    ],
    production: results[0].production,
  };
}

const teamReportInstructions = (
  model: string,
  allowedWorkCardSnapshotIds: string[],
) =>
  `Generate a Chinese Team Report strictly from the locked current-period Work Card snapshots in workCards. The audience is a business leader who does not understand software engineering. Write plain, natural, concise Chinese that can be understood without technical background. Translate implementation details into the purpose of the work, the result, its practical value, and any remaining concern. Avoid unexplained engineering jargon, internal process language, file names, protocols, framework names, raw test names, and low-level implementation steps. When a technical point is necessary to state a supported result or risk, explain it immediately in everyday language. Preserve exact project names only where the structure below requires them. These Work Card snapshots are the sole source of current-period facts: never use project master data, Session Facts, assumptions, or general knowledge. Each workCards[].projectNames array is the authoritative allowlist of exact project names represented by that person's Work Cards. A Work Card snapshot with noReportableActivity=true is a coverage-only record: it means the platform did not collect material that can support a work report for that person. It does not mean the person did no work. Never invent a project, result, risk, or performance judgment for such a snapshot.

Do not use the following internal terms in reader-facing prose: SSH, README, 状态机, 聚合调度, 贡献模型, 类型校验, 依赖安装, 依赖未安装, 主分支, 代码仓库, 远程仓库, 前端架构, 本地开发服务, 消息网关, 测试用例, 实验元数据, 历史快照, 报表凭证, 同步解析, 数据接入. Translate them into plain outcomes instead. Exact project names are exempt from this vocabulary rule.

Include exactly three sections in this order: project_progress, week_comparison, risks. Do not create summary, coverage, or next-priorities sections. The top-level summary field is the only team-wide summary.

The top-level summary field is the management overview displayed directly below the report title. Write four to six natural Chinese sentences totaling about 300 Chinese characters, targeting 260 to 320 and never exceeding 360. Give one overall account of all people's projects: the main areas advanced, the most important supported results or current states, the team's general pace, and the most material shared issue, next step, or reporting-coverage limit when present. Keep it understandable to a non-technical manager. Do not turn it into a person-by-person or project-by-project list, and do not mention Partner names, project names, code, repositories, configuration, files, protocols, internal models, internal workflow states, or specialized test terminology. Use the available source detail without adding unsupported business impact or padding the text with empty phrases.

In project_progress, return one Markdown table and no prose before or after it. Use exactly these three columns in this order: 成员, 项目, 本周工作明细. Create one row for every concrete Partner/project combination, using partnerName when present and partnerId only as a fallback, and copying each project name exactly from that person's projectNames allowlist. In each 本周工作明细 cell, combine that person's approved work on that project into one plain management-level description: what was advanced, what usable result or current state was reached, and what remains when supported. Target about 100 Chinese characters, usually 90 to 110, and never exceed 120. Do not list implementation steps, merge people, rename projects, or omit a Partner/project contribution. Do not start descriptions with phrases such as "当前状态为" or "状态为", and do not expose raw status enum identifiers such as awaiting_validation, in_progress, or completed. When status is materially relevant, express it naturally in Chinese and only when supported. For every Work Card snapshot with noReportableActivity=true, include that person exactly once, use "-" as the project, and state only that the platform did not collect a work record suitable for this report and therefore makes no judgment about actual work. Escape any vertical bar inside cell content so the Markdown table remains valid.

In week_comparison, return one Markdown table and no prose before or after it. Use exactly these three columns in this order: 成员, 项目, 与上周相比. Create one row for every current Partner/project combination for which the current Work Cards and previousTeamReport support a useful comparison. Identify the same person and exact project; never compare different people or projects. In 与上周相比, explain in plain Chinese whether this week added a supported result, continued an unfinished item, resolved a previously reported issue, or still has a previously reported issue. Include the concrete change rather than only a label such as "有进展". The immediately preceding locked report in previousTeamReport may support only the prior-period baseline; every statement about this week must still be supported by current Work Cards and cite their snapshot IDs. Absence from the current Work Cards is not evidence that prior work finished, stopped, regressed, or no longer matters. Never infer performance, speed, delay, or completion from missing records. If previousTeamReport is null, return exactly one row with "-" for 成员 and 项目 and "暂无上周团队报告，本周暂不进行环比判断。" for 与上周相比. If a current Partner/project has no safe prior baseline, state "上周报告中没有可核对的同项目记录，本周作为新增记录展示。" rather than inventing a change. Treat noReportableActivity=true as insufficient current evidence and state that no comparison can be made; do not treat it as no progress. Escape any vertical bar inside cell content so the Markdown table remains valid.

In risks, return one Markdown table and no prose before or after it. Use exactly these three columns in this order: 成员, 项目, 风险与阻塞. Include one row per supported risk. The first two cells must identify whose work and which exact project has the issue; the third must state the specific issue, its supported consequence, and the remaining action in plain language. Copy Partner and project names from the corresponding Work Card. When no risk was reported, return exactly one row with "-" for both 成员 and 项目 and "本周工作卡片未报告明确风险与阻塞。" for 风险与阻塞. Treat noReportableActivity=true as a reporting-coverage limit, not as evidence of a project risk or poor performance. Escape any vertical bar inside cell content so the Markdown table remains valid. previousTeamReport is null for the first report. When it is present, it is exactly the immediately preceding period's final Team Report and may only support progress comparisons; never copy its prior-period work into the current period or use it to introduce an uncited current fact. Every current factual claim must cite one or more supplied Work Card snapshot IDs. In every claim's workCardSnapshotIds, copy only exact values from workCards[].snapshotId. For this request, the complete allowlist is ${JSON.stringify(allowedWorkCardSnapshotIds)}. Every workCardSnapshotId must be copied exactly from this allowlist. Never use the top-level reportId, partnerId, project IDs, Work Item IDs, or any other identifier as a workCardSnapshotId.

Return section content only; the service assembles the top-level title and markdown deterministically. Return production metadata {"skillVersion":"partner-report-platform/0.3.0","promptVersion":"2026-08-31.team.v18","schemaVersion":"1.0","producer":"data-platform","modelVersion":"${model}"}.`;

const teamReportSectionTitles = {
  project_progress: "项目与人员工作明细",
  week_comparison: "与上周工作对比",
  risks: "风险与阻塞",
} as const;

const teamReportSectionKeys = [
  "project_progress",
  "week_comparison",
  "risks",
] as const;

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

async function generateTeamReport(job: Job, model: string) {
  return generateStructured<any>({
    name: "partner_team_report",
    schema: teamReportGenerationResultSchema,
    instructions: teamReportInstructions(
      model,
      job.input_payload.workCards.map((workCard: any) => workCard.snapshotId),
    ),
    input: job.input_payload,
    model,
  });
}

function reportTableCell(value: string) {
  return normalizeTeamReportSummary(value)
    .replace(/\\\|/g, "|")
    .replace(/\|/g, "\\|");
}

function markdownTable(markdown: string, header: RegExp) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;
  const table: string[] = [];
  for (const line of lines.slice(start)) {
    if (!/^\s*\|/.test(line)) break;
    table.push(line.trim());
  }
  return table.length >= 3 ? table : null;
}

function structuredSectionMarkdown(
  key: (typeof teamReportSectionKeys)[number],
  markdown: string,
  qualityWarnings: string[],
) {
  if (key === "project_progress") {
    const table = markdownTable(
      markdown,
      /^\s*\|\s*成员\s*\|\s*项目\s*\|\s*本周工作明细\s*\|/,
    );
    if (table)
      return table
        .map((line, index) => {
          if (index < 2 || !/^\s*\|/.test(line)) return line;
          const cells = line
            .trim()
            .replace(/^\||\|$/g, "")
            .split(/(?<!\\)\|/);
          if (cells.length !== 3) return line;
          return `| ${cells[0]!.trim()} | ${cells[1]!.trim()} | ${reportTableCell(cells[2]!)} |`;
        })
        .join("\n");
    qualityWarnings.push("MODEL_TEAM_PROGRESS_TABLE_NORMALIZED");
    return `| 成员 | 项目 | 本周工作明细 |\n| --- | --- | --- |\n| - | - | ${reportTableCell(markdown)} |`;
  }
  if (key === "week_comparison") {
    const table = markdownTable(
      markdown,
      /^\s*\|\s*成员\s*\|\s*项目\s*\|\s*与上周相比\s*\|/,
    );
    if (table) return table.join("\n");
    qualityWarnings.push("MODEL_TEAM_WEEK_COMPARISON_TABLE_NORMALIZED");
    return `| 成员 | 项目 | 与上周相比 |\n| --- | --- | --- |\n| - | - | ${reportTableCell(markdown)} |`;
  }
  const table = markdownTable(
    markdown,
    /^\s*\|\s*成员\s*\|\s*项目\s*\|\s*风险与阻塞\s*\|/,
  );
  if (table) return table.join("\n");
  qualityWarnings.push("MODEL_TEAM_RISK_TABLE_NORMALIZED");
  return `| 成员 | 项目 | 风险与阻塞 |\n| --- | --- | --- |\n| - | - | ${reportTableCell(markdown)} |`;
}

export function buildNoActivityTeamReport(
  workCards: Array<{
    partnerId: string;
    partnerName?: string;
    snapshotId: string;
  }>,
  model: string,
) {
  const snapshotIds = workCards.map((workCard) => workCard.snapshotId);
  const summary =
    "本周期内，系统没有采集到可用于团队工作汇报的记录，因此本报告不对具体项目进展、工作成果或完成情况作出判断。" +
    "该结果只说明当前缺少能够进入报告的资料，不代表团队成员在本周期没有开展工作，也不能据此评价个人投入或工作表现。" +
    "团队报告仍按计划完成归档，并保留所有在职人员的记录状态，避免因个别人员没有数据而影响整个周期的报告生成。" +
    "由于缺少可核对的项目材料，本报告不会补写项目名称、成果、风险或后续安排，相关信息需要结合其他管理记录了解。" +
    "管理人员查看本报告时，应将其理解为本周期的资料覆盖说明，而不是工作结论；后续采集到新的有效记录后，将继续按正常流程形成项目明细和团队报告。";
  return teamReportGenerationResultSchema.parse({
    schemaVersion: "1.0",
    summary,
    sections: [
      {
        key: "project_progress",
        markdown: workCards
          .map(
            (workCard) =>
              `| ${reportTableCell(workCard.partnerName ?? workCard.partnerId)} | - | 本周期未采集到可用于汇报的工作记录，本报告不对其实际工作作出判断。 |`,
          )
          .reduce(
            (table, row) => `${table}\n${row}`,
            "| 成员 | 项目 | 本周工作明细 |\n| --- | --- | --- |",
          ),
        claims: workCards.map((workCard) => ({
          claim: `${workCard.partnerName ?? workCard.partnerId}本周期没有可用于汇报的工作记录。`,
          workCardSnapshotIds: [workCard.snapshotId],
        })),
      },
      {
        key: "week_comparison",
        markdown:
          "| 成员 | 项目 | 与上周相比 |\n| --- | --- | --- |\n| - | - | 本周期缺少可用于汇报的工作记录，无法与上周作出可靠比较。 |",
        claims: [
          {
            claim: "本周期资料不足，无法进行周度对比。",
            workCardSnapshotIds: snapshotIds,
          },
        ],
      },
      {
        key: "risks",
        markdown:
          "| 成员 | 项目 | 风险与阻塞 |\n| --- | --- | --- |\n| - | - | 本周期缺少可用于汇报的记录，无法仅根据本报告判断项目进展和风险；这属于报告覆盖范围限制，不代表实际工作存在异常。 |",
        claims: [
          {
            claim: "本周期报告存在记录覆盖范围限制。",
            workCardSnapshotIds: snapshotIds,
          },
        ],
      },
    ],
    missingPartnerIds: [],
    qualityWarnings: ["NO_REPORTABLE_ACTIVITY_COLLECTED"],
    production: {
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-31.team.v18",
      schemaVersion: "1.0",
      producer: "data-platform",
      modelVersion: model,
    },
  });
}

function finalizeTeamReport(result: any, reportDate: string) {
  const sections = result.sections.map((section: any) => ({
    ...section,
    title:
      teamReportSectionTitles[
        section.key as keyof typeof teamReportSectionTitles
      ],
    markdown: section.markdown,
  }));
  return {
    ...result,
    title: `团队周报 ${reportDate}`,
    summary: normalizeTeamReportSummary(result.summary),
    production: {
      ...result.production,
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-31.team.v18",
      schemaVersion: "1.0",
      producer: "data-platform",
    },
    sections,
    markdown: sections
      .map(
        (section: any) =>
          `## ${section.title}\n\n${section.markdown.trim() || "工作卡片未提供相关内容。"}`,
      )
      .join("\n\n"),
  };
}

export function normalizeTeamReportGeneration(
  generated: any,
  workCards: Array<{ snapshotId: string }>,
  missingPartnerIds: string[],
  model: string,
) {
  const allowedSnapshotIds = new Set(
    workCards.map((workCard) => workCard.snapshotId),
  );
  const sourceSections = Array.isArray(generated.sections)
    ? generated.sections
    : [];
  const qualityWarnings = Array.isArray(generated.qualityWarnings)
    ? generated.qualityWarnings.filter(
        (warning: unknown): warning is string => typeof warning === "string",
      )
    : [];
  const sections = teamReportSectionKeys.map((key) => {
    const matching = sourceSections.filter(
      (section: any) => section.key === key,
    );
    if (matching.length !== 1)
      qualityWarnings.push("MODEL_TEAM_REPORT_SECTIONS_NORMALIZED");
    const markdown = matching
      .map((section: any) =>
        typeof section.markdown === "string" ? section.markdown.trim() : "",
      )
      .filter(Boolean)
      .join("\n\n");
    const claims = matching
      .flatMap((section: any) =>
        Array.isArray(section.claims) ? section.claims : [],
      )
      .flatMap((claim: any) => {
        const text = typeof claim?.claim === "string" ? claim.claim.trim() : "";
        const snapshotIds = Array.isArray(claim?.workCardSnapshotIds)
          ? claim.workCardSnapshotIds.filter(
              (id: unknown): id is string =>
                typeof id === "string" && allowedSnapshotIds.has(id),
            )
          : [];
        return text && snapshotIds.length > 0
          ? [{ claim: text, workCardSnapshotIds: [...new Set(snapshotIds)] }]
          : [];
      });
    return {
      key,
      markdown: structuredSectionMarkdown(
        key,
        markdown || "本期工作卡片未提供这一部分的相关内容。",
        qualityWarnings,
      ),
      claims,
    };
  });
  const summary = normalizeTeamReportSummary(
    typeof generated.summary === "string" ? generated.summary : "",
  );
  return {
    schemaVersion: "1.0",
    summary:
      summary || "本周期团队报告已根据已确认的工作卡片生成，具体内容见下方。",
    sections,
    missingPartnerIds,
    qualityWarnings: [...new Set(qualityWarnings)],
    production: {
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-31.team.v18",
      schemaVersion: "1.0",
      producer: "data-platform",
      modelVersion: model,
    },
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
          'AGGREGATE_WORK_ITEMS', 'GENERATE_TEAM_REPORT', 'REGENERATE_TEAM_REPORT',
          'SYSTEM_HEALTH_QUEUE', 'SYSTEM_HEALTH_GENERATION', 'SYSTEM_HEALTH_REPORTS',
          'ANALYZE_PLUGIN_LOGS', 'ANALYZE_SYSTEM_LOGS'
        )
        and attempt_count < max_attempts
        and (status = 'PENDING' or updated_at < now() - interval '1 minute')
      order by case when type like 'SYSTEM_HEALTH_%' then 0 else 1 end,
        created_at asc
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

export function normalizeAggregation(job: Job, output: unknown, model: string) {
  const result = aggregationResultSchema.parse(output);
  const sourceGroups = Array.isArray(result.groups) ? result.groups : [];
  const groupsByProject = new Map<string, any>();
  const qualityWarnings = Array.isArray(result.qualityWarnings)
    ? result.qualityWarnings.filter(
        (warning: unknown): warning is string => typeof warning === "string",
      )
    : [];
  for (const group of sourceGroups) {
    if (!group.projectKey || groupsByProject.has(group.projectKey)) continue;
    groupsByProject.set(group.projectKey, group);
  }
  const buckets = Array.isArray(job.input_payload.projectBuckets)
    ? job.input_payload.projectBuckets
    : [];
  const groups = buckets.map((bucket: any) => {
    const group = groupsByProject.get(bucket.projectKey);
    if (!group && !qualityWarnings.includes("MODEL_PROJECT_BUCKET_MISSING"))
      qualityWarnings.push("MODEL_PROJECT_BUCKET_MISSING");
    const progressByDate = new Map<string, string>();
    for (const entry of group?.dailyProgress ?? []) {
      const date = typeof entry?.date === "string" ? entry.date.trim() : "";
      const summary =
        typeof entry?.summary === "string" ? entry.summary.trim() : "";
      if (!date || !summary) continue;
      const previous = progressByDate.get(date);
      progressByDate.set(
        date,
        previous && previous !== summary ? `${previous} ${summary}` : summary,
      );
    }
    const parsedStatus = workStatusSchema.safeParse(group?.status);
    const requestedStatus = parsedStatus.success
      ? parsedStatus.data
      : "awaiting_validation";
    const status = projectStatusWithCompletionSupport(requestedStatus, bucket);
    if (status !== requestedStatus)
      qualityWarnings.push("COMPLETION_EVIDENCE_MISSING");
    const sourceDescription =
      typeof bucket.projectDescription === "string"
        ? bucket.projectDescription
        : "";
    return {
      projectKey: bucket.projectKey,
      projectDescription: sourceDescription,
      status,
      overview:
        typeof group?.overview === "string" && group.overview.trim()
          ? group.overview.trim()
          : "本次模型未能完整整理项目概览，请在审核时补充或重新生成。",
      dailyProgress: [...progressByDate.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, summary]) => ({ date, summary })),
    };
  });
  return {
    schemaVersion: "1.0",
    groups,
    qualityWarnings: [...new Set(qualityWarnings)],
    production: {
      skillVersion: "partner-report-platform/0.3.0",
      promptVersion: "2026-08-28.project-card.v7",
      schemaVersion: "1.0",
      producer: "data-platform",
      modelVersion: model,
    },
  };
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

async function applyAggregation(job: Job, output: unknown, model: string) {
  const result = normalizeAggregation(job, output, model);
  const reviewId = job.input_payload.reviewId as string;
  const targetWorkItemId = job.input_payload.targetWorkItemId as
    string | undefined;
  if (targetWorkItemId) {
    const group = result.groups[0];
    const bucket = job.input_payload.projectBuckets[0];
    if (!group || !bucket || result.groups.length !== 1)
      throw new Error("PROJECT_CARD_REGENERATION_INVALID");
    await sql.begin(async (tx) => {
      const versionRows = await tx<Array<{ version: number }>>`
        select coalesce(max(version), 0)::int as version
        from work_item_versions
        where tenant_id = ${job.tenant_id} and work_item_id = ${targetWorkItemId}
      `;
      const nextVersion = (versionRows[0]?.version ?? 0) + 1;
      const payload = projectCardPayload(group, bucket);
      const updated = await tx<{ id: string }[]>`
        update work_items set
          project_id = ${bucket.projectId}, title = ${bucket.projectName},
          status = ${group.status}, review_status = 'pending',
          fact_ids = ${JSON.stringify(bucket.factIds)}::jsonb,
          payload = ${JSON.stringify(payload)}::jsonb,
          updated_at = now()
        where id = ${targetWorkItemId} and tenant_id = ${job.tenant_id}
          and review_id = ${reviewId}
        returning id
      `;
      if (!updated[0]) throw new Error("PROJECT_CARD_NOT_FOUND");
      await tx`
        insert into work_item_versions (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          work_item_id, version, title, status, payload, instruction, source
        ) values (
          ${randomUUID()}, ${job.tenant_id}, ${job.team_id}, ${job.partner_id},
          ${job.input_payload.period.id}, ${reviewId}, ${targetWorkItemId},
          ${nextVersion}, ${bucket.projectName}, ${group.status},
          ${JSON.stringify(payload)}::jsonb,
          ${job.input_payload.reviewInstruction ?? null}, 'regenerated'
        )
      `;
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
      await tx`
        insert into work_item_versions (
          id, tenant_id, team_id, partner_id, period_id, review_id,
          work_item_id, version, title, status, payload, source
        ) values (
          ${randomUUID()}, ${job.tenant_id}, ${job.team_id}, ${job.partner_id},
          ${job.input_payload.period.id}, ${reviewId}, ${workItemId}, 1,
          ${bucket.projectName}, ${group.status}, ${JSON.stringify(payload)}::jsonb,
          'generated'
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
      insert into outbox_events (
        id, tenant_id, event_type, aggregate_type, aggregate_id, payload
      ) values (
        ${randomUUID()}, ${job.tenant_id}, 'work_items.draft.created',
        'review', ${reviewId},
        ${JSON.stringify({
          count: result.groups.length,
          warnings: result.qualityWarnings,
        })}::jsonb
      )
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
  const modelOutput = teamReportGenerationResultSchema.parse(output);
  const generated = normalizeTeamReportGeneration(
    modelOutput,
    job.input_payload.workCards,
    job.input_payload.missingPartnerIds,
    model,
  );
  const reportDate = formatReportDate(new Date(job.created_at), timezone);
  const result = teamReportResultSchema.parse(
    finalizeTeamReport(generated, reportDate),
  );
  const reports = await sql<any[]>`
    select * from team_reports where id = ${job.input_payload.reportId}
      and tenant_id = ${job.tenant_id} limit 1
  `;
  const report = reports[0];
  if (
    !report ||
    (report.status === "LOCKED" && job.type !== "REGENERATE_TEAM_REPORT")
  )
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

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 900);
}

function generationErrorCode(error: unknown) {
  if (error instanceof ModelRequestTimeoutError) return error.code;
  return modelGatewayConfigured()
    ? "CENTRAL_GENERATION_FAILED"
    : "MODEL_NOT_CONFIGURED";
}

async function runSystemHealthJob(job: Job) {
  if (job.type === "SYSTEM_HEALTH_QUEUE") {
    return { ok: true, component: "queue" };
  }
  if (job.type === "SYSTEM_HEALTH_GENERATION") {
    const { model } = await selectedTeamSettingsFor(job);
    await generateStructured({
      name: "partner_report_system_health",
      schema: modelHealthSchema,
      instructions: 'Return {"ok":true}.',
      input: { probe: "content_generation" },
      model,
      timeoutMs: 25_000,
      maxOutputTokens: 64,
    });
    return { ok: true, component: "generation", model };
  }
  if (job.type === "SYSTEM_HEALTH_REPORTS") {
    const generated = buildNoActivityTeamReport(
      [
        {
          partnerId: "00000000-0000-4000-8000-000000000001",
          partnerName: "测试成员",
          snapshotId: "00000000-0000-4000-8000-000000000002",
        },
      ],
      "health-check",
    );
    teamReportGenerationResultSchema.parse(generated);
    return { ok: true, component: "reports" };
  }
  throw new Error(`UNSUPPORTED_SYSTEM_HEALTH_JOB:${job.type}`);
}

async function runPluginLogAnalysisJob(job: Job) {
  if (!job.plugin_instance_id) throw new Error("PLUGIN_INSTANCE_MISSING");
  const invocationId =
    typeof job.input_payload.invocationId === "string"
      ? job.input_payload.invocationId
      : null;
  const runId =
    typeof job.input_payload.runId === "string"
      ? job.input_payload.runId
      : null;
  if (!invocationId && !runId) throw new Error("PLUGIN_EXECUTION_ID_MISSING");
  const events = await sql<any[]>`
    select sequence, command, event_type, level, stage, event_code, message,
      stack, retryable, attempt, duration_ms, request_id, details, occurred_at
    from plugin_log_events
    where tenant_id = ${job.tenant_id}
      and plugin_instance_id = ${job.plugin_instance_id}
      and (
        (${invocationId}::uuid is not null and invocation_id = ${invocationId})
        or (${invocationId}::uuid is null and invocation_id is null and run_id = ${runId})
      )
    order by occurred_at asc, sequence asc nulls last
    limit 200
  `;
  if (events.length === 0) throw new Error("PLUGIN_EXECUTION_LOGS_MISSING");
  const { model } = await selectedTeamSettingsFor(job);
  const generated = await generateStructured<Record<string, unknown>>({
    name: "partner_report_plugin_log_analysis",
    schema: pluginLogAnalysisModelSchema,
    instructions:
      '你是 Partner Report 插件故障分析器。只根据提供的插件命令、结构化事件和输出摘要判断，不补充日志中没有的事实。插件链路依次包含：本地 Codex 会话读取、项目权限检查、模型结构化提取、结果校验、贡献上传和采集收尾。区分直接证据与推测；证据不足时降低 confidence 并明确说明。使用通俗、简短的中文，不暴露凭证、用户路径或会话内容。failedStep 写出具体失败环节，rootCause 解释最可能原因，evidence 优先返回由事件代码或计数组成的字符串数组，recommendedActions 返回中台管理员可执行的步骤数组。示例形状：{"summary":"会话读取阶段连续失败","failedStep":"读取本地 Codex 会话","rootCause":"日志表明会话历史格式无效","evidence":["CODEX_THREAD_HISTORY_INVALID: 6"],"recommendedActions":["让用户升级插件后重试"],"confidence":"high"}。',
    input: {
      command: job.input_payload.command,
      executionId: job.input_payload.executionId,
      events: events.map((event) => ({
        sequence: event.sequence,
        eventType: event.event_type,
        level: event.level,
        stage: event.stage,
        eventCode: event.event_code,
        message: event.message,
        retryable: event.retryable,
        attempt: event.attempt,
        durationMs: event.duration_ms,
        requestId: event.request_id,
        details: event.details,
        stack: event.stack ? String(event.stack).slice(0, 4000) : null,
        occurredAt: event.occurred_at,
      })),
    },
    model,
    timeoutMs: 35_000,
    maxOutputTokens: 900,
  });
  return normalizePluginLogAnalysis(
    generated,
    String(job.input_payload.command ?? "插件运行"),
  );
}

async function runSystemLogAnalysisJob(job: Job) {
  const events = Array.isArray(job.input_payload.events)
    ? job.input_payload.events.slice(0, 100)
    : [];
  if (events.length === 0) throw new Error("SYSTEM_EXECUTION_LOGS_MISSING");
  const { model } = await selectedTeamSettingsFor(job);
  const generated = await generateStructured<Record<string, unknown>>({
    name: "partner_report_system_log_analysis",
    schema: pluginLogAnalysisModelSchema,
    instructions:
      "你是 Partner Report 中台故障分析器。只根据提供的中台运行时间线判断，不补充日志中没有的事实。中台链路通常包括：接收请求或飞书操作、任务入队、模型生成、结果保存、飞书发送和报告归档。区分直接证据与推测；证据不足时降低 confidence。使用通俗、简短的中文，不暴露凭证、内部 Payload 或个人敏感信息。failedStep 指出具体失败环节，rootCause 解释最可能原因，evidence 返回事件代码或可核对的状态，recommendedActions 返回管理员可执行的步骤。",
    input: {
      executionId: job.input_payload.executionId,
      source: job.input_payload.source,
      title: job.input_payload.title,
      subject: job.input_payload.subject,
      events,
    },
    model,
    timeoutMs: 35_000,
    maxOutputTokens: 900,
  });
  return normalizePluginLogAnalysis(
    generated,
    String(job.input_payload.title ?? "中台处理"),
  );
}

function pluginLogAnalysisError(error: unknown) {
  if (error instanceof z.ZodError)
    return {
      code: "MODEL_ANALYSIS_FORMAT_INVALID",
      message: "模型返回的诊断格式不完整，请重新分析。",
    };
  if (error instanceof ModelRequestTimeoutError)
    return { code: error.code, message: "模型分析超时，请稍后重试。" };
  if (!modelGatewayConfigured())
    return {
      code: "MODEL_NOT_CONFIGURED",
      message: "中台尚未配置可用的模型服务。",
    };
  return {
    code: "PLUGIN_LOG_ANALYSIS_FAILED",
    message: "模型分析暂时失败，请稍后重试。",
  };
}

function systemLogAnalysisError(error: unknown) {
  const base = pluginLogAnalysisError(error);
  return base.code === "PLUGIN_LOG_ANALYSIS_FAILED"
    ? {
        code: "SYSTEM_LOG_ANALYSIS_FAILED",
        message: "中台日志模型分析暂时失败，请稍后重试。",
      }
    : base;
}

function systemHealthErrorCode(job: Job, error: unknown) {
  if (job.type === "SYSTEM_HEALTH_QUEUE") return "QUEUE_WORKER_UNHEALTHY";
  if (job.type === "SYSTEM_HEALTH_REPORTS") return "REPORT_PIPELINE_UNHEALTHY";
  return generationErrorCode(error);
}

export async function processNextGenerationJob(onlyTenantId?: string) {
  const job = await leaseNextJob(onlyTenantId);
  if (!job) return { processed: false };
  try {
    if (isSystemHealthJob(job.type)) {
      const output = await runSystemHealthJob(job);
      await sql`
        update agent_jobs set status = 'COMPLETED',
          output_payload = ${JSON.stringify(output)}::jsonb,
          completed_at = now(), lease_until = null, error_code = null,
          error_message = null, updated_at = now()
        where id = ${job.id} and status = 'LEASED'
      `;
      return { processed: true, jobId: job.id, type: job.type };
    }
    if (
      job.type === "ANALYZE_PLUGIN_LOGS" ||
      job.type === "ANALYZE_SYSTEM_LOGS"
    ) {
      const output =
        job.type === "ANALYZE_PLUGIN_LOGS"
          ? await runPluginLogAnalysisJob(job)
          : await runSystemLogAnalysisJob(job);
      await sql`
        update agent_jobs set status = 'COMPLETED',
          output_payload = ${JSON.stringify(output)}::jsonb,
          completed_at = now(), lease_until = null, error_code = null,
          error_message = null, updated_at = now()
        where id = ${job.id} and status = 'LEASED'
      `;
      return { processed: true, jobId: job.id, type: job.type };
    }
    const { model, timezone } = await selectedTeamSettingsFor(job);
    const isAggregation = job.type === "AGGREGATE_WORK_ITEMS";
    const isTeamReport = [
      "GENERATE_TEAM_REPORT",
      "REGENERATE_TEAM_REPORT",
    ].includes(job.type);
    const allWorkCardsHaveNoActivity =
      isTeamReport &&
      job.input_payload.workCards.length > 0 &&
      job.input_payload.workCards.every(
        (workCard: any) => workCard.noReportableActivity === true,
      );
    const output = isAggregation
      ? await generateAggregationByProject(job, model)
      : isTeamReport
        ? allWorkCardsHaveNoActivity
          ? buildNoActivityTeamReport(job.input_payload.workCards, model)
          : await generateTeamReport(job, model)
        : (() => {
            throw new Error(`UNSUPPORTED_GENERATION_JOB:${job.type}`);
          })();
    const applied = isAggregation
      ? await applyAggregation(job, output, model)
      : isTeamReport
        ? await applyTeamReport(job, output, model, timezone)
        : (() => {
            throw new Error(`UNSUPPORTED_GENERATION_JOB:${job.type}`);
          })();
    await sql.begin(async (tx) => {
      await tx`
        update agent_jobs set status = 'COMPLETED', output_payload = ${JSON.stringify(applied)}::jsonb,
          completed_at = now(), lease_until = null, error_code = null, error_message = null, updated_at = now()
        where id = ${job.id} and status = 'LEASED'
      `;
      if (
        isAggregation &&
        typeof job.input_payload.targetWorkItemId === "string" &&
        typeof job.input_payload.reviewId === "string"
      ) {
        await tx`
          insert into outbox_events (
            id, tenant_id, event_type, aggregate_type, aggregate_id, payload
          ) values (
            ${randomUUID()}, ${job.tenant_id}, 'work_items.draft.created',
            'review', ${job.input_payload.reviewId},
            ${JSON.stringify({
              count: 1,
              targetWorkItemId: job.input_payload.targetWorkItemId,
              regenerated: true,
              warnings: applied.qualityWarnings,
            })}::jsonb
          )
        `;
      }
    });
    return { processed: true, jobId: job.id, type: job.type };
  } catch (error) {
    const terminal = job.attempt_count >= job.max_attempts;
    const analysisError =
      job.type === "ANALYZE_PLUGIN_LOGS"
        ? pluginLogAnalysisError(error)
        : job.type === "ANALYZE_SYSTEM_LOGS"
          ? systemLogAnalysisError(error)
          : null;
    const errorCode =
      analysisError?.code ??
      (isSystemHealthJob(job.type)
        ? systemHealthErrorCode(job, error)
        : generationErrorCode(error));
    const errorMessage = analysisError?.message ?? safeError(error);
    await sql.begin(async (tx) => {
      await tx`
        update agent_jobs set status = ${terminal ? "FAILED" : "RETRY_WAIT"},
          error_code = ${errorCode}, error_message = ${errorMessage},
          lease_until = null, updated_at = now()
        where id = ${job.id} and status = 'LEASED'
      `;
      if (
        terminal &&
        job.type === "AGGREGATE_WORK_ITEMS" &&
        typeof job.input_payload.targetWorkItemId === "string" &&
        typeof job.input_payload.reviewId === "string"
      ) {
        await tx`
          insert into outbox_events (
            id, tenant_id, event_type, aggregate_type, aggregate_id, payload
          ) values (
            ${randomUUID()}, ${job.tenant_id}, 'work_items.regeneration.failed',
            'review', ${job.input_payload.reviewId},
            ${JSON.stringify({
              jobId: job.id,
              targetWorkItemId: job.input_payload.targetWorkItemId,
            })}::jsonb
          )
        `;
      }
    });
    return { processed: true, jobId: job.id, type: job.type, failed: true };
  }
}
