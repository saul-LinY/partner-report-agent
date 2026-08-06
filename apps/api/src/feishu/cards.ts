import { z } from "zod";

const opaqueIdSchema = z.string().trim().min(1).max(128);
const baseVersionSchema = z.number().int().positive();
const displayTextSchema = z.string().max(60_000);

export const FEISHU_CARD_BODY_TEXT_LIMIT = 3_200;
export const FEISHU_CARD_SUMMARY_LIMIT = 1_600;
export const FEISHU_CARD_MAX_JSON_BYTES = 30_000;

// Leave room for headers, summaries, action payloads, and JSON escaping inside
// Feishu's 30 KB card limit. This limit is measured on the serialized string.
const FEISHU_REPORT_MARKDOWN_SAFE_JSON_BYTES = 15_000;
const FEISHU_REPORT_MARKDOWN_CHUNK_JSON_BYTES = 4_000;

const actionBase = {
  deliveryId: opaqueIdSchema,
  aggregateId: opaqueIdSchema,
  baseVersion: baseVersionSchema,
};

const bindingActionValueSchema = z
  .object({
    ...actionBase,
    action: z.literal("binding_confirm"),
  })
  .strict();

const recoveryActionValueSchema = z
  .object({
    ...actionBase,
    action: z.literal("recovery_confirm"),
  })
  .strict();

const reviewActionValueSchema = z
  .object({
    ...actionBase,
    action: z.enum(["review_approve", "review_exclude", "review_regenerate"]),
    itemId: opaqueIdSchema,
  })
  .strict();

const reportActionValueSchema = z
  .object({
    ...actionBase,
    action: z.enum(["report_submit", "report_regenerate"]),
  })
  .strict();

const scopeItemActionValueSchema = z
  .object({
    ...actionBase,
    action: z.enum(["scope_allow", "scope_deny"]),
    scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const scopeAllActionValueSchema = z
  .object({
    ...actionBase,
    action: z.enum(["scope_allow_all", "scope_deny_all"]),
  })
  .strict();

export const feishuActionValueSchema = z.discriminatedUnion("action", [
  bindingActionValueSchema,
  recoveryActionValueSchema,
  reviewActionValueSchema,
  reportActionValueSchema,
  scopeItemActionValueSchema,
  scopeAllActionValueSchema,
]);

const regenerationSchema = z
  .object({
    enabled: z.boolean().default(true),
    pending: z.boolean().default(false),
    errorMessage: displayTextSchema.optional(),
  })
  .strict();

export const bindingCardInputSchema = z
  .object({
    deliveryId: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    baseVersion: baseVersionSchema,
    recipientName: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(320),
  })
  .strict();

export const recoveryCardInputSchema = z
  .object({
    deliveryId: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    baseVersion: baseVersionSchema,
    deviceName: z.string().trim().min(1).max(120),
    expiresAt: z.string().datetime(),
  })
  .strict();

const dailyProgressSchema = z
  .object({
    date: z.string().trim().min(1).max(40),
    summary: displayTextSchema,
  })
  .strict();

const reviewProgressSchema = z
  .object({
    current: z.number().int().positive(),
    total: z.number().int().positive(),
    approved: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.current > progress.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["current"],
        message: "current must not exceed total",
      });
    }
    if (progress.approved + progress.excluded > progress.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved"],
        message: "reviewed count must not exceed total",
      });
    }
  });

export const reviewCardInputSchema = z
  .object({
    deliveryId: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    baseVersion: baseVersionSchema,
    periodLabel: z.string().trim().min(1).max(120).optional(),
    progress: reviewProgressSchema,
    item: z
      .object({
        id: opaqueIdSchema,
        title: z.string().trim().min(1).max(2_000),
        status: z.string().trim().min(1).max(120),
        overview: displayTextSchema,
        dailyProgress: z.array(dailyProgressSchema).max(366).default([]),
      })
      .strict(),
    regeneration: regenerationSchema.optional(),
  })
  .strict();

export const reportCardInputSchema = z
  .object({
    deliveryId: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    baseVersion: baseVersionSchema,
    title: z.string().trim().min(1).max(2_000),
    summary: displayTextSchema,
    markdown: z.string().trim().min(1).max(60_000),
    detailsUrl: z
      .string()
      .trim()
      .url()
      .max(2_048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "detailsUrl must use http or https",
      })
      .optional(),
    periodLabel: z.string().trim().min(1).max(120).optional(),
    regeneration: regenerationSchema.optional(),
  })
  .strict();

