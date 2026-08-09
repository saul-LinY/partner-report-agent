import { describe, expect, it } from "vitest";
import { stableJsonHash } from "./hash.js";

describe("stableJsonHash", () => {
  it("ignores object key insertion order at every depth", () => {
    const left = {
      individualReports: [{ reportId: "report-1", payload: { z: 1, a: 2 } }],
      missingPartnerIds: [],
      previousTeamReport: null,
    };
    const right = {
      previousTeamReport: null,
      missingPartnerIds: [],
      individualReports: [{ payload: { a: 2, z: 1 }, reportId: "report-1" }],
    };

    expect(stableJsonHash(left)).toBe(stableJsonHash(right));
  });
});
