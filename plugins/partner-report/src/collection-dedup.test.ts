import { describe, expect, it } from "vitest";
import {
  buildKnownSessionIndex,
  matchingKnownDecision,
} from "./collection-dedup.js";

const sessionKey = "a".repeat(64);
const legacyHash = "b".repeat(64);
const stableHash = "c".repeat(64);

describe("collection deduplication", () => {
  it("matches both remote legacy hashes and stable local accepted hashes", () => {
    const known = buildKnownSessionIndex({
      remoteAccepted: [{ sessionKey, contentHash: legacyHash }],
      localAccepted: { [sessionKey]: { contentHash: stableHash } },
      localIgnored: {},
    });
    expect(matchingKnownDecision(known[sessionKey], [legacyHash])).toBe(
      "accepted",
    );
    expect(matchingKnownDecision(known[sessionKey], [stableHash])).toBe(
      "accepted",
    );
  });

  it("lets the local ignored decision supersede an older remote revision", () => {
    const known = buildKnownSessionIndex({
      remoteAccepted: [{ sessionKey, contentHash: legacyHash }],
      localAccepted: {},
      localIgnored: { [sessionKey]: { contentHash: stableHash } },
    });
    expect(matchingKnownDecision(known[sessionKey], [stableHash])).toBe(
      "ignored",
    );
    expect(matchingKnownDecision(known[sessionKey], [legacyHash])).toBeNull();
  });

  it("does not match when complete Session content changes", () => {
    const known = buildKnownSessionIndex({
      remoteAccepted: [],
      localAccepted: { [sessionKey]: { contentHash: stableHash } },
      localIgnored: {},
    });
    expect(
      matchingKnownDecision(known[sessionKey], ["d".repeat(64)]),
    ).toBeNull();
  });
});
