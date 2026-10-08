import { describe, expect, it } from "vitest";
import { assembleProjectProgress } from "./project-progress.js";
const scope = {
  partner_id: "member",
  project_id: "project",
  project_name: "项目 A",
  project_description: "帮助团队汇总项目贡献并确认每周工作。",
  updated_at: "2026-09-04T00:00:00Z",
};
const card = {
  ...scope,
  id: "card",
  review_id: "review",
  period_key: "custom-week",
  review_status: "approved",
  session_ids: ["session-a", "session-b"],
  payload: {
    currentFocus: "补齐接口异常测试",
    keyEvents: [
      {
        date: "2026-09-04",
        type: "milestone",
        title: "核心接口联调完成",
        detail: "主要数据链路已经跑通。",
      },
    ],
    dailyProgress: [
      { date: "2026-09-01", summary: "已核查的周卡进展\n保留原文与换行" },
    ],
  },
};
const defaults = {
  cards: [],
  participations: [],
  today: "2026-09-08",
  from: "2026-09-01",
  to: "2026-09-08",
};
describe("project progress sources", () => {
  it("returns the complete approved project timeline without a twenty-event cutoff", () => {
    const keyEvents = Array.from({ length: 25 }, (_, index) => ({
      date: "2026-09-01",
      type: "milestone",
      title: `进展 ${index + 1}`,
      detail: `已完成工作 ${index + 1}`,
    }));
    const result = assembleProjectProgress({
      ...defaults,
      cards: [{ ...card, payload: { ...card.payload, keyEvents } }],
    });
    expect(result.projects[0]?.keyEvents).toHaveLength(25);
    expect(result.projects[0]?.keyEvents.at(-1)?.detail).toBe("已完成工作 25");
  });
  it("uses the approved card's project description shared with the weekly report", () => {
    const result = assembleProjectProgress({
      ...defaults,
      cards: [
        {
          ...card,
          payload: {
            ...card.payload,
            projectDescription: "为团队提供项目贡献采集、工作审核和周报汇总。",
          },
        },
      ],
    });
    expect(result.projects[0]?.projectDescription).toBe(
      "为团队提供项目贡献采集、工作审核和周报汇总。",
    );
  });
  it("uses the approved weekly card's exact daily text, date and review link", () => {
    const result = assembleProjectProgress({ ...defaults, cards: [card] });
    expect(result.projects[0]).toMatchObject({
      projectDescription: "帮助团队汇总项目贡献并确认每周工作。",
      currentFocus: {
        text: "补齐接口异常测试",
        periodKey: "custom-week",
        reviewId: "review",
      },
      keyEvents: [
        {
          date: "2026-09-04",
          type: "milestone",
          title: "核心接口联调完成",
          detail: "主要数据链路已经跑通。",
          periodKey: "custom-week",
          reviewId: "review",
        },
      ],
      aiEvidence: { sessionCount: 2, periodCount: 1, workCardCount: 1 },
      contributionDays: 1,
      reviewId: "review",
      metrics: { startDate: null },
      days: [
        {
          date: "2026-09-01",
          entries: [
            {
              summary: card.payload.dailyProgress[0]!.summary,
              source: "reviewed",
              reviewId: "review",
              periodKey: "custom-week",
            },
          ],
        },
      ],
    });
  });
  it.each(["pending", "excluded"])(
    "omits %s cards from dates, latest outcomes and member counts",
    (review_status) => {
      const result = assembleProjectProgress({
        ...defaults,
        cards: [{ ...card, review_status }],
      });
      expect(result.projects).toEqual([]);
      expect(result.memberDays.size).toBe(0);
    },
  );
  it("does not replace missing daily progress with a weekly summary or creation date", () => {
    const result = assembleProjectProgress({
      ...defaults,
      cards: [{ ...card, payload: { summary: "整周摘要" } }],
    });
    expect(result.projects[0]).toMatchObject({
      days: [],
      latestProgress: null,
      contributionDays: 0,
      firstContributionDate: null,
      lastContributionDate: null,
      undatedCount: 1,
    });
  });
  it("deduplicates overlapping member days, without summing project duration", () => {
    const result = assembleProjectProgress({
      ...defaults,
      cards: [card, { ...card, id: "another", project_id: "parallel-project" }],
    });
    expect(result.projects).toHaveLength(2);
    expect(result.memberDays.get("member")!.size).toBe(1);
  });
  it("preserves lifetime counts while returning only the requested visible days", () => {
    const result = assembleProjectProgress({
      ...defaults,
      from: "2026-09-06",
      cards: [card],
    });
    expect(result.projects[0]).toMatchObject({
      days: [],
      contributionDays: 1,
      firstContributionDate: "2026-09-01",
      lastContributionDate: "2026-09-01",
    });
  });
  it("counts distinct approved dates per person and project across months", () => {
    const dailyProgress = [
      { date: "2026-09-07", summary: "联调" },
      { date: "2026-08-20", summary: "实现接口" },
      { date: "2026-09-07", summary: "补充测试" },
      { date: "2026-09-09", summary: "未来记录" },
      { date: "2026-02-30", summary: "无效日期" },
    ];
    const result = assembleProjectProgress({
      ...defaults,
      cards: [
        { ...card, payload: { dailyProgress } },
        { ...card, id: "duplicate", payload: { dailyProgress } },
        { ...card, id: "other-member", partner_id: "other" },
        { ...card, id: "pending", review_status: "pending" },
      ],
    });
    expect(
      result.projects.find((project) => project.partnerId === "member"),
    ).toMatchObject({
      contributionDays: 2,
      firstContributionDate: "2026-08-20",
      lastContributionDate: "2026-09-07",
      days: [{ date: "2026-09-07" }],
    });
    expect(
      result.projects.find((project) => project.partnerId === "other"),
    ).toMatchObject({
      contributionDays: 1,
      firstContributionDate: "2026-09-01",
      lastContributionDate: "2026-09-01",
    });
  });
  it("does not invent dates and flags contributions outside confirmed active intervals", () => {
    const result = assembleProjectProgress({
      ...defaults,
      cards: [
        {
          ...card,
          payload: {
            dailyProgress: [
              { date: "2026-09-03", summary: "暂停期间有贡献" },
              { date: null, summary: "没有日期" },
              { date: "2026-02-30", summary: "无效日期" },
              { date: "2026-09-09", summary: "未来日期" },
            ],
          },
        },
      ],
      participations: [
        {
          ...scope,
          version: 1,
          events: [
            { date: "2026-09-01", type: "start", reason: "" },
            { date: "2026-09-02", type: "pause", reason: "临时任务" },
          ],
        },
      ],
    });
    expect(result.projects[0]).toMatchObject({
      contributionDays: 1,
      undatedCount: 3,
      conflictingDays: ["2026-09-03"],
    });
  });
  it("keeps the latest approved outcome outside the viewed month and ignores newer drafts", () => {
    const result = assembleProjectProgress({
      ...defaults,
      from: "2026-08-01",
      to: "2026-08-31",
      cards: [
        {
          ...card,
          id: "draft",
          review_status: "pending",
          review_id: "draft-review",
          updated_at: "2026-09-07T00:00:00Z",
          payload: {
            dailyProgress: [{ date: "2026-09-07", summary: "未审核" }],
          },
        },
        {
          ...card,
          id: "new",
          review_id: "new-review",
          updated_at: "2026-09-05T00:00:00Z",
          payload: {
            dailyProgress: [{ date: "2026-09-01", summary: "审核后的修订" }],
          },
        },
        card,
      ],
    });
    expect(result.projects[0]).toMatchObject({
      days: [],
      reviewId: "new-review",
      latestProgress: {
        date: "2026-09-01",
        summary: "审核后的修订",
        source: "reviewed",
      },
    });
  });
});

