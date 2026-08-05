import { describe, expect, it } from "vitest";
import { weeklyPeriodAt } from "./period.js";

describe("weeklyPeriodAt", () => {
  it("uses Friday 14:00 through the next Friday 14:00 in Asia/Shanghai", () => {
    const period = weeklyPeriodAt(
      new Date("2026-08-02T08:00:00.000Z"),
      "Asia/Shanghai",
    );
    expect(period.periodKey).toBe("2026-W31");
    expect(period.startsAt.toISOString()).toBe("2026-07-31T06:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-07T06:00:00.000Z");
    expect(period.submissionDeadlineAt).toEqual(period.endsAt);
  });

  it("handles a daylight-saving boundary with local clocks intact", () => {
    const period = weeklyPeriodAt(
      new Date("2026-03-29T12:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(period.startsAt.toISOString()).toBe("2026-03-27T13:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-04-03T12:00:00.000Z");
    expect(period.submissionDeadlineAt).toEqual(period.endsAt);
  });

  it("does not start a new period before Friday 14:00", () => {
    const before = weeklyPeriodAt(
      new Date("2026-08-07T05:59:59.000Z"),
      "Asia/Shanghai",
    );
    const atCutoff = weeklyPeriodAt(
      new Date("2026-08-07T06:00:00.000Z"),
      "Asia/Shanghai",
    );
    expect(before.startsAt.toISOString()).toBe("2026-07-31T06:00:00.000Z");
    expect(atCutoff.startsAt.toISOString()).toBe("2026-08-07T06:00:00.000Z");
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
});
