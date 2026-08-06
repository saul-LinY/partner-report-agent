export type IdentityWaitResult =
  | { status: "confirmed"; attempt: number }
  | { status: "pending"; attempt: number; lastErrorCode: string | null }
  | { status: "timed_out"; attempt: number; lastErrorCode: string | null }
  | { status: "cancelled"; attempt: number };

export type IdentityWaitOptions = {
  check: () => Promise<boolean>;
  deadlineAt: number;
  segmentDurationMs: number;
  attempt?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  errorCode?: (error: unknown) => string;
};

export function identityConfirmationRequiredState(input: {
  periodKey: string;
  deadlineAt: number;
  attempt?: number;
  force?: boolean;
  lastErrorCode?: string | null;
}) {
  const nextCommand = [
    "identity-wait",
    `--deadline ${Math.trunc(input.deadlineAt)}`,
    `--attempt ${Math.max(0, Math.trunc(input.attempt ?? 0))}`,
    `--period-key ${Buffer.from(input.periodKey, "utf8").toString("base64url")}`,
    ...(input.force ? ["--force"] : []),
  ].join(" ");
  return {
    status: "feishu_identity_confirmation_required" as const,
    waiting: true,
    periodKey: input.periodKey,
    read: 0,
    uploaded: 0,
    discovered: 0,
    ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
    nextCommand,
    message:
      "请在飞书身份卡中确认审核身份。当前任务会低频等待，确认前不会扫描项目或读取 Session 内容。",
  };
}

export function decodeIdentityWaitPeriod(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return "unknown";
  try {
    return Buffer.from(value, "base64url").toString("utf8") || "unknown";
  } catch {
    return "unknown";
  }
}

const MAX_BACKOFF_MS = 8_000;

function defaultSleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function identityWaitBackoff(attempt: number) {
  return Math.min(
    1_000 * 2 ** Math.min(Math.max(attempt, 0), 3),
    MAX_BACKOFF_MS,
  );
}

export async function waitForIdentityConfirmation(
  options: IdentityWaitOptions,
): Promise<IdentityWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const segmentEndsAt = Math.min(
    options.deadlineAt,
    now() + Math.max(1_000, options.segmentDurationMs),
  );
  let attempt = Math.max(0, options.attempt ?? 0);
  let lastErrorCode: string | null = null;

  while (now() < segmentEndsAt) {
    if (options.signal?.aborted) return { status: "cancelled", attempt };
    try {
      if (await options.check()) return { status: "confirmed", attempt };
      lastErrorCode = null;
    } catch (error) {
      lastErrorCode =
        options.errorCode?.(error) ?? "IDENTITY_STATUS_UNAVAILABLE";
    }

    const remaining = segmentEndsAt - now();
    if (remaining <= 0) break;
    await sleep(
      Math.min(identityWaitBackoff(attempt), remaining),
      options.signal,
    );
    attempt += 1;
  }

  if (options.signal?.aborted) return { status: "cancelled", attempt };
  if (now() >= options.deadlineAt)
    return { status: "timed_out", attempt, lastErrorCode };
  return { status: "pending", attempt, lastErrorCode };
}

export async function waitForIdentityAndContinue<T>(
  options: IdentityWaitOptions,
  continueCollection: () => Promise<T>,
): Promise<
  | {
      continued: true;
      wait: Extract<IdentityWaitResult, { status: "confirmed" }>;
      value: T;
    }
  | {
      continued: false;
      wait: Exclude<IdentityWaitResult, { status: "confirmed" }>;
    }
> {
  const wait = await waitForIdentityConfirmation(options);
  if (wait.status !== "confirmed") return { continued: false, wait };
  return { continued: true, wait, value: await continueCollection() };
}
