import { describe, expect, it } from "vitest";
import { collectorPipelineStage } from "./collector.js";

describe("received packages and downstream state", () => {
  const received = {
    status: "completed",
    analysis_enqueued_at: new Date(),
    analysis_total: 2,
    analysis_completed: 0,
    analysis_ignored: 0,
  };
  it("does not equate a successful upload with completed analysis", () => {
    expect(collectorPipelineStage(received).stage).toBe("analyzing");
    expect(
      collectorPipelineStage({ ...received, analysis_failed: 1 }).stage,
    ).toBe("analysis_failed");
    expect(
      collectorPipelineStage({
        ...received,
        analysis_completed: 2,
        analysis_ignored: 2,
      }).stage,
    ).toBe("no_activity");
  });
  it("distinguishes review, report failure, archived and test history", () => {
    const processed = {
      ...received,
      analysis_completed: 2,
      review_id: "review",
      review_state: "ITEMS_APPROVED",
    };
    expect(
      collectorPipelineStage({ ...processed, review_state: "IN_PROGRESS" })
        .stage,
    ).toBe("review");
    expect(
      collectorPipelineStage({
        ...processed,
        report_status: "AGGREGATING",
        report_job_status: "FAILED",
      }).stage,
    ).toBe("report_failed");
    expect(
      collectorPipelineStage({ ...processed, report_status: "LOCKED" }).stage,
    ).toBe("archived");
    expect(
      collectorPipelineStage({ ...processed, card_job_status: "RETRY_WAIT" })
        .stage,
    ).toBe("cards_retrying");
    expect(
      collectorPipelineStage({ ...processed, report_job_status: "RETRY_WAIT" })
        .stage,
    ).toBe("report_retrying");
    expect(
      collectorPipelineStage({ ...received, device_status: "test" }).stage,
    ).toBe("test");
  });
});
