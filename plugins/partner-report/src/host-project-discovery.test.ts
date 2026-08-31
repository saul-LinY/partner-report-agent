import { describe, expect, it } from "vitest";
import {
  CODEX_HOST_THREAD_LIST_LIMIT,
  hostProjectDiscoveryMayBePartial,
  parseHostProjectDiscoveryInput,
  uniqueHostProjectDiscoveryThreads,
} from "./host-project-discovery.js";

function thread(id: string) {
  return {
    id,
    cwd: `/workspace/${id}`,
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
}

describe("host project discovery input", () => {
  it("accepts one lightweight Codex host page and applies safe defaults", () => {
    expect(
      parseHostProjectDiscoveryInput({
        threads: [thread("thread-1")],
        pinnedThreads: [],
      }),
    ).toEqual({
      threads: [
        {
          ...thread("thread-1"),
          archived: false,
          ephemeral: false,
          systemGenerated: false,
        },
      ],
      pinnedThreads: [],
    });
  });

  it("rejects more than the Codex host maximum instead of paginating", () => {
    expect(() =>
      parseHostProjectDiscoveryInput({
        threads: Array.from(
          { length: CODEX_HOST_THREAD_LIST_LIMIT + 1 },
          (_, index) => thread(`thread-${index}`),
        ),
      }),
    ).toThrow();
  });

  it("deduplicates pinned tasks and reports a potentially partial page", () => {
    const input = parseHostProjectDiscoveryInput({
      threads: Array.from(
        { length: CODEX_HOST_THREAD_LIST_LIMIT },
        (_, index) => thread(`thread-${index}`),
      ),
      pinnedThreads: [thread("thread-1"), thread("pinned-only")],
    });

    expect(uniqueHostProjectDiscoveryThreads(input)).toHaveLength(
      CODEX_HOST_THREAD_LIST_LIMIT + 1,
    );
    expect(hostProjectDiscoveryMayBePartial(input)).toBe(true);
  });

  it("does not accept conversation content in discovery metadata", () => {
    expect(() =>
      parseHostProjectDiscoveryInput({
        threads: [{ ...thread("thread-1"), content: "private transcript" }],
      }),
    ).toThrow();
  });
});
