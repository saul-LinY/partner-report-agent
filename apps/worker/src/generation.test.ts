import { describe, expect, it } from "vitest";
import {
  aggregationInstructions,
  bucketHasCompletionSupport,
  buildNoActivityTeamReport,
  formatReportDate,
  injectApprovedProjectDescriptions,
  normalizeAggregation,
  normalizePluginLogAnalysis,
  normalizeTeamReportGeneration,
  normalizeTeamReportSummary,
  projectStatusWithCompletionSupport,
} from "./generation.js";

describe("reader-facing generation instructions", () => {
  it("asks work cards to use detailed, plain Chinese", () => {
    const instructions = aggregationInstructions("test-model");

    expect(instructions).toContain("simplified Chinese");
    expect(instructions).toContain("plain, direct, everyday Chinese");
    expect(instructions).toContain("120 to 240 Chinese characters");
    expect(instructions).toContain("about 150 Chinese characters");
    expect(instructions).toContain("never more than 200");
    expect(instructions).toContain("around 200 Chinese characters");
    expect(instructions).toContain("detailed enough for the user to verify");
    expect(instructions).toContain("authoritative first-hand correction");
    expect(instructions).toContain("projectDescription");
    expect(instructions).toContain(
      "copy each bucket.projectDescription exactly",
    );
    expect(instructions).toContain("must not silently change");
    expect(instructions).toContain("2026-08-27.project-card.v6");
  });
});

describe("plugin log model analysis", () => {
  it("normalizes a useful but loosely shaped model response", () => {
    expect(
      normalizePluginLogAnalysis(
        {
          failedStep: "读取本地会话",
          cause: "连续六次返回会话历史格式无效。",
          evidence: "CODEX_THREAD_HISTORY_INVALID: 6",
          actions: ["升级插件后重新采集"],
          confidence: "high",
        },
        "采集命令",
      ),
    ).toEqual({
      summary: "读取本地会话",
      failedStep: "读取本地会话",
      rootCause: "连续六次返回会话历史格式无效。",
      evidence: ["CODEX_THREAD_HISTORY_INVALID: 6"],
      recommendedActions: ["升级插件后重新采集"],
      confidence: "high",
    });
  });
});

