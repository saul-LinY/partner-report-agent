import { afterEach, describe, expect, it, vi } from "vitest";
import { teamReportResultSchema } from "@partner-report/contracts";
import { generateStructured } from "./model.js";
import {
  finalizeTeamReport,
  generateTeamReport,
  normalizeTeamReportGeneration,
  teamReportProjects,
  teamReportRequestBatches,
} from "./team-report.js";

vi.mock("./model.js", () => ({ generateStructured: vi.fn() }));
const model = vi.mocked(generateStructured);
const snapshotId = "11111111-1111-4111-8111-111111111111";
const card = (
  partnerId = "saul",
  projectKey = "novel",
  title = "AI_novel",
) => ({
  partnerId,
  partnerName: partnerId,
  snapshotId,
  projectNames: [title],
  workItems: [
    {
      title,
      status: "in_progress",
      description: "小说创作工具",
      payload: {
        projectKey,
        overview: "完成创作流程测试。",
        dailyProgress: [{ date: "2026-09-04", summary: "完成全面测试。" }],
      },
    },
  ],
});
const legacy = (rows: string[]) => ({
  payload: {
    markdown: [
      "| 成员 | 项目 | 本周工作明细 |",
      "| --- | --- | --- |",
      ...rows,
    ].join("\n"),
  },
});

afterEach(() => vi.resetAllMocks());

describe("weekly report baselines", () => {
  it("matches legacy records by exact person and project and retains complete cards", () => {
    const workCards = [card(), card("leon"), card("saul", "other", "AI")];
    const projects = teamReportProjects({
      workCards,
      previousTeamReport: legacy([
        "| saul | AI_novel | 完成写作初版。 |",
        "| leon | AI_novel | 确定写作需求。 |",
      ]),
    });
    expect(projects.map((p) => p.previousWeek)).toEqual([
      "完成写作初版。",
      "确定写作需求。",
      null,
    ]);
    expect(projects[0]!.thisWeek).toEqual(workCards[0]!.workItems);
  });

  it("parses escaped table cells and refuses ambiguous historical records", () => {
    const input = {
      workCards: [card("saul", "a", "A|B")],
      previousTeamReport: legacy(["| **saul** | A\\|B | 初步支持甲\\|乙。 |"]),
    };
    expect(teamReportProjects(input)[0]!.previousWeek).toBe("初步支持甲|乙。");
    input.previousTeamReport = legacy([
      "| saul | A\\|B | 甲 |",
      "| saul | A\\|B | 乙 |",
    ]);
    expect(teamReportProjects(input)[0]!.previousWeek).toBeNull();
  });

  it("does not compare two members sharing the same display name", () => {
    const workCards = [card("a"), card("b")].map((c) => ({
      ...c,
      partnerName: "同名",
    }));
    expect(
      teamReportProjects({
        workCards,
        previousTeamReport: legacy(["| 同名 | AI_novel | 已完成。 |"]),
      }).map((p) => p.previousWeek),
    ).toEqual([null, null]);
  });

  it("uses stable identities across renames and rejects a different project with the same title", () => {
    const previousTeamReport = {
      payload: {
        projectProgress: [
          {
            partnerId: "saul",
            projectKey: "novel",
            projectName: "旧名称",
            progress: "初版。",
          },
          {
            partnerId: "leon",
            projectKey: "different",
            projectName: "AI_novel",
            progress: "别的项目。",
          },
        ],
      },
    };
    expect(
      teamReportProjects({
        workCards: [card(), card("leon")],
        previousTeamReport,
      }).map((p) => p.previousWeek),
    ).toEqual(["初版。", null]);
  });

  it("uses edited Markdown when structured progress was cleared", () => {
    const previousTeamReport = {
      payload: {
        markdown:
          "| 项目负责人 | 项目名称 | 较上周进展 |\n| --- | --- | --- |\n| saul | AI\\_novel | 修改后的结论。 |",
        sections: [{ key: "project_progress", markdown: "旧正文" }],
      },
    };
    expect(
      teamReportProjects({ workCards: [card()], previousTeamReport })[0]!
        .previousWeek,
    ).toBe("修改后的结论。");
  });

  it("merges cards for the same owner/project and skips coverage-only records", () => {
    const workCards = [
      card(),
      { ...card(), snapshotId: "another" },
      { ...card("empty"), noReportableActivity: true },
    ];
    const projects = teamReportProjects({ workCards });
    expect(projects).toHaveLength(1);
    expect(projects[0]!.thisWeek).toHaveLength(2);
    expect(projects[0]!.workCardSnapshotIds).toEqual([snapshotId, "another"]);
    expect(
      teamReportRequestBatches({
        workCards: ["a", "b", "c", "d", "e"].map((id) => card(id)),
      }),
    ).toBe(4);
  });
});

