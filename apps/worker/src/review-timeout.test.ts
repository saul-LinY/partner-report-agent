import { describe, expect, it } from "vitest";
import {
  isReviewAutoApprovalDue,
  reviewAutoApprovalAt,
} from "./review-timeout.js";

describe("review deadline", () => {
  const timezone = "Asia/Shanghai";
  // Friday 2026-11-20 16:00 in Shanghai.
  const cutoff = new Date("2026-11-20T08:00:00.000Z");

  it("approves at Monday 12:00 team time after the cutoff", () => {
    expect(reviewAutoApprovalAt(cutoff, timezone).toISOString()).toBe(
      "2026-11-23T04:00:00.000Z",
    );
  });

  it("is not due over the weekend or one millisecond before Monday 12:00", () => {
    expect(
      isReviewAutoApprovalDue(
        cutoff,
        timezone,
        new Date("2026-11-22T12:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      isReviewAutoApprovalDue(
        cutoff,
        timezone,
        new Date("2026-11-23T03:59:59.999Z"),
      ),
    ).toBe(false);
  });

  it("is due from Monday 12:00 onward", () => {
    expect(
      isReviewAutoApprovalDue(
        cutoff,
        timezone,
        new Date("2026-11-23T04:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("is due for a period whose cutoff passed long ago", () => {
    expect(
      isReviewAutoApprovalDue(
        new Date("2026-08-07T08:00:00.000Z"),
        timezone,
        new Date("2026-11-20T00:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
