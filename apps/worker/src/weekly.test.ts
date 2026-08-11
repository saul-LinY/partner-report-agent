import { describe, expect, it } from "vitest";
import {
  buildNoActivityIndividualReport,
  buildProjectBuckets,
} from "./weekly.js";

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

describe("no-activity individual report", () => {
  it("states the coverage limit without claiming that no work happened", () => {
    const report = buildNoActivityIndividualReport();

    expect(report.sections).toHaveLength(7);
    expect(report.summary).toContain("未采集到");
    expect(report.summary).toContain("不代表本周期没有开展工作");
    expect(report.qualityWarnings).toContain(
      "NO_REPORTABLE_ACTIVITY_COLLECTED",
    );
    expect(
      report.sections.every((section: any) => section.claims.length === 0),
    ).toBe(true);
  });
});
