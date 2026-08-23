import { describe, expect, it } from "vitest";
import {
  buildWidgetDashboard,
  fixedReasonSchema,
  widgetActionSchema,
  widgetUnbindSchema,
} from "./widget.js";

describe("desktop widget action contract", () => {
  it("accepts fixed review actions", () => {
    expect(
      widgetActionSchema.safeParse({
        kind: "work_item_decision",
        reviewId: "11111111-1111-4111-8111-111111111111",
        workItemId: "22222222-2222-4222-8222-222222222222",
        baseVersion: 3,
        decision: "approve",
      }).success,
    ).toBe(true);
    expect(fixedReasonSchema.safeParse("wrong_project").success).toBe(true);
  });

  it("accepts detailed project-card feedback", () => {
    expect(
      widgetActionSchema.safeParse({
        kind: "work_item_regenerate_custom",
        reviewId: "11111111-1111-4111-8111-111111111111",
        workItemId: "22222222-2222-4222-8222-222222222222",
        baseVersion: 3,
        instruction: "请补充周三完成的验收结果，并把第一句写得更通俗。",
      }).success,
    ).toBe(true);
  });

  it("accepts one batch of new and existing project permission changes", () => {
    expect(
      widgetActionSchema.safeParse({
        kind: "project_scope_batch",
        pluginInstanceId: "11111111-1111-4111-8111-111111111111",
        baseVersion: 4,
        decisions: [
          { scopeKey: "a".repeat(64), decision: "allow" },
          { scopeKey: "b".repeat(64), decision: "deny" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects too-short feedback and unknown actions", () => {
    expect(
      widgetActionSchema.safeParse({
        kind: "work_item_regenerate_custom",
        reviewId: "11111111-1111-4111-8111-111111111111",
        workItemId: "22222222-2222-4222-8222-222222222222",
        baseVersion: 3,
        instruction: " ",
      }).success,
    ).toBe(false);
  });

  it("requires a binding code before unbinding the local plugin", () => {
    expect(widgetUnbindSchema.safeParse({ bindingCode: "PR-ABCD-1234" }).success).toBe(true);
    expect(widgetUnbindSchema.safeParse({ bindingCode: " " }).success).toBe(false);
    expect(widgetUnbindSchema.safeParse({ bindingCode: "PR-ABCD-1234", extra: true }).success).toBe(false);
  });

  it("builds a seven-day dashboard from the latest daily snapshots", () => {
    const dashboard = buildWidgetDashboard({
      now: new Date("2026-08-21T04:00:00Z"),
      timezone: "Asia/Shanghai",
      period: {
        period_key: "2026-W34",
        starts_at: "2026-08-17T00:00:00+08:00",
        ends_at: "2026-08-23T23:59:59+08:00",
      },
      collector: {
        runner_state: "idle",
        last_collection_completed_at: "2026-08-21T03:30:00Z",
        last_collection_session_count: 8,
      },
      snapshots: [
        {
          created_at: "2026-08-21T02:00:00Z",
          payload: { extracted: 5 },
        },
        {
          created_at: "2026-08-21T03:31:00Z",
          payload: { discovered: 9, extracted: 8, uploaded: 3, unchanged: 5 },
        },
      ],
    });
    expect(dashboard.status).toBe("success");
    expect(dashboard.today).toMatchObject({ discovered: 9, useful: 8 });
    expect(dashboard.week.days).toHaveLength(7);
    expect(dashboard.week.totalUseful).toBe(8);
  });

  it("keeps today's metric and chart consistent without a coverage snapshot", () => {
    const dashboard = buildWidgetDashboard({
      now: new Date("2026-08-21T04:00:00Z"),
      timezone: "Asia/Shanghai",
      collector: {
        runner_state: "idle",
        last_collection_completed_at: "2026-08-21T03:30:00Z",
        last_collection_session_count: 6,
      },
      snapshots: [],
    });
    expect(dashboard.today.useful).toBe(6);
    expect(dashboard.week.days.map((day) => day.label)).toEqual([
      "一",
      "二",
      "三",
      "四",
      "五",
      "六",
      "日",
    ]);
    expect(
      dashboard.week.days.find((day) => day.date === "2026-08-21")?.useful,
    ).toBe(6);
    expect(dashboard.week.totalUseful).toBe(6);
  });
});
