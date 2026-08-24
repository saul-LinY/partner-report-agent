import { describe, expect, it } from "vitest";
import { reportClipboardText } from "./team-reports.js";

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
});
