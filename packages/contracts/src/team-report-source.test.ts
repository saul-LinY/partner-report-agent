import { describe, expect, it } from "vitest";
import { buildTeamReportWorkCards } from "./team-report-source.js";

describe("buildTeamReportWorkCards", () => {
  it("builds report inputs from approved work cards without project descriptions", () => {
    expect(
      buildTeamReportWorkCards([
        {
          partnerId: "partner-1",
          partnerName: "测试成员",
          snapshotId: "snapshot-1",
          workItemSnapshot: {
            workItems: [
              { project_id: "project-1", title: "旧项目名称" },
              { project_id: "project-1", title: "旧项目名称" },
              { project_id: null, title: "未识别项目" },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        partnerId: "partner-1",
        partnerName: "测试成员",
        snapshotId: "snapshot-1",
        workItems: [
          { project_id: "project-1", title: "旧项目名称" },
          { project_id: "project-1", title: "旧项目名称" },
          { project_id: null, title: "未识别项目" },
        ],
        noReportableActivity: false,
        projectNames: ["旧项目名称", "未识别项目"],
      },
    ]);
  });
});
