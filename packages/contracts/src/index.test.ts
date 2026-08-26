import { describe, expect, it } from "vitest";
import {
  assertChineseTeamReport,
  assertTeamReportSemantics,
  aggregationResultSchema,
  containsSensitiveValue,
  connectivityTestSchema,
  coverageSchema,
  pluginDiagnosticBatchSchema,
  pluginLogBatchSchema,
  productionMetadataSchema,
  sessionContributionIngestSchema,
  sessionContributionSchema,
  sessionExtractionResultSchema,
} from "./index.js";

describe("collection coverage contract", () => {
  it("keeps deferred, skipped, failed extraction, and unprocessed counts separate", () => {
    expect(
      coverageSchema.parse({
        discovered: 11,
        eligible: 11,
        readable: 11,
        extracted: 2,
        deferred: 1,
        skipped: 2,
        notProcessed: 5,
        failedRead: 2,
        failedPermissionCheck: 1,
        failedThreadRead: 1,
        invalidThreadHistory: 1,
        failedExtract: 1,
        excluded: 2,
        pendingSync: 0,
        activeAtCutoff: 0,
        hookMissed: 0,
        warnings: ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
      }),
    ).toMatchObject({
      deferred: 1,
      skipped: 2,
      notProcessed: 5,
      failedRead: 2,
      failedPermissionCheck: 1,
      failedThreadRead: 1,
      invalidThreadHistory: 1,
      failedExtract: 1,
    });
  });
});

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

describe("plugin log contract", () => {
  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    invocationId: "33333333-3333-4333-8333-333333333333",
    runId: "22222222-2222-4222-8222-222222222222",
    sequence: 3,
    command: "collect-next",
    eventType: "error",
    level: "error",
    stage: "collection",
    eventCode: "SESSION_READ_FAILED",
    message: "读取会话失败。",
    stack: "Error: read failed\n    at collect (cli.ts:120:4)",
    occurredAt: "2026-08-21T08:00:00.000Z",
    retryable: true,
    durationMs: 451,
    details: { failedRead: 1 },
  };

  it("accepts a bounded structured event and rejects spoofed ownership", () => {
    expect(pluginLogBatchSchema.safeParse({ events: [event] }).success).toBe(
      true,
    );
    expect(
      pluginLogBatchSchema.safeParse({
        events: [{ ...event, pluginInstanceId: event.runId }],
      }).success,
    ).toBe(false);
  });

  it("caps batch and stack sizes", () => {
    expect(
      pluginLogBatchSchema.safeParse({ events: Array(51).fill(event) }).success,
    ).toBe(false);
    expect(
      pluginLogBatchSchema.safeParse({
        events: [{ ...event, stack: "x".repeat(16_001) }],
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
    const contribution = {
      ...base,
      project: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "partner-report-agent",
        matchMethod: "descendant_path",
        rootFingerprint: "c".repeat(64),
      },
    };
    expect(sessionContributionSchema.safeParse(contribution).success).toBe(
      true,
    );
    expect(
      sessionContributionSchema.safeParse({
        ...contribution,
        status: "completed",
      }).success,
    ).toBe(false);
    expect(
      sessionContributionIngestSchema.parse({
        ...contribution,
        status: "completed",
      }),
    ).not.toHaveProperty("status");
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
          {
            ...result.groups[0],
            dailyProgress: [{ date: "2026-08-03", summary: "进".repeat(201) }],
          },
        ],
      }).success,
    ).toBe(false);
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

describe("team report semantic guards", () => {
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
        blockers: ["补齐应用消息接入协议"],
        status: "completed",
      }),
    ).toBe(false);
  });
});
