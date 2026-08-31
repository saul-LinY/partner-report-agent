import { describe, expect, it } from "vitest";
import {
  appendHostThreadReadPage,
  beginHostThreadRead,
  completedHostThread,
  hostThreadReadTool,
} from "./host-thread-read.js";

function page(input: {
  nextCursor: string | null;
  hasMore: boolean;
  turns: unknown[];
  hostId?: string;
}) {
  return {
    thread: {
      id: "thread-1",
      hostId: input.hostId ?? "remote-a",
      kind: "codex",
      title: "Remote task",
      cwd: "/srv/project",
      updatedAt: "2026-08-31T02:00:00.000Z",
    },
    page: {
      order: "newest_first",
      limit: 10,
      nextCursor: input.nextCursor,
      hasMore: input.hasMore,
    },
    turns: input.turns,
  };
}

describe("host thread pagination", () => {
  it("requests private, output-free pages and assembles them chronologically", () => {
    const initial = beginHostThreadRead({
      id: "thread-1",
      hostId: "remote-a",
    });
    expect(hostThreadReadTool(initial)).toMatchObject({
      name: "codex_app__read_thread",
      arguments: {
        threadId: "thread-1",
        hostId: "remote-a",
        turnLimit: 1,
        includeOutputs: false,
      },
    });
    const first = appendHostThreadReadPage(
      initial,
      page({ nextCursor: "older", hasMore: true, turns: [{ id: "new" }] }),
    );
    expect(first.complete).toBe(false);
    expect(hostThreadReadTool(first.pending).arguments.cursor).toBe("older");
    const second = appendHostThreadReadPage(
      first.pending,
      page({ nextCursor: null, hasMore: false, turns: [{ id: "old" }] }),
    );
    expect(second.complete).toBe(true);
    expect(completedHostThread(second.pending).turns).toEqual([
      { id: "old" },
      { id: "new" },
    ]);
  });

  it("rejects a mismatched host and a cursor that does not advance", () => {
    const initial = beginHostThreadRead({
      id: "thread-1",
      hostId: "remote-a",
    });
    expect(() =>
      appendHostThreadReadPage(
        initial,
        page({
          nextCursor: null,
          hasMore: false,
          turns: [],
          hostId: "remote-b",
        }),
      ),
    ).toThrow(/不匹配/);
    const first = appendHostThreadReadPage(
      initial,
      page({ nextCursor: "older", hasMore: true, turns: [] }),
    );
    expect(() =>
      appendHostThreadReadPage(
        first.pending,
        page({ nextCursor: "older", hasMore: true, turns: [] }),
      ),
    ).toThrow(/没有推进/);
  });

  it("rejects a message at the host truncation boundary", () => {
    const initial = beginHostThreadRead({
      id: "thread-1",
      hostId: "remote-a",
    });
    expect(() =>
      appendHostThreadReadPage(
        initial,
        page({
          nextCursor: null,
          hasMore: false,
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "x".repeat(20_000) }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/截断/);
  });
});
