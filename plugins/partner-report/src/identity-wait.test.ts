import { describe, expect, it, vi } from "vitest";
import {
  decodeIdentityWaitPeriod,
  identityConfirmationRequiredState,
  identityWaitBackoff,
  waitForIdentityAndContinue,
  waitForIdentityConfirmation,
} from "./identity-wait.js";

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

describe("identity confirmation wait", () => {
  it("returns a nonterminal identity state with a resumable command", () => {
    expect(
      identityConfirmationRequiredState({
        periodKey: "2026-W32",
        deadlineAt: 123_000,
        force: true,
      }),
    ).toMatchObject({
      status: "feishu_identity_confirmation_required",
      waiting: true,
      discovered: 0,
      read: 0,
      uploaded: 0,
      nextCommand:
        "identity-wait --deadline 123000 --attempt 0 --period-key MjAyNi1XMzI --force",
    });
    expect(decodeIdentityWaitPeriod("MjAyNi1XMzI")).toBe("2026-W32");
  });

  it("backs off instead of busy polling", () => {
    expect([0, 1, 2, 3, 10].map(identityWaitBackoff)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
  });

  it("does not discover, read, upload, or send a scope card while pending", async () => {
    const clock = fakeClock();
    const continueCollection = vi.fn();
    const result = await waitForIdentityAndContinue(
      {
        check: async () => false,
        deadlineAt: 60_000,
        segmentDurationMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
      },
      continueCollection,
    );
    expect(result).toMatchObject({
      continued: false,
      wait: { status: "pending" },
    });
    expect(continueCollection).not.toHaveBeenCalled();
  });

  it("continues the current task exactly once after confirmation", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sendProjectScopeCard = vi
      .fn()
      .mockResolvedValue({ status: "project_scope_approval_required" });
    const result = await waitForIdentityAndContinue(
      {
        check,
        deadlineAt: 60_000,
        segmentDurationMs: 30_000,
        now: clock.now,
        sleep: clock.sleep,
      },
      sendProjectScopeCard,
    );
    expect(result).toMatchObject({
      continued: true,
      value: { status: "project_scope_approval_required" },
    });
    expect(sendProjectScopeCard).toHaveBeenCalledTimes(1);
  });

  it("retries network failures without duplicating continuation side effects", async () => {
    const clock = fakeClock();
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const continueCollection = vi.fn().mockResolvedValue("continued");
    const result = await waitForIdentityAndContinue(
      {
        check,
        deadlineAt: 60_000,
        segmentDurationMs: 30_000,
        now: clock.now,
        sleep: clock.sleep,
        errorCode: () => "NETWORK_RETRY",
      },
      continueCollection,
    );
    expect(result).toMatchObject({ continued: true, value: "continued" });
    expect(continueCollection).toHaveBeenCalledTimes(1);
  });

  it("treats cancellation and hard timeout as non-failures", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForIdentityConfirmation({
        check: async () => false,
        deadlineAt: 10_000,
        segmentDurationMs: 5_000,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    const clock = fakeClock();
    await expect(
      waitForIdentityConfirmation({
        check: async () => false,
        deadlineAt: 3_000,
        segmentDurationMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).resolves.toMatchObject({ status: "timed_out" });
  });
});
