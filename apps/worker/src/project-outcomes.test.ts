import { describe, expect, it } from "vitest";
import {
  projectCardWritingInput,
  projectOutcomeInput,
  projectOutcomeMaterialSchema,
  validateOutcomeReferences,
} from "./project-outcomes.js";

const bucket = {
  projectKey: "project-1",
  projectName: "市场研究",
  projectDescription: "帮助小团队选择产品方向。",
  facts: [
    {
      id: "fact-a",
      source_occurred_at: "2026-09-01 23:30:00+00",
      payload: {
        title: "生成方案",
        activity: { startedAt: "2026-08-20T00:00:00Z" },
        contributions: [{ kind: "outcome", text: "生成十份方案" }],
      },
    },
    {
      id: "fact-b",
      payload: {
        activity: { endedAt: "2026-09-02T10:00:00Z" },
        summary: "完成评估",
      },
    },
  ],
};
const material = () => ({
  projectPurpose: "帮助小团队选择产品方向。",
  weeklyFocus: ["产品方案研究"],
  daily: [
    {
      date: "2026-09-01",
      outcomes: [
        {
          done: "生成十份方案",
          purpose: "用于产品评估",
          unfinished: [],
          evidenceRefs: ["F1"],
        },
      ],
    },
    {
      date: "2026-09-02",
      outcomes: [
        {
          done: "完成方案评估",
          purpose: "比较投入方向",
          unfinished: ["未验证真实市场需求"],
          evidenceRefs: ["F2"],
        },
      ],
    },
  ],
});

describe("fixed project outcome inputs", () => {
  it("preserves report dates and excludes unrelated session metadata", () => {
    const input = projectOutcomeInput(bucket, { id: "period" });
    expect(input.facts.map((fact: any) => fact.date)).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
    expect(input.facts[0]).not.toHaveProperty("id");
    expect(input.facts[0]).not.toHaveProperty("activity");
    expect(input.facts[0].contributions).toEqual(
      bucket.facts[0]!.payload.contributions,
    );
  });

  it("rejects unknown or cross-date evidence without adding a model review stage", () => {
    const input = projectOutcomeInput(bucket, {});
    for (const ref of ["invented", "F2"]) {
      const output = material();
      output.daily[0]!.outcomes[0]!.evidenceRefs = [ref];
      expect(() => validateOutcomeReferences(output, input)).toThrow(
        "Outcome dates or evidence references",
      );
    }
    const missingDate = material();
    missingDate.daily.pop();
    expect(() => validateOutcomeReferences(missingDate, input)).toThrow();
    expect(
      validateOutcomeReferences(
        projectOutcomeMaterialSchema.parse(material()),
        input,
      ),
    ).toEqual(material());
  });

  it("writes only from the fixed draft, current card and chronological review instructions", () => {
    const currentCard = {
      overview: "上次用户修正的概览",
      dailyProgress: [{ date: "2026-09-03", summary: "用户纠正了日期" }],
    };
    const input = projectCardWritingInput(
      {
        projectBuckets: [
          {
            ...bucket,
            projectDescription: "后来改动的介绍",
            previousProjectStatus: {
              value: "delivery",
              periodKey: "last-week",
            },
            facts: [{ secret: "raw fact" }],
          },
        ],
        currentCard,
        reviewInstructions: ["将工作日期改为周三", "突出方案评估"],
        reviewInstruction: "突出方案评估",
      },
      {
        id: "draft",
        source_payload: { bucket, period: { id: "period" } },
        material: material(),
      },
    );
    expect(input.projectBuckets[0]).toEqual({
      projectKey: bucket.projectKey,
      projectName: bucket.projectName,
      projectDescription: bucket.projectDescription,
      outcomeMaterial: material(),
      previousProjectStatus: { value: "delivery", periodKey: "last-week" },
    });
    expect(input.currentCard).toEqual(currentCard);
    expect(input.reviewInstructions).toEqual([
      "将工作日期改为周三",
      "突出方案评估",
    ]);
    expect(input.reviewInstruction).toBe("突出方案评估");
    expect(JSON.stringify(input)).not.toContain("raw fact");
    expect(JSON.stringify(input)).not.toContain("后来改动的介绍");
  });
});
