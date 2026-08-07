import { describe, expect, it, vi } from "vitest";
import {
  decodeWaitPeriod,
  pollBackoff,
  waitForCondition,
  waitForConditionAndContinue,
} from "./poll-wait.js";

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

describe("generic condition polling", () => {
  it("decodes a period key and uses bounded backoff", () => {
    expect(decodeWaitPeriod("MjAyNi1XMzI")).toBe("2026-W32");
    expect([0, 1, 2, 3, 10].map(pollBackoff)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
  });

  it("does not continue while the condition is pending", async () => {
    const clock = fakeClock();
    const continueTask = vi.fn();
    const result = await waitForConditionAndContinue(
      {
        check: async () => false,
        deadlineAt: 60_000,
        segmentDurationMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
      },
      continueTask,
    );
    expect(result).toMatchObject({ continued: false, wait: { status: "pending" } });
    expect(continueTask).not.toHaveBeenCalled();
  });

  it("continues exactly once after confirmation", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const continueTask = vi.fn().mockResolvedValue("continued");
    const result = await waitForConditionAndContinue(
      {
        check,
        deadlineAt: 60_000,
        segmentDurationMs: 30_000,
        now: clock.now,
        sleep: clock.sleep,
      },
      continueTask,
    );
    expect(result).toMatchObject({ continued: true, value: "continued" });
    expect(continueTask).toHaveBeenCalledTimes(1);
  });

  it("retries errors and treats cancellation and timeout as non-failures", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await waitForCondition({
      check,
      deadlineAt: 60_000,
      segmentDurationMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
      errorCode: () => "NETWORK_RETRY",
    });
    expect(result).toMatchObject({ status: "confirmed" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForCondition({
        check: async () => false,
        deadlineAt: 10_000,
        segmentDurationMs: 5_000,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    const timeoutClock = fakeClock();
    await expect(
      waitForCondition({
        check: async () => false,
        deadlineAt: 3_000,
        segmentDurationMs: 10_000,
        now: timeoutClock.now,
        sleep: timeoutClock.sleep,
      }),
    ).resolves.toMatchObject({ status: "timed_out" });
  });
});
