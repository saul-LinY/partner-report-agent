import { describe, expect, it } from "vitest";
import { countdownText, formatDate, formatMoment, weekLabel } from "./schedule.js";

describe("schedule formatting", () => {
  it("reads instants in the team's time zone", () => {
    // 2026-11-23 13:00 in Shanghai is 05:00 UTC.
    expect(formatMoment("2026-11-23T05:00:00.000Z", "Asia/Shanghai", true)).toBe(
      "11月23日（周一）13:00",
    );
    expect(formatMoment("2026-11-23T04:00:00.000Z", "Asia/Shanghai")).toBe(
      "11月23日 12:00",
    );
    expect(formatDate("2026-11-13T08:00:00.000Z", "Asia/Shanghai")).toBe(
      "11月13日",
    );
  });

  it("shortens period keys to the week", () => {
    expect(weekLabel("2026-W46")).toBe("W46");
    expect(weekLabel("2026-W5-20261102T000000Z")).toBe("W05");
    expect(weekLabel("业务周期 A")).toBe("业务周期 A");
  });

  it("counts down to the automatic approval", () => {
    const now = Date.parse("2026-11-20T08:00:00.000Z");
    expect(countdownText("2026-11-23T04:00:00.000Z", now)).toBe("2 天 20 小时");
    expect(countdownText("2026-11-20T11:30:00.000Z", now)).toBe("3 小时 30 分钟");
    expect(countdownText("2026-11-20T08:00:00.000Z", now)).toBeNull();
  });
});
