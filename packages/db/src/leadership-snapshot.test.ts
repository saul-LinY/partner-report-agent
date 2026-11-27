import { describe, expect, it } from "vitest";
import { leadershipStep, reviewPeriodSchedule } from "./leadership-snapshot.js";

describe("leadership update schedule", () => {
  // Friday 2026-11-20 16:00 in Shanghai.
  const period = reviewPeriodSchedule({
    periodKey: "2026-W47",
    startsAt: new Date("2026-11-13T08:00:00.000Z"),
    cutoffAt: new Date("2026-11-20T08:00:00.000Z"),
    timezone: "Asia/Shanghai",
  });

  it("derives Monday 12:00 and 13:00 from the Friday 16:00 cutoff", () => {
    expect(period.autoApproveAt).toBe("2026-11-23T04:00:00.000Z");
    expect(period.publishAt).toBe("2026-11-23T05:00:00.000Z");
    expect(period.timezone).toBe("Asia/Shanghai");
  });

  it("collects until the cutoff, reviews until Monday 12:00, then waits to publish", () => {
    const at = (iso: string) => leadershipStep(new Date(iso), period);
    expect(at("2026-11-20T07:59:59.999Z")).toBe("collecting");
    expect(at("2026-11-20T08:00:00.000Z")).toBe("reviewing");
    expect(at("2026-11-23T03:59:59.999Z")).toBe("reviewing");
    expect(at("2026-11-23T04:00:00.000Z")).toBe("publishing");
    expect(at("2026-12-01T00:00:00.000Z")).toBe("publishing");
  });
});
