import { describe, expect, it } from "vitest";
import { weeklyPeriodAt } from "./period.js";

describe("weeklyPeriodAt", () => {
  it("uses Monday through Sunday in Asia/Shanghai", () => {
    const period = weeklyPeriodAt(new Date("2026-08-02T08:00:00.000Z"), "Asia/Shanghai");
    expect(period.periodKey).toBe("2026-W31");
    expect(period.startsAt.toISOString()).toBe("2026-07-26T16:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-02T15:59:59.999Z");
  });

  it("handles a daylight-saving boundary with local midnight intact", () => {
    const period = weeklyPeriodAt(new Date("2026-03-29T12:00:00.000Z"), "Europe/Berlin");
    expect(period.startsAt.toISOString()).toBe("2026-03-22T23:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-03-29T21:59:59.999Z");
  });
});
