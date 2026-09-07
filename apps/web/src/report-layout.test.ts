import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkReportLayout } from "./report-layout.js";

describe("report owner identity", () => {
  it("does not merge different people sharing the same display name", () => {
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        remarkPlugins: [
          remarkGfm,
          [
            remarkReportLayout,
            {
              projectProgress: [
                { partnerId: "a", partnerName: "同名", projectName: "甲" },
                { partnerId: "b", partnerName: "同名", projectName: "乙" },
              ],
            },
          ],
        ],
        children:
          "| 项目负责人 | 项目名称 | 较上周进展 |\n| --- | --- | --- |\n| 同名 | 甲 | 完成。 |\n| 同名 | 乙 | 完成。 |",
      }),
    );
    expect(html).not.toContain("rowSpan");
    expect(html).not.toContain("hidden");
  });
});
