import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEEKLY_PERIOD_RULE,
  weeklyPeriodAt,
  weeklyPeriodKeyCandidates,
  weeklyReviewSchedule,
} from "./period.js";

describe("weeklyPeriodAt", () => {
  it("defaults to Friday 16:00", () => {
    expect(DEFAULT_WEEKLY_PERIOD_RULE.factCutoffTime).toBe("16:00");
  });

  it("uses Friday 16:00 through the next Friday 16:00 in Asia/Shanghai", () => {
    const period = weeklyPeriodAt(
      new Date("2026-08-02T08:00:00.000Z"),
      "Asia/Shanghai",
    );
    expect(period.periodKey).toBe("2026-W31");
    expect(period.startsAt.toISOString()).toBe("2026-07-31T08:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-07T08:00:00.000Z");
    expect(period.submissionDeadlineAt).toEqual(period.endsAt);
  });

  it("handles a daylight-saving boundary with local clocks intact", () => {
    const period = weeklyPeriodAt(
      new Date("2026-03-29T12:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(period.startsAt.toISOString()).toBe("2026-03-27T15:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-04-03T14:00:00.000Z");
    expect(period.submissionDeadlineAt).toEqual(period.endsAt);
  });

  it("does not start a new period before Friday 16:00", () => {
    const before = weeklyPeriodAt(
      new Date("2026-08-07T07:59:59.000Z"),
      "Asia/Shanghai",
    );
    const atCutoff = weeklyPeriodAt(
      new Date("2026-08-07T08:00:00.000Z"),
      "Asia/Shanghai",
    );
    expect(before.startsAt.toISOString()).toBe("2026-07-31T08:00:00.000Z");
    expect(atCutoff.startsAt.toISOString()).toBe("2026-08-07T08:00:00.000Z");
  });

  it("supports a team-specific aggregation cutoff", () => {
    const period = weeklyPeriodAt(
      new Date("2026-08-04T00:00:00.000Z"),
      "Asia/Shanghai",
      {
        factCutoffWeekday: 3,
        factCutoffTime: "18:30",
      },
    );
    expect(period.endsAt.toISOString()).toBe("2026-08-05T10:30:00.000Z");
    expect(period.submissionDeadlineAt).toEqual(period.endsAt);
  });

  it("provides a stable fallback key when a changed schedule reuses a week key", () => {
    expect(
      weeklyPeriodKeyCandidates({
        periodKey: "2026-W32",
        startsAt: new Date("2026-08-09T10:35:00.000Z"),
      }),
    ).toEqual(["2026-W32", "2026-W32-20260809T103500Z"]);
  });
});

describe("weeklyReviewSchedule", () => {
  const at = (iso: string, timezone = "Asia/Shanghai") =>
    weeklyReviewSchedule(new Date(iso), timezone);

  it("puts a Friday 16:00 cutoff's deadline on Monday 12:00 and publication on Monday 13:00", () => {
    const schedule = at("2026-08-07T08:00:00.000Z");
    expect(schedule.autoApproveAt.toISOString()).toBe("2026-08-10T04:00:00.000Z");
    expect(schedule.publishAt.toISOString()).toBe("2026-08-10T05:00:00.000Z");
  });

  it("keeps the deadline in the past for a cutoff that passed long ago", () => {
    const schedule = at("2026-07-03T08:00:00.000Z");
    expect(schedule.autoApproveAt.toISOString()).toBe("2026-07-06T04:00:00.000Z");
    expect(schedule.publishAt.toISOString()).toBe("2026-07-06T05:00:00.000Z");
  });

  it("takes the same Monday when the cutoff falls before 12:00 that day, else the next", () => {
    expect(at("2026-08-10T03:00:00.000Z").autoApproveAt.toISOString()).toBe(
      "2026-08-10T04:00:00.000Z",
    );
    expect(at("2026-08-10T04:00:00.000Z").autoApproveAt.toISOString()).toBe(
      "2026-08-17T04:00:00.000Z",
    );
  });

  it("follows local clocks across a daylight-saving change", () => {
    const schedule = at("2026-03-27T15:00:00.000Z", "Europe/Berlin");
    expect(schedule.autoApproveAt.toISOString()).toBe("2026-03-30T10:00:00.000Z");
    expect(schedule.publishAt.toISOString()).toBe("2026-03-30T11:00:00.000Z");
  });
});