describe("project completion support", () => {
  it("accepts a credible Session outcome", () => {
    expect(
      bucketHasCompletionSupport({
        facts: [
          {
            payload: {
              recordType: "session_contribution",
              contributions: [
                { kind: "outcome", confidence: "medium", text: "已交付" },
              ],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects progress-only material as completion evidence", () => {
    expect(
      bucketHasCompletionSupport({
        facts: [
          {
            payload: {
              recordType: "session_contribution",
              contributions: [
                { kind: "progress", confidence: "high", text: "持续推进" },
                { kind: "outcome", confidence: "low", text: "可能完成" },
              ],
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      projectStatusWithCompletionSupport("completed", {
        facts: [
          {
            payload: {
              recordType: "session_contribution",
              contributions: [{ kind: "progress", confidence: "high" }],
            },
          },
        ],
      }),
    ).toBe("awaiting_validation");
  });
});

describe("work card model output normalization", () => {
  it("sorts progress and fills an omitted project instead of failing", () => {
    const result = normalizeAggregation(
      {
        input_payload: {
          projectBuckets: [
            {
              projectKey: "project-a",
              projectDescription: "已审核的项目简介。",
              facts: [],
            },
            {
              projectKey: "project-b",
              projectDescription: "第二个项目简介。",
              facts: [],
            },
          ],
        },
      } as any,
      {
        schemaVersion: "1.0",
        groups: [
          {
            projectKey: "project-a",
            projectDescription: "模型擅自改写的简介。",
            status: "in_progress",
            overview: "项目正常推进。",
            dailyProgress: [
              { date: "2026-08-27", summary: "后一天。" },
              { date: "2026-08-26", summary: "前一天。" },
            ],
          },
        ],
        qualityWarnings: [],
        production: {
          skillVersion: "partner-report-platform/0.3.0",
          promptVersion: "test",
          schemaVersion: "1.0",
          producer: "data-platform",
        },
      },
      "test-model",
    );

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].projectDescription).toBe("已审核的项目简介。");
    expect(
      result.groups[0].dailyProgress.map(
        (entry: { date: string }) => entry.date,
      ),
    ).toEqual(["2026-08-26", "2026-08-27"]);
    expect(result.groups[1]).toMatchObject({
      projectKey: "project-b",
      status: "awaiting_validation",
    });
    expect(result.qualityWarnings).toContain("MODEL_PROJECT_BUCKET_MISSING");
  });
});

describe("Team Report numbering", () => {
  it("builds an honest Team Report when every person has no reportable record", () => {
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    const report = buildNoActivityTeamReport(
      [{ partnerId: "partner-a", partnerName: "林勇", snapshotId }],
      "gpt-5.6-sol",
    );

    expect(
      Array.from(report.summary.replace(/\s/gu, "")).length,
    ).toBeGreaterThanOrEqual(250);
    expect(report.sections).toHaveLength(3);
    expect(report.sections[1].markdown).toContain("不对其实际工作作出判断");
    expect(report.qualityWarnings).toContain(
      "NO_REPORTABLE_ACTIVITY_COLLECTED",
    );
  });

  it("normalizes model deviations without blocking report generation", () => {
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    const report = normalizeTeamReportGeneration(
      {
        summary: "简短摘要。",
        sections: [
          {
            key: "summary",
            markdown: "- 合并项目：本周有进展。",
            claims: [{ workCardSnapshotIds: [snapshotId] }],
          },
          {
            key: "project_progress",
            markdown: "林勇完成了相关工作。",
            claims: [
              {
                claim: "人员完成相关工作。",
                workCardSnapshotIds: [snapshotId, "unknown-snapshot"],
              },
            ],
          },
        ],
      },
      [{ snapshotId }],
      [],
      "test-model",
    );

    expect(report.summary).toBe("简短摘要。");
    expect(report.sections).toHaveLength(3);
    expect(report.sections[0]!.claims).toEqual([]);
    expect(report.sections[1]!.claims[0]!.workCardSnapshotIds).toEqual([
      snapshotId,
    ]);
    expect(report.sections[2]).toMatchObject({
      key: "risks",
      markdown: "本期工作卡片未提供这一部分的相关内容。",
    });
    expect(report.qualityWarnings).toContain(
      "MODEL_TEAM_REPORT_SECTIONS_NORMALIZED",
    );
  });

  it("injects approved descriptions without changing nested progress", () => {
    expect(
      injectApprovedProjectDescriptions(
        "- **partner-report-agent**：模型生成的周进展\n  - 林勇：完成审核链路。",
        [
          {
            projectDescriptions: [
              {
                name: "partner-report-agent",
                description: "用于采集和审核团队工作记录的报告平台。",
              },
            ],
          },
        ],
      ),
    ).toBe(
      "- **partner-report-agent**：用于采集和审核团队工作记录的报告平台。\n  - 林勇：完成审核链路。",
    );
  });

  it("formats the report creation date in the team's timezone", () => {
    const createdAt = new Date("2026-08-09T16:30:00.000Z");

    expect(formatReportDate(createdAt, "Asia/Shanghai")).toBe("2026-08-10");
    expect(formatReportDate(createdAt, "America/Los_Angeles")).toBe(
      "2026-08-09",
    );
  });

  it("turns a model-generated list into one summary paragraph", () => {
    expect(
      normalizeTeamReportSummary(
        "- Partner Report：完成生成链路修复。\n2. 数据平台：完成验证。",
      ),
    ).toBe("Partner Report：完成生成链路修复。 数据平台：完成验证。");
  });
});
