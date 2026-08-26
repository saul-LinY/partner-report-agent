import { describe, expect, it } from "vitest";
import {
  buildPendingPluginLog,
  collectionFinalStateLogInput,
} from "./telemetry.js";

describe("plugin telemetry", () => {
  it("adds the invocation identity required for command grouping", () => {
    const event = buildPendingPluginLog(
      {
        level: "info",
        stage: "collect_next",
        eventCode: "command.started",
        message: "started",
      },
      {
        invocationId: "11111111-1111-4111-8111-111111111111",
        sequence: 3,
        command: "collect-next",
        runId: "22222222-2222-4222-8222-222222222222",
      },
    );

    expect(event).toMatchObject({
      invocationId: "11111111-1111-4111-8111-111111111111",
      sequence: 3,
      command: "collect-next",
      runId: "22222222-2222-4222-8222-222222222222",
      eventType: "lifecycle",
    });
  });

  it("removes sensitive detail fields before queueing", () => {
    const event = buildPendingPluginLog(
      {
        level: "error",
        stage: "upload",
        eventCode: "UPLOAD_FAILED",
        message: "failed",
        details: {
          errorCode: "UPLOAD_FAILED",
          token: "secret",
          sessionPath: "/private/session",
        },
      },
      {
        invocationId: "11111111-1111-4111-8111-111111111111",
        sequence: 4,
        command: "collect-submit",
      },
    );

    expect(event.details).toEqual({ errorCode: "UPLOAD_FAILED" });
    expect(event.eventType).toBe("error");
  });

  it("builds an explicit failed collection conclusion", () => {
    expect(
      collectionFinalStateLogInput({
        runId: "22222222-2222-4222-8222-222222222222",
        outcome: "failed",
        summary: "采集失败：插件无法读取本机 Codex 会话。",
        reasonCode: "CODEX_SESSION_LIST_FAILED",
        details: { command: "collect-start" },
      }),
    ).toMatchObject({
      runId: "22222222-2222-4222-8222-222222222222",
      level: "error",
      stage: "collection",
      eventCode: "collection.final.failed",
      eventType: "result",
      message: "采集失败：插件无法读取本机 Codex 会话。",
      retryable: true,
      details: {
        finalState: "failed",
        summary: "采集失败：插件无法读取本机 Codex 会话。",
        reasonCode: "CODEX_SESSION_LIST_FAILED",
        command: "collect-start",
      },
    });
  });
});
