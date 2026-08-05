import { describe, expect, it } from "vitest";
import {
  FEISHU_CARD_BODY_TEXT_LIMIT,
  FEISHU_CARD_MAX_JSON_BYTES,
  feishuActionValueSchema,
  isReportContentComplete,
  renderBindingCard,
  renderErrorCard,
  renderLockedCard,
  renderReportCard,
  renderReviewCard,
  renderStaleCard,
  reviewCardInputSchema,
  truncateCardText,
  type FeishuActionValue,
  type FeishuCard,
} from "./cards.js";

function callbackValues(card: FeishuCard): FeishuActionValue[] {
  const values: FeishuActionValue[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "callback" && record.value) {
      values.push(feishuActionValueSchema.parse(record.value));
    }
    if (record.action_type === "form_submit" && record.value) {
      values.push(feishuActionValueSchema.parse(record.value));
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return values;
}

function findByElementId(
  card: FeishuCard,
  elementId: string,
): Record<string, unknown> | undefined {
  let match: Record<string, unknown> | undefined;
  const visit = (value: unknown) => {
    if (match) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.element_id === elementId) {
      match = record;
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return match;
}

function reportContent(card: FeishuCard): string {
  const contents: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.element_id === "string" &&
      /^report_content_\d+$/.test(record.element_id)
    ) {
      const text = record.text as { content?: unknown } | undefined;
      if (typeof text?.content === "string") contents.push(text.content);
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  return contents.join("");
}

const ids = {
  deliveryId: "4ff57eed-2163-4fa9-bb50-d24c6712c3d8",
  aggregateId: "6cf41c5c-c276-4800-93f8-2e39f547e8b3",
  itemId: "d66b2c23-d8d1-41b4-9942-d075fde4d5df",
};

describe("Feishu JSON 2.0 cards", () => {
  it("renders a minimal identity binding callback", () => {
    const card = renderBindingCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 1,
      recipientName: "林勇",
      email: "saul@laien.io",
    });

    expect(card.schema).toBe("2.0");
    expect(card.config.update_multi).toBe(true);
    expect(callbackValues(card)).toEqual([
      {
        deliveryId: ids.deliveryId,
        action: "binding_confirm",
        aggregateId: ids.aggregateId,
        baseVersion: 1,
      },
    ]);
  });

  it("renders one current review item with decision and regeneration actions", () => {
    const card = renderReviewCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 7,
      periodLabel: "2026 年 8 月",
      progress: { current: 2, total: 4, approved: 1, excluded: 0 },
      item: {
        id: ids.itemId,
        title: "飞书审核接入",
        status: "进行中",
        overview: "已经完成卡片协议设计。",
        dailyProgress: [
          { date: "2026-08-05", summary: "实现交互卡片渲染器。" },
        ],
      },
      regeneration: { enabled: true },
    });

    expect(callbackValues(card)).toEqual([
      {
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        itemId: ids.itemId,
        baseVersion: 7,
        action: "review_exclude",
      },
      {
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        itemId: ids.itemId,
        baseVersion: 7,
        action: "review_approve",
      },
      {
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        itemId: ids.itemId,
        baseVersion: 7,
        action: "review_regenerate",
      },
    ]);
    expect(findByElementId(card, "review_regen_input")).toMatchObject({
      tag: "input",
      name: "instruction",
      required: true,
      max_length: 1_000,
    });
    expect(findByElementId(card, "review_regen_btn")).toMatchObject({
      tag: "button",
      action_type: "form_submit",
      name: "review_regen_submit",
      value: {
        action: "review_regenerate",
      },
    });
    expect(findByElementId(card, "review_regen_btn")).not.toHaveProperty(
      "behaviors",
    );
  });

  it("keeps report actions scoped to delivery and report aggregate", () => {
    const fullMarkdown = [
      "# 本期工作",
      "",
      "- 完成飞书审核链路",
      "- 补齐幂等与审计能力",
      "",
      "## 风险",
      "",
      "当前无阻塞项。",
    ].join("\n");
    const card = renderReportCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 3,
      title: "Saul 个人工作报告",
      summary: "本期推进了审核链路与审计能力。",
      markdown: fullMarkdown,
      regeneration: { enabled: true },
    });

    expect(isReportContentComplete(fullMarkdown)).toBe(true);
    expect(reportContent(card)).toBe(fullMarkdown);
    expect(callbackValues(card)).toEqual([
      {
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        baseVersion: 3,
        action: "report_submit",
      },
      {
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        baseVersion: 3,
        action: "report_regenerate",
      },
    ]);
    expect(findByElementId(card, "report_regen_input")).toMatchObject({
      name: "instruction",
      input_type: "multiline_text",
    });
    expect(findByElementId(card, "report_regen_btn")).toMatchObject({
      action_type: "form_submit",
      name: "report_regen_submit",
      value: {
        action: "report_regenerate",
      },
    });
  });

  it("does not allow locking a report when the full Markdown cannot fit", () => {
    const fullMarkdown = [
      "# 超长报告",
      "",
      ...Array.from(
        { length: 1_500 },
        (_, index) => `- 第 ${index + 1} 项：成果🚀、\"引用\"与 \\ 路径`,
      ),
    ].join("\n");
    const card = renderReportCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 4,
      title: "超长个人工作报告",
      summary: "此报告包含完整的项目明细。",
      markdown: fullMarkdown,
      detailsUrl: "https://partner-report.example.test/reports/long-report",
      regeneration: { enabled: true },
    });
    const actions = callbackValues(card).map((value) => value.action);

    expect(isReportContentComplete(fullMarkdown)).toBe(false);
    expect(actions).not.toContain("report_submit");
    expect(actions).toContain("report_regenerate");
    expect(reportContent(card)).toContain("内容已截断");
    expect(findByElementId(card, "report_truncated_notice")).toBeDefined();
    expect(findByElementId(card, "report_details")).toMatchObject({
      tag: "button",
      behaviors: [
        {
          type: "open_url",
          default_url:
            "https://partner-report.example.test/reports/long-report",
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThan(
      FEISHU_CARD_MAX_JSON_BYTES,
    );
  });

  it("does not render a regeneration form unless requested", () => {
    const card = renderReviewCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 1,
      progress: { current: 1, total: 1, approved: 0, excluded: 0 },
      item: {
        id: ids.itemId,
        title: "单项审核",
        status: "待审核",
        overview: "确认这一项。",
      },
    });

    expect(callbackValues(card).map((value) => value.action)).toEqual([
      "review_exclude",
      "review_approve",
    ]);
    expect(findByElementId(card, "review_regen_input")).toBeUndefined();
  });

  it("rejects extra identity fields in inputs and action payloads", () => {
    expect(() =>
      reviewCardInputSchema.parse({
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        baseVersion: 1,
        tenantId: "do-not-trust-client-identity",
        progress: { current: 1, total: 1, approved: 0, excluded: 0 },
        item: {
          id: ids.itemId,
          title: "审核",
          status: "待审核",
          overview: "内容",
        },
      }),
    ).toThrow();
    expect(() =>
      feishuActionValueSchema.parse({
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        itemId: ids.itemId,
        baseVersion: 1,
        action: "review_approve",
        partnerId: "must-not-be-in-card",
      }),
    ).toThrow();
  });

  it("clips long card text without splitting Unicode characters", () => {
    expect(truncateCardText("项目进展🚀继续推进", 8)).toBe("项目进展🚀...");

    const card = renderReviewCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 1,
      progress: { current: 1, total: 1, approved: 0, excluded: 0 },
      item: {
        id: ids.itemId,
        title: "超长内容",
        status: "进行中",
        overview: "甲".repeat(FEISHU_CARD_BODY_TEXT_LIMIT * 2),
      },
    });
    const item = findByElementId(card, "review_item");
    const content = (item?.text as { content: string }).content;

    expect(Array.from(content).length).toBeLessThanOrEqual(
      FEISHU_CARD_BODY_TEXT_LIMIT,
    );
    expect(content.endsWith("...")).toBe(true);
  });

  it("renders stale, error, and locked cards without callbacks", () => {
    const cards = [renderStaleCard(), renderErrorCard(), renderLockedCard()];

    expect(cards.map((card) => card.header.template)).toEqual([
      "grey",
      "red",
      "green",
    ]);
    expect(cards.flatMap(callbackValues)).toEqual([]);
  });
});
