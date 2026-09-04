import { describe, expect, it } from "vitest";
import {
  FEISHU_CARD_BODY_TEXT_LIMIT,
  FEISHU_CARD_MAX_JSON_BYTES,
  feishuActionValueSchema,
  renderBindingCard,
  renderErrorCard,
  renderLockedCard,
  renderProcessingCard,
  renderRecoveryCard,
  renderReviewCard,
  renderScopeCard,
  renderScopeStatusCard,
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

  it("renders a connection recovery callback without changing permissions", () => {
    const card = renderRecoveryCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 1,
      deviceName: "Saul MacBook",
      expiresAt: "2026-08-13T12:00:00.000Z",
    });

    expect(callbackValues(card)).toEqual([
      {
        deliveryId: ids.deliveryId,
        action: "recovery_confirm",
        aggregateId: ids.aggregateId,
        baseVersion: 1,
      },
    ]);
    expect(JSON.stringify(card)).toContain("原有项目采集权限");
  });

  it("renders project scope decisions as one versioned form submission", () => {
    const scopeKeys = ["a".repeat(64), "b".repeat(64)];
    const card = renderScopeCard({
      deliveryId: ids.deliveryId,
      aggregateId: `${ids.aggregateId}:2026-W32`,
      baseVersion: 4,
      deviceName: "Saul MacBook",
      periodLabel: "2026-W32",
      initial: false,
      projects: [
        {
          scopeKey: scopeKeys[0]!,
          displayName: "partner-report",
          sessionCount: 3,
        },
        {
          scopeKey: scopeKeys[1]!,
          displayName: "private-notes",
          sessionCount: 1,
        },
      ],
    });

    expect(callbackValues(card)).toEqual([
      expect.objectContaining({ action: "scope_submit", baseVersion: 4 }),
      expect.objectContaining({ action: "scope_deny_all", baseVersion: 4 }),
      expect.objectContaining({ action: "scope_allow_all", baseVersion: 4 }),
    ]);
    expect(findByElementId(card, "scope_select_0")).toMatchObject({
      tag: "select_static",
      name: "scope_decision_0",
      required: true,
      options: [{ value: "allow" }, { value: "deny" }],
    });
    expect(findByElementId(card, "scope_select_1")).toMatchObject({
      name: "scope_decision_1",
      required: true,
    });
    expect(findByElementId(card, "scope_submit_btn")).toMatchObject({
      action_type: "form_submit",
      name: "scope_submit",
      value: { action: "scope_submit", baseVersion: 4 },
    });
    expect(JSON.stringify(card)).toContain("提交前所有选择都不会生效");
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThan(
      FEISHU_CARD_MAX_JSON_BYTES,
    );
  });

  it("keeps oversized scope reviews on the same card in safe pages", () => {
    const card = renderScopeCard({
      deliveryId: ids.deliveryId,
      aggregateId: `${ids.aggregateId}:2026-W32`,
      baseVersion: 4,
      deviceName: "Saul MacBook",
      initial: true,
      projects: Array.from({ length: 21 }, (_, index) => ({
        scopeKey: index.toString(16).padStart(64, "0"),
        displayName: `project-${index + 1}`,
        sessionCount: index + 1,
      })),
    });

    expect(findByElementId(card, "scope_select_19")).toBeDefined();
    expect(findByElementId(card, "scope_select_20")).toBeUndefined();
    expect(JSON.stringify(card)).toContain("同一张卡片继续显示");
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThan(
      FEISHU_CARD_MAX_JSON_BYTES,
    );
  });

  it("prefills project scope decisions without applying them", () => {
    const card = renderScopeCard({
      deliveryId: ids.deliveryId,
      aggregateId: `${ids.aggregateId}:2026-W35`,
      baseVersion: 15,
      deviceName: "Swift MacBook",
      periodLabel: "2026-W35",
      initial: true,
      projects: [
        {
          scopeKey: "a".repeat(64),
          displayName: "allowed-project",
          sessionCount: 2,
          initialDecision: "allow",
        },
        {
          scopeKey: "b".repeat(64),
          displayName: "denied-project",
          sessionCount: 1,
          initialDecision: "deny",
        },
      ],
    });

    expect(findByElementId(card, "scope_select_0")).toMatchObject({
      initial_option: "allow",
    });
    expect(findByElementId(card, "scope_select_1")).toMatchObject({
      initial_option: "deny",
    });
  });

  it("renders a read-only project scope status without callbacks", () => {
    const card = renderScopeStatusCard({
      deviceName: "Saul MacBook",
      periodLabel: "2026-W32",
      summary: { allowed: 1, denied: 1 },
      projects: [
        {
          displayName: "partner-report",
          permission: "allowed",
          sessionCount: 3,
        },
        {
          displayName: "private-notes",
          permission: "denied",
          sessionCount: 1,
        },
      ],
    });

    expect(callbackValues(card)).toEqual([]);
    expect(card.header.title.content).toBe("项目采集权限状态");
    expect(JSON.stringify(card)).toContain("允许采集 1 个");
    expect(JSON.stringify(card)).toContain("当前没有待审批项目");
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThan(
      FEISHU_CARD_MAX_JSON_BYTES,
    );
  });

  it("renders one current review item with natural-language revision controls", () => {
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
    });

    expect(callbackValues(card)).toEqual([
      {
        deliveryId: ids.deliveryId,
        aggregateId: ids.aggregateId,
        itemId: ids.itemId,
        baseVersion: 7,
        action: "review_regenerate",
      },
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
    ]);
    expect(JSON.stringify(card)).toContain("本周进展总览");
    expect(JSON.stringify(card)).not.toContain("项目描述");
    expect(JSON.stringify(card)).not.toContain("状态：进行中");
    expect(findByElementId(card, "review_regen_input")).toMatchObject({
      tag: "input",
      name: "review_regeneration_instruction",
      required: true,
      max_length: 1000,
      input_type: "multiline_text",
    });
    expect(JSON.stringify(card)).toContain("已通过 1");
    expect(JSON.stringify(card)).toContain("按修改意见重新生成");
  });

  it("rejects removed report actions", () => {
    for (const action of ["report_submit", "report_regenerate"]) {
      expect(
        feishuActionValueSchema.safeParse({
          deliveryId: ids.deliveryId,
          aggregateId: ids.aggregateId,
          itemId: ids.itemId,
          baseVersion: 1,
          action,
        }).success,
      ).toBe(false);
    }
  });

  it("always keeps regenerate, ignore and approve available while pending", () => {
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
      "review_regenerate",
      "review_exclude",
      "review_approve",
    ]);
    expect(findByElementId(card, "review_regen_input")).toBeDefined();
  });

  it("keeps review actions available after a regeneration failure", () => {
    const card = renderReviewCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 2,
      progress: { current: 1, total: 1, approved: 0, excluded: 0 },
      regenerationError: "模型服务暂时不可用。",
      item: {
        id: ids.itemId,
        title: "单项审核",
        status: "待审核",
        overview: "保留上一次可审核内容。",
      },
    });

    expect(JSON.stringify(card)).toContain("上次重新生成未完成");
    expect(card.header.title.content).toBe("处理失败，请重试");
    expect(callbackValues(card).map((value) => value.action)).toEqual([
      "review_regenerate",
      "review_exclude",
      "review_approve",
    ]);
  });

  it("keeps review actions available after an action failure", () => {
    const card = renderReviewCard({
      deliveryId: ids.deliveryId,
      aggregateId: ids.aggregateId,
      baseVersion: 1,
      progress: { current: 1, total: 1, approved: 0, excluded: 0 },
      actionError: "中台暂时未能完成该操作。",
      item: {
        id: ids.itemId,
        title: "单项审核",
        status: "待审核",
        overview: "保留当前可审核内容。",
      },
    });

    expect(card.header.title.content).toBe("处理失败，请重试");
    expect(callbackValues(card).map((value) => value.action)).toEqual([
      "review_regenerate",
      "review_exclude",
      "review_approve",
    ]);
  });

  it("renders processing cards without interactive actions", () => {
    const card = renderProcessingCard({ title: "审核处理中" });

    expect(card.header.title.content).toBe("审核处理中");
    expect(callbackValues(card)).toEqual([]);
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
