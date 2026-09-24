import { describe, expect, it } from "vitest";
import {
  isReviewAutoApprovalDue,
  REVIEW_AUTO_APPROVAL_DELAY_MS,
} from "./review-timeout.js";

describe("review timeout", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("waits until three full days after the first sent card", () => {
    expect(
      isReviewAutoApprovalDue(
        new Date(now.getTime() - REVIEW_AUTO_APPROVAL_DELAY_MS + 1),
        now,
      ),
    ).toBe(false);
    expect(
      isReviewAutoApprovalDue(
        new Date(now.getTime() - REVIEW_AUTO_APPROVAL_DELAY_MS),
        now,
      ),
    ).toBe(true);
  });

  it("does not auto approve a review that was never sent", () => {
    expect(isReviewAutoApprovalDue(null, now)).toBe(false);
    expect(isReviewAutoApprovalDue(undefined, now)).toBe(false);
  });
});