export const statusCardInputSchema = z
  .object({
    kind: z.enum(["stale", "error", "locked"]),
    title: z.string().trim().min(1).max(200).optional(),
    message: displayTextSchema.optional(),
  })
  .strict();

export const scopeCardInputSchema = z
  .object({
    deliveryId: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    baseVersion: baseVersionSchema,
    deviceName: z.string().trim().min(1).max(120),
    periodLabel: z.string().trim().min(1).max(120).optional(),
    initial: z.boolean(),
    projects: z
      .array(
        z
          .object({
            scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
            displayName: z.string().trim().min(1).max(120),
            sessionCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type FeishuActionValue = z.infer<typeof feishuActionValueSchema>;
export type BindingCardInput = z.input<typeof bindingCardInputSchema>;
export type RecoveryCardInput = z.input<typeof recoveryCardInputSchema>;
export type ReviewCardInput = z.input<typeof reviewCardInputSchema>;
export type ReportCardInput = z.input<typeof reportCardInputSchema>;
export type StatusCardInput = z.input<typeof statusCardInputSchema>;
export type ScopeCardInput = z.input<typeof scopeCardInputSchema>;

type HeaderTemplate = "blue" | "green" | "red" | "grey";

export type FeishuCardElement = {
  tag: string;
  [key: string]: unknown;
};

export type FeishuCard = {
  schema: "2.0";
  config: {
    update_multi: true;
    summary: { content: string };
  };
  header: {
    template: HeaderTemplate;
    title: { tag: "plain_text"; content: string };
    subtitle?: { tag: "plain_text"; content: string };
  };
  body: {
    padding: "12px";
    vertical_spacing: "8px";
    elements: FeishuCardElement[];
  };
};

export function truncateCardText(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 4) {
    throw new RangeError("maxLength must be an integer of at least 4");
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  return `${characters
    .slice(0, maxLength - 3)
    .join("")
    .trimEnd()}...`;
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function jsonStringContentByteLength(value: string): number {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized.slice(1, -1), "utf8");
}

export function isReportContentComplete(markdown: string): boolean {
  const normalized = normalizeMarkdown(markdown);
  return (
    normalized.length > 0 &&
    jsonStringContentByteLength(normalized) <=
      FEISHU_REPORT_MARKDOWN_SAFE_JSON_BYTES
  );
}

function splitRawTextByJsonBytes(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const character of value) {
    const characterBytes = jsonStringContentByteLength(character);
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitReportMarkdown(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  // Keeping newlines with each segment avoids breaking Markdown blocks unless a
  // single source line is itself larger than the per-element budget.
  for (const line of value.split(/(?<=\n)/)) {
    const lineBytes = jsonStringContentByteLength(line);
    if (lineBytes > FEISHU_REPORT_MARKDOWN_CHUNK_JSON_BYTES) {
      if (current) chunks.push(current);
      chunks.push(
        ...splitRawTextByJsonBytes(
          line,
          FEISHU_REPORT_MARKDOWN_CHUNK_JSON_BYTES,
        ),
      );
      current = "";
      currentBytes = 0;
      continue;
    }
    if (
      current &&
      currentBytes + lineBytes > FEISHU_REPORT_MARKDOWN_CHUNK_JSON_BYTES
    ) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += line;
    currentBytes += lineBytes;
  }

  if (current) chunks.push(current);
  return chunks;
}

function truncateMarkdownByJsonBytes(value: string, maxBytes: number): string {
  let result = "";
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = jsonStringContentByteLength(character);
    if (resultBytes + characterBytes > maxBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return result.trimEnd();
}

function escapeLarkMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_\[\]~])/g, "\\$1");
}

function safeMarkdownText(value: string, maxLength: number): string {
  return truncateCardText(escapeLarkMarkdown(value), maxLength);
}

function plainText(content: string) {
  return { tag: "plain_text" as const, content };
}

function markdown(content: string, elementId?: string): FeishuCardElement {
  return {
    tag: "div",
    ...(elementId ? { element_id: elementId } : {}),
    text: { tag: "lark_md", content },
  };
}

function notation(content: string, elementId?: string): FeishuCardElement {
  return {
    tag: "div",
    ...(elementId ? { element_id: elementId } : {}),
    text: {
      tag: "plain_text",
      content: truncateCardText(content, FEISHU_CARD_SUMMARY_LIMIT),
      text_size: "notation",
      text_color: "grey",
    },
  };
}

function callbackBehavior(value: FeishuActionValue) {
  return [{ type: "callback" as const, value }];
}

function callbackButton(input: {
  elementId: string;
  label: string;
  type: "primary" | "default" | "danger";
  value: FeishuActionValue;
  disabled?: boolean;
  disabledTips?: string;
  confirm?: { title: string; text: string };
}): FeishuCardElement {
  return {
    tag: "button",
    element_id: input.elementId,
    text: plainText(input.label),
    type: input.type,
    width: "fill",
    behaviors: callbackBehavior(feishuActionValueSchema.parse(input.value)),
    ...(input.disabled === true ? { disabled: true } : {}),
    ...(input.disabledTips
      ? { disabled_tips: plainText(input.disabledTips) }
      : {}),
    ...(input.confirm
      ? {
          confirm: {
            title: plainText(input.confirm.title),
            text: plainText(input.confirm.text),
          },
        }
      : {}),
  };
}

function buttonRow(buttons: FeishuCardElement[]): FeishuCardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    horizontal_spacing: "default",
    margin: "0px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [button],
    })),
  };
}

