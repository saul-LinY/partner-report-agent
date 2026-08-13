import { describe, expect, it } from "vitest";
import { buildTeamReportIndividualReports } from "./team-report-source.js";

describe("buildTeamReportIndividualReports", () => {
  it("builds the shared project names and approved descriptions", () => {
    expect(
      buildTeamReportIndividualReports(
        [
          {
            partnerId: "partner-1",
            partnerName: "测试成员",
            reportId: "report-1",
            payload: { summary: "本周摘要" },
            workItemSnapshot: {
              workItems: [
                { project_id: "project-1", title: "旧项目名称" },
                { project_id: "project-1", title: "旧项目名称" },
                { project_id: null, title: "未识别项目" },
              ],
            },
          },
        ],
        [
          {
            id: "project-1",
            name: "当前项目名称",
            description: " 已审核的项目描述。 ",
          },
        ],
      ),
    ).toEqual([
      {
        partnerId: "partner-1",
        partnerName: "测试成员",
        reportId: "report-1",
        payload: { summary: "本周摘要" },
        noReportableActivity: false,
        projectNames: ["旧项目名称", "未识别项目"],
        projectDescriptions: [
          { name: "当前项目名称", description: "已审核的项目描述。" },
        ],
      },
    ]);
  });
});
