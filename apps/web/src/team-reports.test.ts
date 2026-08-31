import { describe, expect, it } from "vitest";
import {
  reportClipboardText,
  withoutLegacyWeeklySummary,
} from "./team-reports.js";

describe("Team Report clipboard text", () => {
  it("copies the viewed title, summary and Markdown as one document", () => {
    expect(
      reportClipboardText({
        id: "version-1",
        version: 1,
        title: "团队周报 2026-08-24",
        summary: "本周完成主要交付。",
        markdown: "## 工作摘要\n\n- 完成功能验证",
        payload: {},
        created_at: "2026-08-24T08:00:00.000Z",
      }),
    ).toBe(
      "# 团队周报 2026-08-24\n\n本周完成主要交付。\n\n## 工作摘要\n\n- 完成功能验证",
    );
  });

  it("removes the retired weekly summary from old reports and copied text", () => {
    const markdown =
      "## 本周团队工作摘要\n\n| 项目 | 本周进展 | 参与成员 |\n| --- | --- | --- |\n| 旧项目 | 旧摘要 | 林勇 |\n\n## 项目与人员工作明细\n\n| 成员 | 项目 | 本周工作明细 |\n| --- | --- | --- |\n| 林勇 | 项目甲 | 完成验证。 |";

    expect(withoutLegacyWeeklySummary(markdown)).toBe(
      "## 项目与人员工作明细\n\n| 成员 | 项目 | 本周工作明细 |\n| --- | --- | --- |\n| 林勇 | 项目甲 | 完成验证。 |",
    );
    expect(
      reportClipboardText({
        id: "version-1",
        version: 1,
        title: "团队周报 2026-08-24",
        summary: "管理概览。",
        markdown,
        payload: {},
        created_at: "2026-08-24T08:00:00.000Z",
      }),
    ).not.toContain("本周团队工作摘要");
  });
});