function regenerationForm(input: {
  prefix: "review" | "report";
  value: FeishuActionValue;
}): FeishuCardElement {
  const prefix = input.prefix === "review" ? "review" : "report";
  const submit: FeishuCardElement = {
    tag: "button",
    element_id: `${prefix}_regen_btn`,
    text: plainText("按意见重新生成"),
    type: "default",
    width: "fill",
    action_type: "form_submit",
    name: `${prefix}_regen_submit`,
    value: feishuActionValueSchema.parse(input.value),
    confirm: {
      title: plainText("确认重新生成"),
      text: plainText(
        "将根据填写的意见生成新版本，当前内容会保留在历史版本中。",
      ),
    },
  };
  return {
    tag: "form",
    name: `${prefix}_regen_form`,
    elements: [
      {
        tag: "input",
        element_id: `${prefix}_regen_input`,
        name: "instruction",
        required: true,
        input_type: "multiline_text",
        rows: 3,
        auto_resize: true,
        max_rows: 6,
        max_length: 1_000,
        width: "fill",
        label: plainText("修改意见"),
        label_position: "top",
        placeholder: plainText("请说明需要补充、更正或调整的内容"),
      },
      buttonRow([submit]),
    ],
  };
}

function createCard(input: {
  title: string;
  subtitle?: string;
  summary: string;
  template: HeaderTemplate;
  elements: FeishuCardElement[];
}): FeishuCard {
  const title = truncateCardText(input.title, 100);
  const summary = truncateCardText(input.summary, 200);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summary },
    },
    header: {
      template: input.template,
      title: plainText(title),
      ...(input.subtitle
        ? { subtitle: plainText(truncateCardText(input.subtitle, 100)) }
        : {}),
    },
    body: {
      padding: "12px",
      vertical_spacing: "8px",
      elements: input.elements,
    },
  };
}

export function renderBindingCard(rawInput: BindingCardInput): FeishuCard {
  const input = bindingCardInputSchema.parse(rawInput);
  const recipient = input.recipientName
    ? `${safeMarkdownText(input.recipientName, 80)}（${safeMarkdownText(input.email, 320)}）`
    : safeMarkdownText(input.email, 320);
  const value = feishuActionValueSchema.parse({
    deliveryId: input.deliveryId,
    action: "binding_confirm",
    aggregateId: input.aggregateId,
    baseVersion: input.baseVersion,
  });
  return createCard({
    title: "确认 Partner Report 审核身份",
    subtitle: "仅需确认一次",
    summary: "请确认 Partner Report 审核身份",
    template: "blue",
    elements: [
      markdown(
        `Partner Report 将把项目卡片和个人报告私发给：\n\n**${recipient}**\n\n确认后，此飞书账号将用于接收和处理对应审核。插件会先上传项目显示名、匿名项目标识、首次发现时间和 Session 数量，用于生成采集范围授权卡；在你允许前不会读取或上传 Session 内容。`,
        "binding_details",
      ),
      callbackButton({
        elementId: "binding_confirm",
        label: "确认是我",
        type: "primary",
        value,
        confirm: {
          title: "确认审核身份",
          text: `确认将此飞书账号绑定到 ${input.email}？`,
        },
      }),
      notation("如账号或邮箱不符，请不要确认并联系管理员。"),
    ],
  });
}

