import { describe, expect, it } from "vitest";
import { weeklyPeriodAt } from "./period.js";

describe("weeklyPeriodAt", () => {
  it("uses Friday 13:00 through the next Friday 13:00 in Asia/Shanghai", () => {
    const period = weeklyPeriodAt(new Date("2026-08-02T08:00:00.000Z"), "Asia/Shanghai");
    expect(period.periodKey).toBe("2026-W31");
    expect(period.startsAt.toISOString()).toBe("2026-07-31T05:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-07T05:00:00.000Z");
  });

  it("handles a daylight-saving boundary with local 13:00 intact", () => {
    const period = weeklyPeriodAt(new Date("2026-03-29T12:00:00.000Z"), "Europe/Berlin");
    expect(period.startsAt.toISOString()).toBe("2026-03-27T12:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-04-03T11:00:00.000Z");
  });

  it("does not start a new period before Friday 13:00", () => {
    const before = weeklyPeriodAt(new Date("2026-08-07T04:59:59.000Z"), "Asia/Shanghai");
    const atCutoff = weeklyPeriodAt(new Date("2026-08-07T05:00:00.000Z"), "Asia/Shanghai");
    expect(before.startsAt.toISOString()).toBe("2026-07-31T05:00:00.000Z");
    expect(atCutoff.startsAt.toISOString()).toBe("2026-08-07T05:00:00.000Z");
  });
});
