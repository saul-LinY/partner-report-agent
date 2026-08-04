import { describe, expect, it } from "vitest";
import { buildProjectBuckets } from "./weekly.js";

describe("project aggregation buckets", () => {
  it("creates exactly one bucket for every project identity", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const buckets = buildProjectBuckets(
      [
        { id: "fact-a", payload: { projectId } },
        { id: "fact-b", payload: { project: { id: projectId } } },
        {
          id: "fact-c",
          payload: {
            project: {
              id: null,
              name: "自动发现项目",
              rootFingerprint: "f".repeat(64),
            },
          },
        },
      ],
      [{ id: projectId, name: "Partner Report" }],
    );

    expect(buckets).toHaveLength(2);
    expect(buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectKey: `project:${projectId}`,
          projectName: "Partner Report",
          factIds: ["fact-a", "fact-b"],
        }),
        expect.objectContaining({
          projectKey: `root:${"f".repeat(64)}`,
          projectName: "自动发现项目",
          factIds: ["fact-c"],
        }),
      ]),
    );
  });
});