export function renderRecoveryCard(rawInput: RecoveryCardInput): FeishuCard {
  const input = recoveryCardInputSchema.parse(rawInput);
  const value = feishuActionValueSchema.parse({
    deliveryId: input.deliveryId,
    action: "recovery_confirm",
    aggregateId: input.aggregateId,
    baseVersion: input.baseVersion,
  });
  return createCard({
    title: "确认恢复 Partner Report 连接",
    subtitle: input.deviceName,
    summary: "请确认恢复 Partner Report 插件连接",
    template: "blue",
    elements: [
      markdown(
        `设备 **${safeMarkdownText(input.deviceName, 120)}** 的连接凭据已失效。确认后只会轮换此设备的连接凭据，原有项目采集权限、飞书身份和采集记录都会保留。`,
        "recovery_description",
      ),
      notation(
        `申请有效期至 ${safeMarkdownText(input.expiresAt, 80)}。未确认前插件不会读取或上传 Session 内容。`,
        "recovery_expiry",
      ),
      buttonRow([
        callbackButton({
          elementId: "recovery_confirm",
          label: "确认恢复连接",
          type: "primary",
          value,
          confirm: {
            title: "确认恢复连接",
            text: "确认后，插件会在下次运行时自动领取新凭据并继续采集。",
          },
        }),
      ]),
    ],
  });
}

export function renderScopeCard(rawInput: ScopeCardInput): FeishuCard {
  const input = scopeCardInputSchema.parse(rawInput);
  const baseValue = {
    deliveryId: input.deliveryId,
    aggregateId: input.aggregateId,
    baseVersion: input.baseVersion,
  };
  const individuallyReviewable = input.projects.slice(0, 12);
  const projectSummary = input.projects
    .map(
      (project) =>
        `- **${safeMarkdownText(project.displayName, 100)}**（${project.sessionCount} 个 Session）`,
    )
    .join("\n");
  const elements: FeishuCardElement[] = [
    markdown(
      truncateCardText(
        `${input.initial ? "请选择允许 Partner Report 审核的项目。" : "以下项目是本周期新发现的项目，请确认后续采集范围。"}\n\n${projectSummary}`,
        FEISHU_CARD_BODY_TEXT_LIMIT,
      ),
      "scope_projects",
    ),
    notation(
      input.initial
        ? "首次授权立即生效；未选择的项目保持待审批且不会读取 Session 内容。"
        : "本卡片中的新增项目授权从下个周期生效；未处理项目会保持待审批。",
      "scope_effective_time",
    ),
  ];

  for (const project of individuallyReviewable) {
    elements.push(
      markdown(
        `**${safeMarkdownText(project.displayName, 100)}**`,
        `scope_${project.scopeKey.slice(0, 12)}`,
      ),
      buttonRow([
        callbackButton({
          elementId: `scope_deny_${project.scopeKey.slice(0, 12)}`,
          label: "不采集",
          type: "danger",
          value: {
            ...baseValue,
            action: "scope_deny",
            scopeKey: project.scopeKey,
          },
        }),
        callbackButton({
          elementId: `scope_allow_${project.scopeKey.slice(0, 12)}`,
          label: "允许采集",
          type: "primary",
          value: {
            ...baseValue,
            action: "scope_allow",
            scopeKey: project.scopeKey,
          },
        }),
      ]),
    );
  }
  if (input.projects.length > individuallyReviewable.length) {
    elements.push(
      notation(
        `另有 ${input.projects.length - individuallyReviewable.length} 个项目未展开，可使用下方批量操作。`,
      ),
    );
  }
  elements.push(
    buttonRow([
      callbackButton({
        elementId: "scope_deny_all",
        label: "全部不采集",
        type: "danger",
        value: { ...baseValue, action: "scope_deny_all" },
        confirm: {
          title: "确认全部不采集",
          text: "当前卡片中的全部待审批项目都不会被采集。",
        },
      }),
      callbackButton({
        elementId: "scope_allow_all",
        label: "全部允许",
        type: "primary",
        value: { ...baseValue, action: "scope_allow_all" },
        confirm: {
          title: "确认全部允许",
          text: input.initial
            ? "当前卡片中的全部项目将立即允许采集。"
            : "当前卡片中的全部项目将从下个周期允许采集。",
        },
      }),
    ]),
  );

  return createCard({
    title: input.initial ? "确认项目采集范围" : "审批本周期新增项目",
    subtitle: input.periodLabel ?? input.deviceName,
    summary: `有 ${input.projects.length} 个项目等待采集授权`,
    template: "blue",
    elements,
  });
}

