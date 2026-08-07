import { describe, expect, it } from "vitest";
import {
  assertChineseTeamReport,
  assertReportSemantics,
  assertTeamReportSemantics,
  aggregationResultSchema,
  containsSensitiveValue,
  connectivityTestSchema,
  individualReportResultSchema,
  pluginDiagnosticBatchSchema,
  productionMetadataSchema,
  sessionContributionSchema,
  sessionExtractionResultSchema,
} from "./index.js";

describe("plugin connectivity contract", () => {
  const valid = {
    challenge: "connectivity-challenge-value-123456",
    pluginVersion: "0.2.0",
    clientTime: "2026-08-04T01:45:36.384Z",
    capabilityVersion: "1.0",
  };

  it("accepts only the bounded authentication test payload", () => {
    expect(connectivityTestSchema.safeParse(valid).success).toBe(true);
    expect(
      connectivityTestSchema.safeParse({
        ...valid,
        sessionId: "must-not-be-sent",
      }).success,
    ).toBe(false);
    expect(
      connectivityTestSchema.safeParse({
        ...valid,
        facts: [],
      }).success,
    ).toBe(false);
  });
});

describe("plugin diagnostic contract", () => {
  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    stage: "sync",
    errorCode: "SYNC_FAILED",
    occurredAt: "2026-08-04T01:45:36.384Z",
    retryable: true,
  };

  it("accepts bounded fields and rejects client-authored error messages", () => {
    expect(
      pluginDiagnosticBatchSchema.safeParse({ events: [event] }).success,
    ).toBe(true);
    expect(
      pluginDiagnosticBatchSchema.safeParse({
        events: [{ ...event, safeMessage: "raw local exception" }],
      }).success,
    ).toBe(false);
  });
});

