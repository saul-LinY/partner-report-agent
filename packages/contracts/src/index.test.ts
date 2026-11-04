import { describe, expect, it } from "vitest";
import {
  aggregationResultSchema,
  containsSensitiveValue,
  productionMetadataSchema,
  teamReportGenerationResultSchema,
  teamReportResultSchema,
} from "./index.js";

describe("production metadata contract", () => {
  it("accepts valid producer versions without a per-release allowlist", () => {
    const metadata = {
      promptVersion: "2026-08-05.zh-session-value.v3",
      schemaVersion: "1.0",
      producer: "codex-skill",
    };

    for (const skillVersion of [
      "partner-report-sync/0.4.0",
      "partner-report-sync/0.4.5",
      "partner-report-sync/1.0.0",
      "partner-report-platform/0.3.0",
    ]) {
      expect(
        productionMetadataSchema.safeParse({ ...metadata, skillVersion })
          .success,
      ).toBe(true);
    }

    for (const skillVersion of [
      "partner-report-sync/0.4",
      "partner-report-sync/latest",
      "other-plugin/0.4.5",
    ]) {
      expect(
        productionMetadataSchema.safeParse({ ...metadata, skillVersion })
          .success,
      ).toBe(false);
    }
  });
});

describe("project card aggregation contract", () => {
  it("accepts project focus and durable key events alongside the card", () => {
    const result = {
      schemaVersion: "1.0",
      groups: [
        {
          projectKey: "project:11111111-1111-4111-8111-111111111111",
          status: "in_progress",
          currentFocus: "补齐异常测试。",
          keyEvents: [
            {
              date: "2026-08-04",
              type: "milestone",
              title: "完成项目分桶",
              detail: "已确认项目归属。",
            },
          ],
          overview: "本周完成插件主链路收敛。",
          dailyProgress: [
            { date: "2026-08-03", summary: "完成项目分桶。" },
            { date: "2026-08-04", summary: "完成审核界面。" },
          ],
        },
      ],
      qualityWarnings: [],
      production: {
        skillVersion: "partner-report-platform/0.3.0",
        promptVersion: "2026-08-04.project-card.v1",
        schemaVersion: "1.0",
        producer: "data-platform",
      },
    };
    expect(aggregationResultSchema.safeParse(result).success).toBe(true);
    expect(
      aggregationResultSchema.safeParse({
        ...result,
        groups: [
          {
            ...result.groups[0],
            overview: "进".repeat(121),
            dailyProgress: [{ date: "2026-08-03", summary: "进".repeat(61) }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      aggregationResultSchema.safeParse({
        ...result,
        groups: [
          { ...result.groups[0], factIds: ["model-must-not-assign-facts"] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("team report model output contract", () => {
  it("does not reject content-quality deviations", () => {
    expect(
      teamReportGenerationResultSchema.safeParse({
        schemaVersion: "1.0",
        summary: "管理概览".repeat(70),
        sections: [
          {
            key: "project_progress",
            markdown: "人员进展。",
            claims: [],
          },
        ],
        missingPartnerIds: [],
        qualityWarnings: [],
        production: {
          skillVersion: "partner-report-platform/0.3.0",
          promptVersion: "2026-08-31.team.v18",
          schemaVersion: "1.0",
          producer: "data-platform",
        },
      }).success,
    ).toBe(true);
    expect(
      teamReportGenerationResultSchema.safeParse({
        schemaVersion: "1.0",
        summary: "管".repeat(361),
        sections: [],
        production: {
          skillVersion: "partner-report-platform/0.3.0",
          promptVersion: "2026-08-31.team.v18",
          schemaVersion: "1.0",
          producer: "data-platform",
        },
      }).success,
    ).toBe(true);
    expect(
      teamReportResultSchema.safeParse({
        schemaVersion: "1.0",
        title: "团队周报",
        summary: "过短概览。",
        sections: [
          {
            key: "project_progress",
            title: "项目与人员工作明细",
            markdown: "表格",
          },
          {
            key: "week_comparison",
            title: "与上周工作对比",
            markdown: "表格",
          },
          { key: "risks", title: "风险与阻塞", markdown: "表格" },
        ],
        markdown: "正文",
        production: {
          skillVersion: "partner-report-platform/0.3.0",
          promptVersion: "2026-08-31.team.v18",
          schemaVersion: "1.0",
          producer: "data-platform",
        },
      }).success,
    ).toBe(true);
  });
});

describe("sensitive payload guard", () => {
  it.each([
    { note: "sk-abcdefghijklmnop1234" },
    { authorization: "Bearer abcdefghijklmnopqrstuvwxyz.123" },
    { config: "api_key=abcdefghijklmnop" },
    { key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" },
  ])("blocks known credential shapes", (payload) => {
    expect(containsSensitiveValue(payload)).toBe(true);
  });

  it("does not reject ordinary report language", () => {
    expect(
      containsSensitiveValue({
        blockers: ["补齐应用消息接入协议"],
        status: "completed",
      }),
    ).toBe(false);
  });
});