export function renderReviewCard(rawInput: ReviewCardInput): FeishuCard {
  const input = reviewCardInputSchema.parse(rawInput);
  const pending = Math.max(
    0,
    input.progress.total - input.progress.approved - input.progress.excluded,
  );
  const progressText = [
    `第 ${input.progress.current} / ${input.progress.total} 项`,
    `已接受 ${input.progress.approved}`,
    `已忽略 ${input.progress.excluded}`,
    `待审核 ${pending}`,
  ].join(" · ");
  const dailyProgress = input.item.dailyProgress
    .slice(0, 5)
    .map(
      (entry) =>
        `- ${safeMarkdownText(entry.date, 40)}：${safeMarkdownText(
          entry.summary,
          360,
        )}`,
    );
  if (input.item.dailyProgress.length > dailyProgress.length) {
    dailyProgress.push(
      `- 另有 ${input.item.dailyProgress.length - dailyProgress.length} 条进展未在卡片中展开`,
    );
  }
  const itemBody = [
    `**${safeMarkdownText(input.item.title, 160)}**`,
    `状态：${safeMarkdownText(input.item.status, 80)}`,
    "",
    safeMarkdownText(input.item.overview, 1_200),
    ...(dailyProgress.length > 0 ? ["", "**每日进展**", ...dailyProgress] : []),
  ].join("\n");
  const baseValue = {
    deliveryId: input.deliveryId,
    aggregateId: input.aggregateId,
    itemId: input.item.id,
    baseVersion: input.baseVersion,
  };
  const regenerationPending = input.regeneration?.pending === true;
  const elements: FeishuCardElement[] = [
    notation(progressText, "review_progress"),
    markdown(
      truncateCardText(itemBody, FEISHU_CARD_BODY_TEXT_LIMIT),
      "review_item",
    ),
  ];

  if (input.regeneration?.errorMessage) {
    elements.push(
      markdown(
        `**上次重新生成失败**\n${safeMarkdownText(
          input.regeneration.errorMessage,
          600,
        )}`,
        "review_regen_error",
      ),
    );
  }
  if (regenerationPending) {
    elements.push(notation("正在根据修改意见重新生成，请稍候。"));
  }

  elements.push(
    buttonRow([
      callbackButton({
        elementId: "review_exclude",
        label: "忽略",
        type: "danger",
        value: {
          ...baseValue,
          action: "review_exclude",
        },
        disabled: regenerationPending,
        ...(regenerationPending
          ? { disabledTips: "重新生成完成后可继续审核" }
          : {}),
        confirm: {
          title: "确认忽略",
          text: "该项目不会进入本期个人报告。",
        },
      }),
      callbackButton({
        elementId: "review_approve",
        label: "接受",
        type: "primary",
        value: {
          ...baseValue,
          action: "review_approve",
        },
        disabled: regenerationPending,
        ...(regenerationPending
          ? { disabledTips: "重新生成完成后可继续审核" }
          : {}),
      }),
    ]),
  );

  if (input.regeneration?.enabled === true && !regenerationPending) {
    elements.push(
      regenerationForm({
        prefix: "review",
        value: {
          ...baseValue,
          action: "review_regenerate",
        },
      }),
    );
  }

  return createCard({
    title: "项目工作卡片审核",
    subtitle: input.periodLabel ?? progressText,
    summary: `待审核：${input.item.title}`,
    template: "blue",
    elements,
  });
}

