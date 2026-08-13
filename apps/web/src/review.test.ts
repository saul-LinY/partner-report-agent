import { describe, expect, it } from "vitest";
import { reviewNeedsCompletion } from "./review.js";

describe("reviewNeedsCompletion", () => {
  it("resumes an interrupted review after every card has been handled", () => {
    expect(
      reviewNeedsCompletion({
        review: { state: "IN_PROGRESS", version: 6 },
        items: [{ review_status: "approved" }],
        regenerationJobs: [],
      }),
    ).toBe(true);
  });

  it("does not complete a review with pending cards", () => {
    expect(
      reviewNeedsCompletion({
        review: { state: "IN_PROGRESS", version: 2 },
        items: [
          { review_status: "approved" },
          { review_status: "pending" },
        ],
        regenerationJobs: [],
      }),
    ).toBe(false);
  });

  it("does not complete an empty or already completed review", () => {
    expect(
      reviewNeedsCompletion({
        review: { state: "IN_PROGRESS", version: 1 },
        items: [],
        regenerationJobs: [],
      }),
    ).toBe(false);
    expect(
      reviewNeedsCompletion({
        review: { state: "ITEMS_APPROVED", version: 1 },
        items: [{ review_status: "approved" }],
        regenerationJobs: [],
      }),
    ).toBe(false);
  });
});
