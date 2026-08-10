import { describe, expect, it } from "vitest";
import {
  aggregationInstructions,
  formatReportDate,
  normalizeTeamReportSummary,
  reportInstructions,
} from "./generation.js";

describe("reader-facing generation instructions", () => {
  it("asks work cards to use short, plain Chinese", () => {
    const instructions = aggregationInstructions("test-model");

    expect(instructions).toContain("simplified Chinese");
    expect(instructions).toContain("plain, direct, concise language");
    expect(instructions).toContain("120 Chinese characters");
    expect(instructions).toContain("80 Chinese characters");
    expect(instructions).toContain("2026-08-10.project-card.v2");
  });

  it("asks individual reports to stay readable and avoid repetition", () => {
    const instructions = reportInstructions("test-model");

    expect(instructions).toContain("simplified Chinese");
    expect(instructions).toContain("colleague without technical context");
    expect(instructions).toContain("Do not repeat the same fact");
    expect(instructions).toContain('write only "无相关内容"');
    expect(instructions).toContain("2026-08-10.individual-review.v2");
  });
});

describe("Team Report numbering", () => {
  it("formats the report creation date in the team's timezone", () => {
    const createdAt = new Date("2026-08-09T16:30:00.000Z");

    expect(formatReportDate(createdAt, "Asia/Shanghai")).toBe("2026-08-10");
    expect(formatReportDate(createdAt, "America/Los_Angeles")).toBe(
      "2026-08-09",
    );
  });

  it("turns a model-generated list into one summary paragraph", () => {
    expect(
      normalizeTeamReportSummary(
        "- Partner Report：完成生成链路修复。\n2. 数据平台：完成验证。",
      ),
    ).toBe("Partner Report：完成生成链路修复。 数据平台：完成验证。");
  });
});
