import { describe, expect, it } from "vitest";
import {
  CODEX_HOST_THREAD_LIST_LIMIT,
  assertHostCollectionDiscoveryComplete,
  hostCollectionDiscoveryStatus,
  hostProjectDiscoveryMayBePartial,
  hostThreadKey,
  parseHostCollectionDiscoveryInput,
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
          hostId: "local",
          kind: "codex",
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

  it("keeps the same thread id distinct across hosts", () => {
    const input = parseHostProjectDiscoveryInput({
      threads: [
        { ...thread("same"), hostId: "host-a" },
        { ...thread("same"), hostId: "host-b" },
      ],
    });
    expect(uniqueHostProjectDiscoveryThreads(input)).toHaveLength(2);
    expect(hostThreadKey(input.threads[0]!)).not.toBe(
      hostThreadKey(input.threads[1]!),
    );
  });

  it("rejects unavailable hosts and a capped page that misses the scan window", () => {
    const unavailable = parseHostCollectionDiscoveryInput({
      threads: [],
      pinnedThreads: [],
      unavailableHosts: ["host-a"],
      unavailableSources: [],
    });
    expect(() =>
      assertHostCollectionDiscoveryComplete(
        unavailable,
        "2026-08-27T00:00:00.000Z",
      ),
    ).toThrow(/不可用/);

    const capped = parseHostCollectionDiscoveryInput({
      threads: Array.from(
        { length: CODEX_HOST_THREAD_LIST_LIMIT },
        (_, index) => ({
          ...thread(`recent-${index}`),
          hostId: "host-a",
        }),
      ),
      pinnedThreads: [],
      unavailableHosts: [],
      unavailableSources: [],
    });
    expect(() =>
      assertHostCollectionDiscoveryComplete(capped, "2026-08-27T00:00:00.000Z"),
    ).toThrow(/没有覆盖完整/);
    expect(() =>
      assertHostCollectionDiscoveryComplete(capped, "2026-08-28T00:00:00.000Z"),
    ).not.toThrow();
  });

  it("reports remote discovery gaps without requiring local collection to stop", () => {
    const unavailable = parseHostCollectionDiscoveryInput({
      threads: [],
      pinnedThreads: [],
      unavailableHosts: ["host-a"],
      unavailableSources: [],
    });
    expect(
      hostCollectionDiscoveryStatus(unavailable, "2026-08-27T00:00:00.000Z"),
    ).toEqual({
      complete: false,
      warnings: ["REMOTE_HOST_DISCOVERY_UNAVAILABLE"],
    });

    const noRemote = parseHostCollectionDiscoveryInput({
      threads: [],
      pinnedThreads: [],
      unavailableHosts: [],
      unavailableSources: [],
    });
    expect(
      hostCollectionDiscoveryStatus(noRemote, "2026-08-27T00:00:00.000Z"),
    ).toEqual({ complete: true, warnings: [] });

    const capped = parseHostCollectionDiscoveryInput({
      threads: Array.from(
        { length: CODEX_HOST_THREAD_LIST_LIMIT },
        (_, index) => ({ ...thread(`recent-${index}`), hostId: "host-a" }),
      ),
      pinnedThreads: [],
      unavailableHosts: [],
      unavailableSources: [],
    });
    expect(
      hostCollectionDiscoveryStatus(capped, "2026-08-27T00:00:00.000Z"),
    ).toEqual({
      complete: false,
      warnings: ["REMOTE_HOST_DISCOVERY_WINDOW_INCOMPLETE"],
    });
  });
});
