import { describe, it, expect } from "vitest";
import {
  collectorClaimSchema,
  collectorLogSchema,
  collectorManifestSchema,
  collectorSessionsSchema,
  validateCollectorSessions,
} from "./collector-contracts.js";

const scopeKey = "a".repeat(64);
const session = {
  id: "s",
  scopeKey,
  agent: "codex",
  title: "Session",
  modifiedAt: "2026-10-31T12:00:00Z",
  turns: [
    { id: "t", prompt: "entire prompt", answer: null, questionTime: "12:00" },
  ],
};
describe("native collector contracts", () => {
  it("accepts questions without model replies, retaining the whole session", () => {
    expect(collectorSessionsSchema.parse([session])[0]!.turns[0]!.prompt).toBe(
      "entire prompt",
    );
  });
  it("rejects identity overrides and free-form sensitive log payloads", () => {
    expect(
      collectorClaimSchema.safeParse({
        bindingCode: "PR-TEST-CODE",
        name: "Member",
        deviceName: "Mac",
        version: "1",
        partnerId: "override",
      }).success,
    ).toBe(false);
    const event = {
      eventId: "889eec48-2f19-40c7-aae7-810c505903f6",
      occurredAt: "2026-10-31T12:00:00Z",
      stage: "upload",
      level: "error",
      code: "UPLOAD_FAILED",
      sessionCount: 1,
    };
    expect(collectorLogSchema.safeParse({ events: [event] }).success).toBe(
      true,
    );
    expect(
      collectorLogSchema.safeParse({
        events: [{ ...event, message: "Bearer SECRET /Users/private" }],
      }).success,
    ).toBe(false);
    expect(
      collectorLogSchema.safeParse({
        events: [{ ...event, code: "arbitrary secret" }],
      }).success,
    ).toBe(false);
  });
  it("accepts whitelisted event details and rejects unknown keys, path-like codes and oversize messages", () => {
    const event = {
      eventId: "889eec48-2f19-40c7-aae7-810c505903f6",
      occurredAt: "2026-10-31T12:00:00Z",
      stage: "upload",
      level: "error",
      code: "UPLOAD_PART_FAILED",
      sessionCount: 1,
    };
    const parse = (details: unknown) =>
      collectorLogSchema.safeParse({ events: [{ ...event, details }] });
    expect(
      parse({
        appVersion: "0.3.1",
        osVersion: "macOS 15.1",
        durationMs: 1200,
        httpStatus: 503,
        apiErrorCode: "UPLOAD_INCOMPLETE",
        errorDomain: "NSURLErrorDomain",
        errorCode: -1009,
        errorKind: "network",
        message: "The Internet connection appears to be offline.",
        partIndex: 1,
        partCount: 3,
        bytes: 2_097_152,
        windowStart: "2026-10-30T00:00:00Z",
        windowEnd: "2026-10-31T00:00:00Z",
        periodKey: "2026-W44",
        policyVersion: 4,
        agent: "codex",
        retryAttempt: 2,
      }).success,
    ).toBe(true);
    expect(parse({}).success).toBe(true);
    expect(parse({ folder: "/Users/private" }).success).toBe(false);
    expect(parse({ errorKind: "disk" }).success).toBe(false);
    expect(parse({ apiErrorCode: "/Users/private/file" }).success).toBe(false);
    expect(parse({ apiErrorCode: "lowercase_code" }).success).toBe(false);
    expect(parse({ message: "x".repeat(300) }).success).toBe(true);
    expect(parse({ message: "x".repeat(301) }).success).toBe(false);
    expect(parse({ httpStatus: 99 }).success).toBe(false);
    expect(parse({ agent: "unknown-agent" }).success).toBe(false);
  });
  it("accepts the new App, discovery and review stages and codes", () => {
    const base = {
      eventId: "889eec48-2f19-40c7-aae7-810c505903f6",
      occurredAt: "2026-10-31T12:00:00Z",
      sessionCount: 0,
    };
    for (const [stage, code] of [
      ["app", "APP_LAUNCHED"],
      ["discovery", "DISCOVERY_FAILED"],
      ["review", "REVIEW_ACTION_FAILED"],
      ["permissions", "POLICY_SYNC_FAILED"],
    ])
      expect(
        collectorLogSchema.safeParse({
          events: [{ ...base, stage, level: "info", code }],
        }).success,
      ).toBe(true);
  });
  it("checks authorization, date bounds, and duplicate IDs including across parts", () => {
    const sessions = collectorSessionsSchema.parse([session]);
    const window = {
      startsAt: "2026-10-31T00:00:00Z",
      endsAt: "2026-11-01T00:00:00Z",
    };
    expect(
      validateCollectorSessions(sessions, window, new Set([scopeKey])),
    ).toBe(null);
    expect(validateCollectorSessions(sessions, window, new Set())).toBe(
      "PROJECT_NOT_ALLOWED",
    );
    expect(
      validateCollectorSessions(
        [...sessions, ...sessions],
        window,
        new Set([scopeKey]),
      ),
    ).toBe("DUPLICATE_SESSION");
    expect(
      validateCollectorSessions(
        sessions,
        { ...window, endsAt: window.startsAt },
        new Set([scopeKey]),
      ),
    ).toBe("SESSION_OUTSIDE_WINDOW");
    expect(
      collectorManifestSchema.safeParse({
        id: "889eec48-2f19-40c7-aae7-810c505903f6",
        periodKey: "p",
        startsAt: window.endsAt,
        endsAt: window.startsAt,
        policyVersion: 1,
        sessionCount: 1,
        partDigests: [scopeKey],
      }).success,
    ).toBe(false);
  });
});