describe("project writing followed by team summary", () => {
  it("preserves long output, uses the selected model and sends full cards to both stages", async () => {
    const progress = "完整成果。".repeat(100);
    const summary = "团队成果。".repeat(100);
    const personalSummary = "个人成果。".repeat(100);
    model.mockResolvedValueOnce({ progress }).mockResolvedValueOnce({
      summary,
      partnerSummaries: { "person-1": personalSummary },
      blockers: [],
    });
    const input = {
      workCards: [card()],
      previousTeamReport: legacy(["| saul | AI_novel | 上周初版。 |"]),
      regenerationInstructions: "强调创作体验",
    };
    const generated = await generateTeamReport(
      input,
      "deepseek-v4-flash:cloud",
    );
    const report = teamReportResultSchema.parse(
      finalizeTeamReport(
        normalizeTeamReportGeneration(
          generated,
          input.workCards,
          [],
          "deepseek-v4-flash:cloud",
        ),
        "2026-09-07",
      ),
    );
    expect(model).toHaveBeenCalledTimes(2);
    const [projectCall, summaryCall] = model.mock.calls.map(([arg]) => arg);
    expect(projectCall).toMatchObject({
      model: "deepseek-v4-flash:cloud",
      reasoningEffort: "none",
      input: {
        thisWeek: input.workCards[0]!.workItems,
        previousWeek: "上周初版。",
        regenerationInstructions: "强调创作体验",
      },
    });
    expect(summaryCall).toMatchObject({
      model: "deepseek-v4-flash:cloud",
      input: {
        projects: [{ thisWeek: input.workCards[0]!.workItems, progress }],
      },
    });
    expect((summaryCall!.input as any).projects[0]).not.toHaveProperty(
      "previousWeek",
    );
    expect(report.sections).toHaveLength(1);
    expect(report.markdown).toContain(progress);
    expect(report.markdown).toContain(`**本周总结：** ${personalSummary}`);
    expect(report.summary).toBe(summary);
    expect(report.projectProgress[0].progress).toBe(progress);
    expect(report.sections[0].claims[0].workCardSnapshotIds).toEqual([
      snapshotId,
    ]);
    expect(report.markdown).not.toContain("项目阻塞");
  });

  it("groups actual blockers under the correct owner/project and escapes generated prose", async () => {
    model
      .mockResolvedValueOnce({ progress: "已支持 A|B。" })
      .mockResolvedValueOnce({
        summary: "本周成果。",
        partnerSummaries: { "person-1": "已支持 A|B。" },
        blockers: [
          {
            projectRef: "project-1",
            problem: "缺少必要授权",
            impact: "无法完成外部发布",
          },
          {
            projectRef: "project-1",
            problem: "缺少资料",
            impact: "无法完成复核",
          },
        ],
      });
    const report = await generateTeamReport(
      { workCards: [card()] },
      "test-model",
    );
    expect(report.sections).toHaveLength(2);
    expect(report.sections[0].markdown).toContain("A\\|B");
    expect(report.sections[1].markdown).toBe(
      "- **saul**\n  - **AI\\_novel**\n    - 缺少必要授权；无法完成外部发布\n    - 缺少资料；无法完成复核",
    );
    expect(report.sections[1].claims).toHaveLength(2);
    expect(report.sections[1].markdown).not.toContain("| --- |");
    expect(
      teamReportProjects({
        workCards: [card()],
        previousTeamReport: { payload: report },
      })[0]!.previousWeek,
    ).toBe("已支持 A|B。");
  });

  it("summarizes all projects per identity and keeps same-name members and evidence separate", async () => {
    const secondSnapshot = "22222222-2222-4222-8222-222222222222";
    const thirdSnapshot = "33333333-3333-4333-8333-333333333333";
    const workCards = [
      card("a", "research", "调研"),
      { ...card("b", "product", "产品"), snapshotId: thirdSnapshot },
      { ...card("a", "delivery", "交付"), snapshotId: secondSnapshot },
      { ...card("empty"), noReportableActivity: true },
    ].map((item) => ({ ...item, partnerName: "同名" }));
    model
      .mockResolvedValueOnce({ progress: "确定用户需求。" })
      .mockResolvedValueOnce({ progress: "完成产品测试。" })
      .mockResolvedValueOnce({ progress: "交付可用初版。" })
      .mockResolvedValueOnce({
        summary: "完成需求验证与产品交付。",
        partnerSummaries: {
          "person-1": "从需求验证推进到初版交付，<成果>涵盖调研与交付。",
          "person-2": "完善产品并完成测试。",
        },
        blockers: [],
      });
    const report = await generateTeamReport({ workCards }, "test-model");
    const summaryCall = model.mock.calls[3]![0];
    expect((summaryCall.input as any).people).toEqual([
      {
        ref: "person-1",
        partnerId: "a",
        partnerName: "同名",
        projectRefs: ["project-1", "project-3"],
      },
      {
        ref: "person-2",
        partnerId: "b",
        partnerName: "同名",
        projectRefs: ["project-2"],
      },
    ]);
    const section = report.sections[0];
    const [, firstPerson, secondPerson] = section.markdown.split("### 同名\n");
    expect(firstPerson).toContain(
      "**本周总结：** 从需求验证推进到初版交付，&lt;成果&gt;涵盖调研与交付。",
    );
    expect(firstPerson).toContain("| 同名 | 调研 | 确定用户需求。 |");
    expect(firstPerson).toContain("| 同名 | 交付 | 交付可用初版。 |");
    expect(firstPerson).not.toContain("完成产品测试。");
    expect(secondPerson).toContain("**本周总结：** 完善产品并完成测试。");
    expect(secondPerson).toContain("| 同名 | 产品 | 完成产品测试。 |");
    expect(section.claims.slice(3)).toEqual([
      {
        claim: "从需求验证推进到初版交付，<成果>涵盖调研与交付。",
        workCardSnapshotIds: [snapshotId, secondSnapshot],
      },
      { claim: "完善产品并完成测试。", workCardSnapshotIds: [thirdSnapshot] },
    ]);
    expect(
      summaryCall.schema.safeParse({
        summary: "总览",
        partnerSummaries: { "person-1": "少了一个人" },
        blockers: [],
      }).success,
    ).toBe(false);
  });

  it("makes no calls or invented blocker rows without project evidence", async () => {
    const report = await generateTeamReport(
      { workCards: [{ ...card(), noReportableActivity: true }] },
      "test-model",
    );
    expect(model).not.toHaveBeenCalled();
    expect(report.projectProgress).toEqual([]);
    expect(report.sections.map((s: any) => s.key)).toEqual([
      "project_progress",
    ]);
  });

  it("waits for the other in-flight request before failing the job", async () => {
    let finish!: (value: unknown) => void;
    model
      .mockRejectedValueOnce(new Error("upstream error"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    let finished = false;
    const pending = generateTeamReport(
      { workCards: [card("a"), card("b"), card("c")] },
      "test-model",
    ).catch((error) => {
      finished = true;
      return error;
    });
    await Promise.resolve();
    expect(model).toHaveBeenCalledTimes(2);
    expect(finished).toBe(false);
    finish({ progress: "完成。" });
    expect(await pending).toEqual(new Error("upstream error"));
    expect(model).toHaveBeenCalledTimes(2);
  });
});
