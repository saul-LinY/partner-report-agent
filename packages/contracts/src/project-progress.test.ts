import { describe, expect, it } from "vitest";
import {
  calculateProgress,
  progressDateSchema,
  progressToday,
  validateProgressEvents,
  type ProgressEvent,
} from "./project-progress.js";
const event = (
  date: string,
  type: ProgressEvent["type"],
  reason = "",
): ProgressEvent => ({ date: `2026-09-${date}`, type, reason });
describe("daily project participation", () => {
  it("keeps unconfirmed dates unknown", () => {
    expect(calculateProgress([], "2026-09-12")).toMatchObject({
      state: "unknown",
      elapsedDays: null,
      activeDays: null,
      pausedDays: null,
    });
  });
  it("counts inclusive elapsed days but excludes the full interruption", () => {
    const events = [
      event("01", "start"),
      event("04", "pause", "临时支援 B"),
      event("09", "resume"),
      event("12", "complete"),
    ];
    expect(validateProgressEvents(events, "2026-09-12")).toBeNull();
    expect(calculateProgress(events, "2026-09-12")).toMatchObject({
      elapsedDays: 12,
      pausedDays: 5,
      activeDays: 7,
      state: "completed",
    });
  });
  it("counts an open pause through today and completion while paused", () => {
    const events = [event("01", "start"), event("04", "pause", "等待外部依赖")];
    expect(calculateProgress(events, "2026-09-07")).toMatchObject({
      elapsedDays: 7,
      pausedDays: 4,
      activeDays: 3,
    });
    expect(
      calculateProgress([...events, event("07", "complete")], "2026-09-12"),
    ).toMatchObject({ elapsedDays: 7, pausedDays: 4, activeDays: 3 });
  });
  it("does not count completed gaps after reopening as active or paused", () => {
    const events = [
      event("01", "start"),
      event("03", "complete"),
      event("09", "reopen"),
      event("12", "complete"),
    ];
    expect(validateProgressEvents(events, "2026-09-12")).toBeNull();
    expect(calculateProgress(events, "2026-09-12")).toMatchObject({
      elapsedDays: 12,
      activeDays: 7,
      pausedDays: 0,
    });
  });
  it("supports a project started and completed on the same day", () => {
    const events = [event("01", "start"), event("01", "complete")];
    expect(validateProgressEvents(events, "2026-09-12")).toBeNull();
    expect(calculateProgress(events, "2026-09-12")).toMatchObject({
      elapsedDays: 1,
      activeDays: 1,
    });
  });
  it.each([
    [event("01", "resume")],
    [event("01", "complete")],
    [event("01", "start"), event("02", "start")],
    [event("01", "start"), event("02", "pause")],
    [event("03", "start"), event("02", "pause", "支援")],
    [event("01", "start"), event("01", "pause", "支援")],
    [event("01", "start"), event("13", "complete")],
    [event("01", "start"), event("02", "complete"), event("03", "resume")],
  ])("rejects invalid or ambiguous transitions %j", (...events) => {
    expect(
      validateProgressEvents(events as ProgressEvent[], "2026-09-12"),
    ).not.toBeNull();
  });
  it("records milestones without fabricating a start or changing paused intervals", () => {
    const milestone = event("02", "milestone", "接口联调完成");
    expect(validateProgressEvents([milestone], "2026-09-12")).toBeNull();
    expect(calculateProgress([milestone], "2026-09-12")).toMatchObject({
      state: "unknown",
      elapsedDays: null,
    });
    const events = [
      event("01", "start"),
      event("02", "pause", "支援"),
      milestone,
      event("05", "resume"),
    ];
    expect(validateProgressEvents(events, "2026-09-12")).toBeNull();
    expect(calculateProgress(events, "2026-09-12")).toMatchObject({
      pausedDays: 3,
      activeDays: 9,
    });
    expect(
      validateProgressEvents(
        [...events.slice(0, 3), event("02", "resume")],
        "2026-09-12",
      ),
    ).not.toBeNull();
    expect(
      validateProgressEvents([event("01", "milestone")], "2026-09-12"),
    ).not.toBeNull();
  });
  it("validates actual calendar dates and uses the team timezone", () => {
    expect(progressDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(progressDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(
      progressToday("Asia/Shanghai", new Date("2026-09-07T17:00:00Z")),
    ).toBe("2026-09-08");
  });
});

it("tracks confirmed project stages independently of effort and resets them after reopening", async () => {
  const { currentProjectStage } = await import("./project-progress.js");
  const stage: ProgressEvent = {
    date: "2026-09-02",
    type: "milestone",
    stage: "validation",
    reason: "核心功能完成，开始联调",
  };
  expect(validateProgressEvents([stage], "2026-09-08")).toBeNull();
  expect(calculateProgress([stage], "2026-09-08").elapsedDays).toBeNull();
  expect(currentProjectStage([stage])).toBe("validation");
  expect(currentProjectStage([stage, event("03", "complete")])).toBe(
    "completed",
  );
  expect(
    currentProjectStage([
      stage,
      event("03", "complete"),
      event("05", "reopen"),
    ]),
  ).toBeNull();
  expect(
    validateProgressEvents([{ ...stage, type: "start" }], "2026-09-08"),
  ).not.toBeNull();
});
