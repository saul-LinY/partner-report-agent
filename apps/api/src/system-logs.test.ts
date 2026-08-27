import { describe, expect, it } from "vitest";
import { projectSystemLogExecutions } from "./system-logs.js";

describe("system log projection", () => {
  it("projects generation and delivery failures into readable executions", () => {
    const executions = projectSystemLogExecutions({
      jobs: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "GENERATE_TEAM_REPORT",
          status: "FAILED",
          partner_name: null,
          attempt_count: 3,
          max_attempts: 3,
          error_code: "TEAM_REPORT_GENERATION_FAILED",
          error_message: "模型没有返回可用的报告内容。",
          created_at: "2026-08-27T01:00:00.000Z",
          updated_at: "2026-08-27T01:01:00.000Z",
          completed_at: null,
        },
      ],
      deliveries: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "review",
          status: "sent",
          partner_name: "林勇",
          attempt_count: 1,
          last_error_code: null,
          last_error_message: null,
          created_at: "2026-08-27T01:02:00.000Z",
          updated_at: "2026-08-27T01:02:02.000Z",
          sent_at: "2026-08-27T01:02:02.000Z",
        },
      ],
      inbox: [],
      outbox: [],
      reports: [],
    });

    expect(executions).toHaveLength(2);
    expect(executions[0]).toMatchObject({
      source: "delivery",
      title: "工作卡片审核发送",
      severity: "normal",
      summary: "工作卡片审核发送已发送到飞书。",
      eventCount: 2,
    });
    expect(executions[1]).toMatchObject({
      source: "job",
      title: "团队报告生成",
      severity: "critical",
      errorCode: "TEAM_REPORT_GENERATION_FAILED",
      summary: "模型没有返回可用的报告内容。",
      eventCount: 2,
    });
  });

  it("shows the receive, dispatch and report lifecycle stages", () => {
    const executions = projectSystemLogExecutions({
      jobs: [],
      deliveries: [],
      inbox: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "processed",
          partner_name: "林勇",
          error_code: null,
          error_message: null,
          received_at: "2026-08-27T02:00:00.000Z",
          updated_at: "2026-08-27T02:00:01.000Z",
          processed_at: "2026-08-27T02:00:01.000Z",
        },
      ],
      outbox: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          aggregate_type: "review",
          event_type: "work_items.draft.created",
          created_at: "2026-08-27T02:01:00.000Z",
          published_at: "2026-08-27T02:01:01.000Z",
        },
      ],
      reports: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          period_key: "2026-W35",
          status: "LOCKED",
          current_version: 2,
          created_at: "2026-08-27T02:02:00.000Z",
          updated_at: "2026-08-27T02:03:00.000Z",
          generated_at: "2026-08-27T02:02:30.000Z",
          locked_at: "2026-08-27T02:03:00.000Z",
        },
      ],
    });

    expect(executions.map((item) => item.source)).toEqual([
      "report",
      "outbox",
      "inbox",
    ]);
    expect(executions[0]?.events.map((item) => item.stage)).toEqual([
      "accepted",
      "generated",
      "archived",
    ]);
    expect(executions[1]?.events.map((item) => item.stage)).toEqual([
      "accepted",
      "dispatched",
    ]);
    expect(executions[2]?.events.map((item) => item.stage)).toEqual([
      "received",
      "completed",
    ]);
  });
});
