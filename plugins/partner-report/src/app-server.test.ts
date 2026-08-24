import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_THREAD_LIST_TIMEOUT_MS,
  CODEX_THREAD_READ_TIMEOUT_MS,
  CODEX_THREAD_TURNS_PAGE_LIMIT,
  CodexAppServer,
} from "./app-server.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodexAppServer.listThreads", () => {
  it("reads only recent state database metadata and stops at the activity cutoff", async () => {
    const server = new CodexAppServer("codex");
    const request = vi
      .spyOn(server, "request")
      .mockResolvedValueOnce({
        data: [
          {
            id: "new-session",
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
          },
          {
            id: "continued-old-session",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-08-15T00:00:00.000Z",
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "cutoff-session",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
          },
          {
            id: "older-session",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-09T23:59:59.000Z",
          },
        ],
        nextCursor: "page-3",
      });

    const threads = await server.listThreads({
      updatedSince: "2026-08-10T00:00:00.000Z",
    });

    expect(threads.map((thread) => thread.id)).toEqual([
      "new-session",
      "continued-old-session",
      "cutoff-session",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "thread/list",
      {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer"],
        archived: false,
        useStateDbOnly: true,
      },
      CODEX_THREAD_LIST_TIMEOUT_MS,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/list",
      {
        cursor: "page-2",
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer"],
        archived: false,
        useStateDbOnly: true,
      },
      CODEX_THREAD_LIST_TIMEOUT_MS,
    );
  });

  it("reports the failing page and app-server diagnostics", async () => {
    const server = new CodexAppServer("codex");
    vi.spyOn(server, "request")
      .mockResolvedValueOnce({ data: [], nextCursor: "page-2" })
      .mockRejectedValueOnce(new Error("timed out"));
    (server as unknown as { stderr: string }).stderr = "rollout lock busy";

    await expect(
      server.listThreads({ updatedSince: "2026-08-10T00:00:00.000Z" }),
    ).rejects.toThrow(
      "thread/list 第 2 页失败：timed out；Codex app-server: rollout lock busy",
    );
  });

  it("rejects an invalid activity cutoff before contacting app-server", async () => {
    const server = new CodexAppServer("codex");
    const request = vi.spyOn(server, "request");

    await expect(
      server.listThreads({ updatedSince: "not-a-date" }),
    ).rejects.toThrow("Session 活动扫描开始时间无效");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the stable timeout code for thread listing", async () => {
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

describe("CodexAppServer.readThread", () => {
  it("uses the legacy full-history read for legacy threads", async () => {
    const server = new CodexAppServer("codex");
    const request = vi
      .spyOn(server, "request")
      .mockResolvedValueOnce({
        thread: { id: "legacy-session", historyMode: "legacy", turns: [] },
      })
      .mockResolvedValueOnce({
        thread: {
          id: "legacy-session",
          historyMode: "legacy",
          turns: [{ id: "turn-1" }],
        },
      });

    await expect(server.readThread("legacy-session")).resolves.toMatchObject({
      turns: [{ id: "turn-1" }],
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "thread/read",
      { threadId: "legacy-session", includeTurns: false },
      CODEX_THREAD_READ_TIMEOUT_MS,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/read",
      { threadId: "legacy-session", includeTurns: true },
      CODEX_THREAD_READ_TIMEOUT_MS,
    );
  });

  it("reads paginated threads in chronological order with full items", async () => {
    const server = new CodexAppServer("codex");
    const request = vi
      .spyOn(server, "request")
      .mockResolvedValueOnce({
        thread: {
          id: "paginated-session",
          historyMode: "paginated",
          turns: [],
        },
      })
      .mockResolvedValueOnce({
        data: [{ id: "turn-1" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [{ id: "turn-2" }],
        nextCursor: null,
      });

    await expect(server.readThread("paginated-session")).resolves.toMatchObject(
      {
        turns: [{ id: "turn-1" }, { id: "turn-2" }],
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/turns/list",
      {
        threadId: "paginated-session",
        limit: CODEX_THREAD_TURNS_PAGE_LIMIT,
        sortDirection: "asc",
        itemsView: "full",
      },
      CODEX_THREAD_READ_TIMEOUT_MS,
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "thread/turns/list",
      {
        threadId: "paginated-session",
        cursor: "page-2",
        limit: CODEX_THREAD_TURNS_PAGE_LIMIT,
        sortDirection: "asc",
        itemsView: "full",
      },
      CODEX_THREAD_READ_TIMEOUT_MS,
    );
  });

  it("returns a stable safe code when paginated reading fails", async () => {
    const server = new CodexAppServer("codex");
    vi.spyOn(server, "request")
      .mockResolvedValueOnce({
        thread: {
          id: "paginated-session",
          historyMode: "paginated",
          turns: [],
        },
      })
      .mockRejectedValueOnce(new Error("private rollout detail"));

    await expect(server.readThread("paginated-session")).rejects.toMatchObject({
      code: "CODEX_THREAD_TURNS_LIST_FAILED",
      message: "Codex Session 分页内容读取失败。",
    });
  });

  it("classifies invalid paginated history without exposing its lineage", async () => {
    const server = new CodexAppServer("codex");
    vi.spyOn(server, "request")
      .mockResolvedValueOnce({
        thread: {
          id: "paginated-session",
          historyMode: "paginated",
          turns: [],
        },
      })
      .mockRejectedValueOnce(
        new Error(
          "invalid paginated history lineage for private-id: cycle detected",
        ),
      );

    await expect(server.readThread("paginated-session")).rejects.toMatchObject({
      code: "CODEX_THREAD_HISTORY_INVALID",
      message: "Codex Session 分页历史无效。",
    });
  });
});
