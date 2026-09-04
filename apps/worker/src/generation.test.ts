import { describe, expect, it } from "vitest";
import {
  aggregationInstructions,
  bucketHasCompletionSupport,
  buildNoActivityTeamReport,
  formatReportDate,
  normalizeAggregation,
  normalizePluginLogAnalysis,
  normalizeTeamReportGeneration,
  normalizeTeamReportSummary,
  projectAggregationInputs,
  projectStatusWithCompletionSupport,
} from "./generation.js";

describe("reader-facing generation instructions", () => {
  it("asks work cards to use concise, plain Chinese", () => {
    const instructions = aggregationInstructions("test-model");

    expect(instructions).toContain("simplified Chinese");
    expect(instructions).toContain("plain, direct, everyday Chinese");
    expect(instructions).toContain("80 to 100 Chinese characters");
    expect(instructions).toContain("about 50 Chinese characters");
    expect(instructions).toContain("never more than 60");
    expect(instructions).toContain("authoritative first-hand correction");
    expect(instructions).toContain("do not output a project description");
    expect(instructions).toContain("2026-08-28.project-card.v7");
  });
});

describe("project work card generation inputs", () => {
  it("creates one model input per project", () => {
    const input = {
      schemaVersion: "1.0",
      reviewId: "review-1",
      projectBuckets: [
        { projectKey: "project-a", facts: [{ id: "fact-a" }] },
        { projectKey: "project-b", facts: [{ id: "fact-b" }] },
      ],
    };

    expect(projectAggregationInputs(input)).toEqual([
      {
        schemaVersion: "1.0",
        reviewId: "review-1",
        projectBuckets: [input.projectBuckets[0]],
      },
      {
        schemaVersion: "1.0",
        reviewId: "review-1",
        projectBuckets: [input.projectBuckets[1]],
      },
    ]);
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
            status: "in_progress",
            overview: "概".repeat(121),
            dailyProgress: [
              { date: "2026-08-27", summary: "进".repeat(61) },
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
    expect(result.groups[0].overview).toBe("概".repeat(121));
    expect(result.groups[0].dailyProgress[1].summary).toBe("进".repeat(61));
    expect(result.groups[1]).toMatchObject({
      projectKey: "project-b",
      status: "awaiting_validation",
    });
    expect(result.qualityWarnings).toContain("MODEL_PROJECT_BUCKET_MISSING");
  });
});

describe("Team Report normalization", () => {
  it("builds an honest Team Report when every person has no reportable record", () => {
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    const report = buildNoActivityTeamReport(
      [{ partnerId: "partner-a", partnerName: "林勇", snapshotId }],
      "gpt-5.6-sol",
    );

    expect(report.summary).toContain("系统没有采集到可用于团队工作汇报的记录");
    expect(report.sections).toHaveLength(3);
    expect(report.sections[0].markdown).toContain(
      "| 成员 | 项目 | 本周工作明细 |",
    );
    expect(report.sections[0].markdown).toContain("| 林勇 | - |");
    expect(report.sections[0].markdown).toContain("不对其实际工作作出判断");
    expect(report.sections[1].markdown).toContain(
      "| 成员 | 项目 | 与上周相比 |",
    );
    expect(report.sections[2].markdown).toContain(
      "| 成员 | 项目 | 风险与阻塞 |",
    );
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
    expect(report.sections[0]!.markdown).toContain(
      "| 成员 | 项目 | 本周工作明细 |",
    );
    expect(report.sections[0]!.claims[0]!.workCardSnapshotIds).toEqual([
      snapshotId,
    ]);
    expect(report.sections[1]).toMatchObject({
      key: "week_comparison",
      markdown: expect.stringContaining("| 成员 | 项目 | 与上周相比 |"),
    });
    expect(report.sections[2]).toMatchObject({
      key: "risks",
      markdown: expect.stringContaining("| 成员 | 项目 | 风险与阻塞 |"),
    });
    expect(report.qualityWarnings).toContain(
      "MODEL_TEAM_REPORT_SECTIONS_NORMALIZED",
    );
  });

  it("preserves project progress descriptions longer than the prompt target", () => {
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    const report = normalizeTeamReportGeneration(
      {
        summary: "团队本周整体推进平稳。",
        sections: [
          {
            key: "project_progress",
            markdown: `| 成员 | 项目 | 本周工作明细 |\n| --- | --- | --- |\n| 林勇 | 项目甲 | ${"进".repeat(140)} |`,
            claims: [],
          },
          {
            key: "week_comparison",
            markdown:
              "| 成员 | 项目 | 与上周相比 |\n| --- | --- | --- |\n| 林勇 | 项目甲 | 本周新增完成验证。 |",
            claims: [],
          },
          {
            key: "risks",
            markdown:
              "| 成员 | 项目 | 风险与阻塞 |\n| --- | --- | --- |\n| - | - | 本周工作卡片未报告明确风险与阻塞。 |",
            claims: [],
          },
        ],
      },
      [{ snapshotId }],
      [],
      "test-model",
    );
    const detail = report.sections[0]!.markdown.split("\n")[2]!
      .split("|")[3]!
      .trim();

    expect(Array.from(detail)).toHaveLength(140);
    expect(detail).toBe("进".repeat(140));
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
