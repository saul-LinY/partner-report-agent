import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_THREAD_LIST_TIMEOUT_MS,
  CodexAppServer,
} from "./app-server.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Codex app-server timeouts", () => {
  it("allows thread listing to run for up to 120 seconds", async () => {
    const server = new CodexAppServer("codex");
    const request = vi
      .spyOn(server, "request")
      .mockResolvedValue({ data: [], nextCursor: null });

    await server.listThreads();

    expect(CODEX_THREAD_LIST_TIMEOUT_MS).toBe(120_000);
    expect(request).toHaveBeenCalledWith(
      "thread/list",
      expect.objectContaining({ limit: 100 }),
      CODEX_THREAD_LIST_TIMEOUT_MS,
    );
  });

  it("reports a specific code when thread listing times out", async () => {
    vi.useFakeTimers();
    const server = new CodexAppServer("codex");
    const stdin = { write: vi.fn() };
    Object.assign(server, { process: { stdin } });

    const pending = server.request("thread/list", {}, 30_000);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "CODEX_SESSION_LIST_TIMEOUT",
      message: "thread/list timed out after 30000ms",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(stdin.write).toHaveBeenCalledOnce();
  });
});
