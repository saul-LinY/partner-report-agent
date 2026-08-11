import { describe, expect, it } from "vitest";
import { FACTS_PAGE_SIZE, factsPageCount } from "./facts.js";

describe("facts pagination", () => {
  it("shows ten contributions per page", () => {
    expect(FACTS_PAGE_SIZE).toBe(10);
    expect(factsPageCount(19)).toBe(2);
    expect(factsPageCount(20)).toBe(2);
    expect(factsPageCount(21)).toBe(3);
  });
});
