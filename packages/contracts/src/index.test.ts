import { describe, expect, it } from "vitest";
import {
  assertFactSemantics,
  assertReportSemantics,
  assertTeamReportSemantics,
  containsSensitiveValue,
  connectivityTestSchema,
  individualReportResultSchema,
  pluginDiagnosticBatchSchema,
  sessionFactUploadSchema,
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

describe("session upload project identity", () => {
  it("requires the server project identity and folder match metadata", () => {
    const base = {
      sessionId: "session-1",
      sourceRevision: 1,
      sourceHash: "a".repeat(64),
      fromTurnId: "turn-1",
      toTurnId: "turn-1",
      observedAt: "2026-08-03T05:00:00.000Z",
      status: "extracted",
      facts: [],
    };
    expect(sessionFactUploadSchema.safeParse(base).success).toBe(false);
    expect(
      sessionFactUploadSchema.safeParse({
        ...base,
        project: {
          id: "11111111-1111-4111-8111-111111111111",
          matchMethod: "descendant_path",
          rootFingerprint: "b".repeat(64),
        },
      }).success,
    ).toBe(true);
    expect(
      sessionFactUploadSchema.safeParse({
        ...base,
        project: {
          id: null,
          matchMethod: "path_discovered",
          rootFingerprint: "c".repeat(64),
          rootName: "automatic-project",
        },
      }).success,
    ).toBe(true);
    expect(
      sessionFactUploadSchema.safeParse({
        ...base,
        project: {
          id: null,
          matchMethod: "path_discovered",
          rootFingerprint: "c".repeat(64),
        },
      }).success,
    ).toBe(false);
  });
});

describe("fact and report semantic guards", () => {
  it("requires explicit evidence for completed facts", () => {
    expect(() =>
      assertFactSemantics({
        status: "completed",
        completionSupport: "uncertain",
        evidence: [],
      }),
    ).toThrow(/explicit evidence/i);
    expect(() =>
      assertFactSemantics({
        status: "completed",
        completionSupport: "evidence",
        evidence: [{}],
      }),
    ).not.toThrow();
  });

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
          { key: "summary" },
          { key: "risks" },
          { key: "next_priorities" },
          { key: "coverage" },
        ],
      }),
    ).toThrow(/each required section/i);
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
