import { describe, expect, it } from "vitest";
import { assembleProjectProgress } from "./project-progress.js";
const scope = {
  partner_id: "member",
  project_id: "project",
  project_name: "项目 A",
  updated_at: "2026-09-04T00:00:00Z",
};
const card = {
  ...scope,
  id: "card",
  review_id: "review",
  period_key: "custom-week",
  review_status: "approved",
  payload: {
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
  it("uses the approved weekly card's exact daily text, date and review link", () => {
    const result = assembleProjectProgress({ ...defaults, cards: [card] });
    expect(result.projects[0]).toMatchObject({
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
    expect(result.projects[0]).toMatchObject({ days: [], contributionDays: 1 });
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