export function renderReportCard(rawInput: ReportCardInput): FeishuCard {
  const input = reportCardInputSchema.parse(rawInput);
  const regenerationPending = input.regeneration?.pending === true;
  const normalizedMarkdown = normalizeMarkdown(input.markdown);
  const contentComplete = isReportContentComplete(normalizedMarkdown);
  const truncationMarker =
    "\n\n> **内容已截断**：报告超过飞书卡片 30KB 安全预算，请查看完整报告后再决定是否提交。";
  const displayedMarkdown = contentComplete
    ? normalizedMarkdown
    : `${truncateMarkdownByJsonBytes(
        normalizedMarkdown,
        FEISHU_REPORT_MARKDOWN_SAFE_JSON_BYTES -
          jsonStringContentByteLength(truncationMarker),
      )}${truncationMarker}`;
  const baseValue = {
    deliveryId: input.deliveryId,
    aggregateId: input.aggregateId,
    baseVersion: input.baseVersion,
  };
  const elements: FeishuCardElement[] = [
    notation(
      [input.periodLabel, `版本 v${input.baseVersion}`]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      "report_meta",
    ),
    markdown(
      `**报告摘要**\n${safeMarkdownText(input.summary, 600)}`,
      "report_summary",
    ),
    markdown("**报告全文**", "report_content_heading"),
    ...splitReportMarkdown(displayedMarkdown).map((content, index) =>
      markdown(content, `report_content_${index + 1}`),
    ),
  ];

  if (!contentComplete) {
    elements.push(
      notation(
        "当前卡片仅包含报告节选，不能在此确认锁定。请先查看完整内容。",
        "report_truncated_notice",
      ),
    );
    if (input.detailsUrl) {
      elements.push({
        tag: "button",
        element_id: "report_details",
        text: plainText("查看完整报告"),
        type: "default",
        width: "fill",
        behaviors: [
          {
            type: "open_url",
            default_url: input.detailsUrl,
          },
        ],
      });
    }
  }

  if (input.regeneration?.errorMessage) {
    elements.push(
      markdown(
        `**上次重新生成失败**\n${safeMarkdownText(
          input.regeneration.errorMessage,
          600,
        )}`,
        "report_regen_error",
      ),
    );
  }
  if (regenerationPending) {
    elements.push(notation("正在根据修改意见重新生成报告，请稍候。"));
  }

  if (contentComplete) {
    elements.push(
      callbackButton({
        elementId: "report_submit",
        label: "确认并锁定报告",
        type: "primary",
        value: {
          ...baseValue,
          action: "report_submit",
        },
        disabled: regenerationPending,
        ...(regenerationPending
          ? { disabledTips: "重新生成完成后可提交" }
          : {}),
        confirm: {
          title: "确认提交报告",
          text: "提交后报告将锁定，不能再重新生成。",
        },
      }),
    );
  }

  if (input.regeneration?.enabled === true && !regenerationPending) {
    elements.push(
      regenerationForm({
        prefix: "report",
        value: {
          ...baseValue,
          action: "report_regenerate",
        },
      }),
    );
  }

  const card = createCard({
    title: truncateCardText(input.title, 100),
    subtitle: "个人报告审核",
    summary: `个人报告待审核：${input.title}`,
    template: "blue",
    elements,
  });
  if (
    Buffer.byteLength(JSON.stringify(card), "utf8") >=
    FEISHU_CARD_MAX_JSON_BYTES
  ) {
    throw new RangeError("Rendered Feishu report card exceeds the 30 KB limit");
  }
  return card;
}

const statusDefaults = {
  stale: {
    title: "卡片内容已更新",
    message: "这张审核卡片已过期。最新状态已同步，请在更新后的卡片中继续操作。",
    template: "grey" as const,
  },
  error: {
    title: "操作未完成",
    message: "处理审核操作时发生错误，请稍后重试或联系管理员。",
    template: "red" as const,
  },
  locked: {
    title: "报告已确认并锁定",
    message: "本期个人报告已经提交，当前卡片不再接受修改。",
    template: "green" as const,
  },
};

export function renderStatusCard(rawInput: StatusCardInput): FeishuCard {
  const input = statusCardInputSchema.parse(rawInput);
  const defaults = statusDefaults[input.kind];
  const title = input.title ?? defaults.title;
  const message = input.message ?? defaults.message;
  return createCard({
    title,
    summary: title,
    template: defaults.template,
    elements: [
      markdown(
        safeMarkdownText(message, FEISHU_CARD_SUMMARY_LIMIT),
        `status_${input.kind}`,
      ),
    ],
  });
}

type StatusDetailsInput = Omit<StatusCardInput, "kind">;

export function renderStaleCard(input: StatusDetailsInput = {}): FeishuCard {
  return renderStatusCard({ ...input, kind: "stale" });
}

export function renderErrorCard(input: StatusDetailsInput = {}): FeishuCard {
  return renderStatusCard({ ...input, kind: "error" });
}

export function renderLockedCard(input: StatusDetailsInput = {}): FeishuCard {
  return renderStatusCard({ ...input, kind: "locked" });
}
