import { describe, expect, it } from "vitest";
import {
  aggregationInstructions,
  bucketHasCompletionSupport,
  assertExactTeamReportProjectDescriptions,
  assertExactTeamReportProjectNames,
  assertLeaderReadableTeamReport,
  assertNoActivityTeamCoverage,
  buildNoActivityTeamReport,
  formatReportDate,
  injectApprovedProjectDescriptions,
  normalizeTeamReportSummary,
  projectStatusWithCompletionSupport,
} from "./generation.js";

describe("reader-facing generation instructions", () => {
  it("asks work cards to use short, plain Chinese", () => {
    const instructions = aggregationInstructions("test-model");

    expect(instructions).toContain("simplified Chinese");
    expect(instructions).toContain("plain, direct, concise language");
    expect(instructions).toContain("120 Chinese characters");
    expect(instructions).toContain("80 Chinese characters");
    expect(instructions).toContain("projectDescription");
    expect(instructions).toContain(
      "copy each bucket.projectDescription exactly",
    );
    expect(instructions).toContain("user's correction as authoritative");
    expect(instructions).toContain("projectDescription only");
    expect(instructions).toContain("2026-08-12.project-card.v3");
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

  it("rejects short or technical leadership prose", () => {
    expect(() =>
      assertLeaderReadableTeamReport({
        summary: "本周完成重点工作。",
        sections: [{ markdown: "工作正常推进。" }],
      }),
    ).toThrow("TEAM_REPORT_SUMMARY_LENGTH");

    expect(() =>
      assertLeaderReadableTeamReport({
        summary:
          "本周团队围绕重点工作完成梳理、改进和验证，相关流程运行正常，并形成了可继续使用的阶段成果。".repeat(
            9,
          ),
        sections: [{ markdown: "- 项目：SSH 配置已经完成。" }],
      }),
    ).toThrow("TEAM_REPORT_TECHNICAL_JARGON:SSH");
  });

  it("requires exact source project names in top-level summary bullets", () => {
    expect(() =>
      assertExactTeamReportProjectNames(
        {
          sections: [
            {
              key: "summary",
              markdown:
                "- partner-report-agent：完成验证。\n- pi-web：完成前端工作。",
            },
          ],
        },
        [
          { projectNames: ["partner-report-agent"] },
          { projectNames: ["pi-web"] },
        ],
      ),
    ).not.toThrow();

    expect(() =>
      assertExactTeamReportProjectNames(
        {
          sections: [
            {
              key: "summary",
              markdown: "- 插件与前端：完成相关工作。",
            },
          ],
        },
        [
          { projectNames: ["partner-report-agent"] },
          { projectNames: ["pi-web"] },
        ],
      ),
    ).toThrow("TEAM_REPORT_PROJECT_NAMES_MISMATCH");
  });

  it("requires approved project descriptions in the project summary", () => {
    const source = [
      {
        projectDescriptions: [
          {
            name: "partner-report-agent",
            description: "用于采集、审核并汇总团队工作记录的报告平台。",
          },
        ],
      },
    ];
    expect(() =>
      assertExactTeamReportProjectDescriptions(
        {
          sections: [
            {
              key: "summary",
              markdown:
                "- partner-report-agent：用于采集、审核并汇总团队工作记录的报告平台。",
            },
          ],
        },
        source,
      ),
    ).not.toThrow();
    expect(() =>
      assertExactTeamReportProjectDescriptions(
        {
          sections: [
            {
              key: "summary",
              markdown: "- partner-report-agent：本周有进展。",
            },
          ],
        },
        source,
      ),
    ).toThrow("TEAM_REPORT_PROJECT_DESCRIPTION_MISSING");
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

  it("requires every no-activity person without claiming they did no work", () => {
    const source = [
      {
        partnerId: "partner-a",
        partnerName: "林勇",
        noReportableActivity: true,
      },
    ];
    expect(() =>
      assertNoActivityTeamCoverage(
        {
          sections: [
            {
              key: "project_progress",
              markdown: "- 林勇：本周期未采集到可用于汇报的工作记录。",
            },
          ],
        },
        source,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoActivityTeamCoverage(
        {
          sections: [
            { key: "project_progress", markdown: "- 林勇：本周期没有工作。" },
          ],
        },
        source,
      ),
    ).toThrow("TEAM_REPORT_NO_ACTIVITY_UNSUPPORTED_JUDGMENT");
    expect(() =>
      assertNoActivityTeamCoverage(
        {
          sections: [
            { key: "project_progress", markdown: "- 其他人员：暂无记录。" },
          ],
        },
        source,
      ),
    ).toThrow("TEAM_REPORT_NO_ACTIVITY_PARTNER_MISSING:林勇");
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
