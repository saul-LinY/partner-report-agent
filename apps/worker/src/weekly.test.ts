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
      [
        {
          id: projectId,
          name: "Partner Report",
          description: "团队工作报告平台。",
          description_candidate_id: "candidate-a",
          description_candidate: "用于采集并审核团队工作记录的报告平台。",
          description_candidate_source_fingerprint: "a".repeat(64),
        },
      ],
    );

    expect(buckets).toHaveLength(2);
    expect(buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectKey: `project:${projectId}`,
          projectName: "Partner Report",
          projectDescription: "用于采集并审核团队工作记录的报告平台。",
          projectDescriptionCandidateId: "candidate-a",
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
