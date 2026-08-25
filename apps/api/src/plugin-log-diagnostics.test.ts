import { describe, expect, it } from "vitest";
import {
  diagnosePluginExecution,
  groupPluginExecutions,
  type PluginExecutionEvent,
} from "./plugin-log-diagnostics.js";

function event(
  overrides: Partial<PluginExecutionEvent> = {},
): PluginExecutionEvent {
  return {
    id: crypto.randomUUID(),
    invocation_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    command: "collect-next",
    event_type: "lifecycle",
    level: "info",
    stage: "collect_next",
    event_code: "command.started",
    message: "插件命令开始：collect-next",
    retryable: false,
    duration_ms: null,
    details: {},
    occurred_at: "2026-08-25T08:00:00.000Z",
    ...overrides,
  };
}

describe("plugin execution diagnosis", () => {
  it("reports a completed invocation as normal", () => {
    const diagnosis = diagnosePluginExecution([
      event(),
      event({
        sequence: 2,
        event_code: "uploaded",
        event_type: "result",
      }),
      event({
        sequence: 3,
        event_code: "command.completed",
        occurred_at: "2026-08-25T08:00:02.000Z",
        duration_ms: 2000,
      }),
    ]);
    expect(diagnosis).toMatchObject({ severity: "normal", state: "completed" });
  });

  it("explains model output failures using plugin mechanics", () => {
    const diagnosis = diagnosePluginExecution([
      event(),
      event({
        sequence: 2,
        level: "error",
        event_type: "error",
        event_code: "EXTRACT_VALIDATION_FAILED",
        message: "模型输出未通过 schema 校验。",
      }),
    ]);
    expect(diagnosis.title).toContain("读取会话");
    expect(diagnosis.cause).toContain("模型提取结果");
  });

  it("separates events by command invocation", () => {
    const executions = groupPluginExecutions([
      event(),
      event({
        invocation_id: "33333333-3333-4333-8333-333333333333",
        command: "collect-review",
      }),
    ]);
    expect(executions).toHaveLength(2);
    expect(executions.every((item) => item.grouping === "invocation")).toBe(
      true,
    );
    expect(executions.map((item) => item.command)).toEqual(
      expect.arrayContaining(["collect-next", "collect-review"]),
    );
  });

  it("keeps run fallback logs separate from command invocations", () => {
    const executions = groupPluginExecutions(
      [
        event({
          invocation_id: null,
          command: null,
          event_code: "collection.started",
        }),
        event({
          invocation_id: null,
          command: null,
          event_code: "command.completed",
          occurred_at: "2026-08-25T08:00:02.000Z",
        }),
      ],
      new Date("2026-08-25T08:03:00.000Z"),
    );

    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      grouping: "run",
      command: "collection",
      diagnosis: { state: "running" },
    });
  });

  it("only completes a run fallback on the collection terminal event", () => {
    const executions = groupPluginExecutions([
      event({
        invocation_id: null,
        command: null,
        event_code: "collection.started",
      }),
      event({
        invocation_id: null,
        command: null,
        event_code: "collection.completed",
        occurred_at: "2026-08-25T08:00:02.000Z",
      }),
    ]);

    expect(executions[0]).toMatchObject({
      grouping: "run",
      diagnosis: {
        state: "completed",
        title: "本次采集批次运行正常",
      },
    });
  });

  it("marks events without invocation or run ids as ungrouped history", () => {
    const executions = groupPluginExecutions([
      event({ invocation_id: null, run_id: null, sequence: null }),
    ]);

    expect(executions[0]).toMatchObject({
      grouping: "legacy",
      command: "legacy",
      diagnosis: { state: "warning" },
    });
  });
});
