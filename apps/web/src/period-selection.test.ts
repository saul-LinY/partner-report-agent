import { describe, expect, it } from "vitest";
import { selectCurrentOpenPeriod } from "./period-selection.js";

describe("selectCurrentOpenPeriod", () => {
  it("prefers the period covering now over a newer future period", () => {
    const periods = [
      {
        id: "future",
        status: "open",
        starts_at: "2026-08-07T06:00:00.000Z",
        ends_at: "2026-08-14T06:00:00.000Z",
      },
      {
        id: "current",
        status: "open",
        starts_at: "2026-07-31T05:00:00.000Z",
        ends_at: "2026-08-07T05:00:00.000Z",
      },
    ];

    expect(
      selectCurrentOpenPeriod(periods, new Date("2026-08-04T05:00:00.000Z"))
        ?.id,
    ).toBe("current");
  });

  it("falls back to the latest started open period during a schedule gap", () => {
    const periods = [
      {
        id: "future",
        status: "open",
        starts_at: "2026-08-07T06:00:00.000Z",
        ends_at: "2026-08-14T06:00:00.000Z",
      },
      {
        id: "past",
        status: "open",
        starts_at: "2026-07-31T05:00:00.000Z",
        ends_at: "2026-08-07T05:00:00.000Z",
      },
    ];

    expect(
      selectCurrentOpenPeriod(periods, new Date("2026-08-07T05:30:00.000Z"))
        ?.id,
    ).toBe("past");
  });
});
