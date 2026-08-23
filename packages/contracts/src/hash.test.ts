import { describe, expect, it } from "vitest";
import { stableJsonHash } from "./hash.js";

describe("stableJsonHash", () => {
  it("ignores object key insertion order at every depth", () => {
    const left = {
      workCards: [{ snapshotId: "snapshot-1", payload: { z: 1, a: 2 } }],
      missingPartnerIds: [],
      previousTeamReport: null,
    };
    const right = {
      previousTeamReport: null,
      missingPartnerIds: [],
      workCards: [{ payload: { a: 2, z: 1 }, snapshotId: "snapshot-1" }],
    };

    expect(stableJsonHash(left)).toBe(stableJsonHash(right));
  });
});