describe("confirmed project status", () => {
  it("uses the latest reporting period rather than a later approval of an older card", () => {
    const result = assembleProjectProgress({
      ...defaults,
      cards: [
        {
          ...card,
          period_key: "new-week",
          payload: {
            projectStatus: "delivery",
            projectStatusConfirmedAt: "2026-09-07T00:00:00Z",
          },
        },
        {
          ...card,
          period_key: "old-week",
          updated_at: "2026-09-08T00:00:00Z",
          payload: { projectStatus: "research" },
        },
        {
          ...card,
          review_status: "pending",
          payload: { projectStatus: "paused" },
        },
      ],
    });
    expect(result.projects[0]!.currentStatus).toMatchObject({
      value: "delivery",
      periodKey: "new-week",
      source: "work_card",
    });
    expect(result.projects[0]!.metrics.state).toBe("unknown");
  });

  it("keeps a newer manual correction without treating later timing edits as a new status", () => {
    const result = assembleProjectProgress({
      ...defaults,
      cards: [
        {
          ...card,
          payload: {
            projectStatus: "delivery",
            projectStatusConfirmedAt: "2026-09-07T00:00:00Z",
          },
        },
      ],
      participations: [
        {
          ...scope,
          version: 3,
          updated_at: "2026-09-09T00:00:00Z",
          events: [
            {
              date: "2026-09-08",
              type: "milestone",
              projectStatus: "paused",
              reason: "暂缓",
              statusConfirmedAt: "2026-09-08T00:00:00Z",
            },
          ],
        },
      ],
    });
    expect(result.projects[0]!.currentStatus).toMatchObject({
      value: "paused",
      source: "manual",
    });
    expect(result.projects[0]!.metrics.state).toBe("unknown");
  });
});