describe("session contribution contract", () => {
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

  it("accepts an anonymous session-level contribution", () => {
    const base = {
      schemaVersion: "1.0",
      periodKey: "2026-W32",
      sessionKey: "a".repeat(64),
      contentHash: "b".repeat(64),
      observedAt: "2026-08-03T05:00:00.000Z",
      activity: {
        startedAt: "2026-08-03T03:00:00.000Z",
        endedAt: "2026-08-03T04:00:00.000Z",
      },
      title: "重构采集插件",
      summary: "把采集粒度调整为 Session。",
      status: "in_progress",
      contributions: [
        { kind: "decision", text: "使用 Session 级摘要。", confidence: "high" },
      ],
      production: {
        skillVersion: "partner-report-sync/0.3.0",
        promptVersion: "2026-08-04.session.v1",
        schemaVersion: "1.0",
        producer: "codex-skill",
      },
    };
    expect(
      sessionContributionSchema.safeParse({
        ...base,
        project: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "partner-report-agent",
          matchMethod: "descendant_path",
          rootFingerprint: "c".repeat(64),
        },
      }).success,
    ).toBe(true);
  });

  it("requires safe project discovery metadata and ordered activity", () => {
    const base = {
      schemaVersion: "1.0",
      periodKey: "2026-W32",
      sessionKey: "a".repeat(64),
      contentHash: "b".repeat(64),
      observedAt: "2026-08-03T05:00:00.000Z",
      activity: {
        startedAt: "2026-08-03T05:00:00.000Z",
        endedAt: "2026-08-03T04:00:00.000Z",
      },
      title: "重构采集插件",
      summary: "Session 摘要。",
      status: "in_progress",
      contributions: [],
      production: {
        skillVersion: "partner-report-sync/0.3.0",
        promptVersion: "2026-08-04.session.v1",
        schemaVersion: "1.0",
        producer: "codex-skill",
      },
    };
    expect(
      sessionContributionSchema.safeParse({
        ...base,
        project: {
          id: null,
          name: "automatic-project",
          matchMethod: "path_discovered",
          rootFingerprint: "c".repeat(64),
          rootName: "automatic-project",
        },
      }).success,
    ).toBe(false);
    expect(
      sessionContributionSchema.safeParse({
        ...base,
        activity: {
          startedAt: "2026-08-03T03:00:00.000Z",
          endedAt: "2026-08-03T04:00:00.000Z",
        },
        project: {
          id: null,
          name: "automatic-project",
          matchMethod: "path_discovered",
          rootFingerprint: "c".repeat(64),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an upload without a meaningful contribution item", () => {
    const parsed = sessionContributionSchema.safeParse({
      schemaVersion: "1.0",
      periodKey: "2026-W32",
      sessionKey: "a".repeat(64),
      contentHash: "b".repeat(64),
      project: {
        id: null,
        name: "Independent work",
        matchMethod: "unassigned",
        rootFingerprint: "c".repeat(64),
      },
      activity: {
        startedAt: "2026-08-03T03:00:00.000Z",
        endedAt: "2026-08-03T04:00:00.000Z",
      },
      title: "闲聊",
      summary: "没有项目贡献。",
      status: "discussion",
      contributions: [],
      observedAt: "2026-08-03T05:00:00.000Z",
      production: {
        skillVersion: "partner-report-sync/0.4.1",
        promptVersion: "2026-08-05.zh-session-value.v2",
        schemaVersion: "1.0",
        producer: "codex-skill",
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("session value screening contract", () => {
  it("allows an unrelated session to be discarded without a contribution", () => {
    expect(
      sessionExtractionResultSchema.safeParse({
        schemaVersion: "1.0",
        decision: "ignore",
        reason: "unrelated_to_project",
      }).success,
    ).toBe(true);
  });

  it("rejects free-form ignored content that could leak session text", () => {
    expect(
      sessionExtractionResultSchema.safeParse({
        schemaVersion: "1.0",
        decision: "ignore",
        reason: "unrelated_to_project",
        details: "raw session content",
      }).success,
    ).toBe(false);
  });
});

describe("project card aggregation contract", () => {
  it("accepts only overview and ordered daily progress for each project", () => {
    const result = {
      schemaVersion: "1.0",
      groups: [
        {
          projectKey: "project:11111111-1111-4111-8111-111111111111",
          status: "in_progress",
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
          { ...result.groups[0], factIds: ["model-must-not-assign-facts"] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("fact and report semantic guards", () => {
  it("requires every report section exactly once", () => {
    expect(() =>
      assertReportSemantics({
        sections: [
          { key: "summary" },
          { key: "summary" },
          { key: "project_progress" },
          { key: "risks" },
          { key: "next_priorities" },
          { key: "coordination" },
          { key: "coverage" },
        ],
      }),
    ).toThrow(/each required section/i);
  });

  it("rejects an individual report without current Work Item claims", () => {
    expect(() =>
      assertReportSemantics({
        sections: [
          "summary",
          "achievements",
          "project_progress",
          "risks",
          "next_priorities",
          "coordination",
          "coverage",
        ].map((key) => ({ key, claims: [] })),
      }),
    ).toThrow(/cite at least one/i);
  });

  it("accepts a fully traceable seven-section report", () => {
    const workItemId = "11111111-1111-4111-8111-111111111111";
    const sections = [
      "summary",
      "achievements",
      "project_progress",
      "risks",
      "next_priorities",
      "coordination",
      "coverage",
    ].map((key) => ({
      key,
      title: key,
      markdown: "内容",
      claims:
        key === "coverage"
          ? []
          : [{ claim: "可追溯事实", workItemIds: [workItemId] }],
    }));
    const report = individualReportResultSchema.parse({
      schemaVersion: "1.0",
      title: "周报",
      summary: "摘要",
      sections,
      markdown: "# 周报",
      production: {
        skillVersion: "partner-report-platform/0.2.0",
        promptVersion: "2026-08-03.central.v1",
        schemaVersion: "1.0",
        producer: "data-platform",
        modelVersion: "gpt-5.6-sol",
      },
    });
    expect(() => assertReportSemantics(report)).not.toThrow();
  });

  it("requires every Team Report section exactly once", () => {
    expect(() =>
      assertTeamReportSemantics({
        sections: [
          { key: "summary" },
          { key: "project_progress" },
          { key: "risks" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertTeamReportSemantics({
        sections: [
          { key: "project_progress" },
          { key: "summary" },
          { key: "risks" },
        ],
      }),
    ).toThrow(/in order/i);
  });

  it("requires Chinese Team Report prose", () => {
    expect(() =>
      assertChineseTeamReport({
        summary: "本周完成团队目标。",
        sections: [
          { markdown: "Headroom_MVP 项目已完成。" },
          { markdown: "林勇完成了接口接入。" },
          { markdown: "本周没有已报告的风险。" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertChineseTeamReport({
        summary: "Weekly progress is complete.",
        sections: [{ markdown: "All tasks shipped." }],
      }),
    ).toThrow(/must be Chinese/i);
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
        blockers: ["补齐飞书消息接入协议"],
        status: "completed",
      }),
    ).toBe(false);
  });
});
