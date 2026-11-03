import { describe, expect, it } from "vitest";
import { projectSystemLogExecutions } from "./system-logs.js";

describe("system log projection", () => {
  it("distinguishes queued App messages from macOS delivery receipts", () => {
    const pending = {
      id: "notification-1",
      kind: "review.reminder.requested",
      partner_name: "Member",
      created_at: "2026-11-02T01:00:00Z",
      delivered_at: null as string | null,
    };
    const rows = {
      jobs: [],
      notifications: [pending],
      outbox: [],
      reports: [],
    };
    expect(projectSystemLogExecutions(rows)[0]).toMatchObject({
      source: "notification",
      status: "pending",
      eventCount: 1,
    });
    rows.notifications[0] = {
      ...pending,
      delivered_at: "2026-11-02T01:02:00Z",
    };
    expect(projectSystemLogExecutions(rows)[0]).toMatchObject({
      source: "notification",
      status: "delivered",
      eventCount: 2,
    });
    expect(projectSystemLogExecutions(rows)[0]?.summary).toContain(
      "不代表用户已阅读",
    );
  });
  it("projects generation errors independently", () => {
    const executions = projectSystemLogExecutions({
      jobs: [
        {
          id: "job-1",
          type: "GENERATE_TEAM_REPORT",
          status: "FAILED",
          attempt_count: 3,
          max_attempts: 3,
          error_code: "TEAM_REPORT_GENERATION_FAILED",
          error_message: "模型没有返回可用的报告内容。",
          created_at: "2026-11-02T01:00:00Z",
          updated_at: "2026-11-02T01:01:00Z",
        },
      ],
      notifications: [],
      outbox: [],
      reports: [],
    });
    expect(executions[0]).toMatchObject({
      source: "job",
      severity: "critical",
      errorCode: "TEAM_REPORT_GENERATION_FAILED",
      eventCount: 2,
    });
  });
  it("exposes job type, attempts, durations, retry timing, upload link and sanitized errors", () => {
    const project = (job: Record<string, unknown>) =>
      projectSystemLogExecutions({
        jobs: [job],
        notifications: [],
        outbox: [],
        reports: [],
      })[0]!;
    const failed = project({
      id: "job-failed",
      type: "EXTRACT_COLLECTOR_SESSION",
      status: "FAILED",
      partner_id: "partner-1",
      partner_name: "Member",
      attempt_count: 3,
      max_attempts: 3,
      error_code: "MODEL_TIMEOUT",
      error_message: "request failed Bearer abcdefghijk at /Users/alice/proj",
      idempotency_key: "extract:key",
      upload_id: "upload-1",
      period_key: "2026-W44",
      lease_until: null,
      next_retry_at: null,
      created_at: "2026-11-02T01:00:00Z",
      updated_at: "2026-11-02T01:02:00Z",
      completed_at: null,
    });
    const retrying = project({
      id: "job-retry",
      type: "AGGREGATE_WORK_ITEMS",
      status: "RETRY_WAIT",
      attempt_count: 1,
      max_attempts: 3,
      error_code: "MODEL_BUSY",
      error_message: null,
      idempotency_key: "aggregate:key",
      lease_until: null,
      next_retry_at: "2026-11-02T01:10:00Z",
      created_at: "2026-11-02T01:00:00Z",
      updated_at: "2026-11-02T01:03:00Z",
      completed_at: null,
    });
    const done = project({
      id: "job-done",
      type: "GENERATE_TEAM_REPORT",
      status: "COMPLETED",
      attempt_count: 1,
      max_attempts: 3,
      idempotency_key: "report:key",
      created_at: "2026-11-02T01:00:00Z",
      updated_at: "2026-11-02T01:00:30Z",
      completed_at: "2026-11-02T01:00:30Z",
    });
    expect(failed.job).toMatchObject({
      type: "EXTRACT_COLLECTOR_SESSION",
      partnerId: "partner-1",
      partnerName: "Member",
      attemptCount: 3,
      maxAttempts: 3,
      errorCode: "MODEL_TIMEOUT",
      idempotencyKey: "extract:key",
      uploadId: "upload-1",
      periodKey: "2026-W44",
      durationMs: 120_000,
      completedAt: null,
    });
    expect(failed.job?.errorMessage).not.toContain("abcdefghijk");
    expect(failed.job?.errorMessage).not.toContain("/Users/alice");
    expect(failed.summary).not.toContain("abcdefghijk");
    expect(failed.events.at(-1)?.details).toMatchObject({
      uploadId: "upload-1",
      periodKey: "2026-W44",
      errorCode: "MODEL_TIMEOUT",
      attempt: 3,
      maxAttempts: 3,
    });
    expect(retrying.job).toMatchObject({
      nextRetryAt: "2026-11-02T01:10:00.000Z",
      errorMessage: null,
      uploadId: null,
    });
    expect(done.job).toMatchObject({
      completedAt: "2026-11-02T01:00:30.000Z",
      durationMs: 30_000,
    });
    expect(
      projectSystemLogExecutions({
        jobs: [],
        notifications: [
          {
            id: "n",
            kind: "k",
            created_at: "2026-11-02T01:00:00Z",
            delivered_at: null,
          },
        ],
        outbox: [],
        reports: [],
      })[0]?.job,
    ).toBeNull();
  });
  it("keeps dispatch and report lifecycle stages", () => {
    const executions = projectSystemLogExecutions({
      jobs: [],
      notifications: [],
      outbox: [
        {
          id: "event-1",
          aggregate_type: "review",
          event_type: "work_items.draft.created",
          created_at: "2026-11-02T01:00:00Z",
          published_at: "2026-11-02T01:00:01Z",
        },
      ],
      reports: [
        {
          id: "report-1",
          period_key: "2026-W44",
          status: "LOCKED",
          current_version: 2,
          created_at: "2026-11-02T02:00:00Z",
          updated_at: "2026-11-02T02:03:00Z",
          generated_at: "2026-11-02T02:02:00Z",
          locked_at: "2026-11-02T02:03:00Z",
        },
      ],
    });
    expect(executions.map((item) => item.source)).toEqual(["report", "outbox"]);
    expect(executions[0]?.events.map((item) => item.stage)).toEqual([
      "accepted",
      "generated",
      "archived",
    ]);
    expect(executions[1]?.events.map((item) => item.stage)).toEqual([
      "accepted",
      "dispatched",
    ]);
  });
});
