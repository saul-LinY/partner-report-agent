import { z } from "zod";

const opaqueIdSchema = z.string().trim().min(1).max(128);
const baseVersionSchema = z.number().int().positive();
const displayTextSchema = z.string().max(60_000);

export const FEISHU_CARD_BODY_TEXT_LIMIT = 3_200;
export const FEISHU_CARD_SUMMARY_LIMIT = 1_600;
export const FEISHU_CARD_MAX_JSON_BYTES = 30_000;

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
    action: z.enum(["review_approve", "review_exclude"]),
    itemId: opaqueIdSchema,
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

const scopeSubmitActionValueSchema = z
  .object({
    ...actionBase,
    action: z.literal("scope_submit"),
  })
  .strict();

export const feishuActionValueSchema = z.discriminatedUnion("action", [
  bindingActionValueSchema,
  recoveryActionValueSchema,
  reviewActionValueSchema,
  scopeItemActionValueSchema,
  scopeAllActionValueSchema,
  scopeSubmitActionValueSchema,
]);

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
        projectDescription: displayTextSchema.default(""),
        status: z.string().trim().min(1).max(120),
        overview: displayTextSchema,
        dailyProgress: z.array(dailyProgressSchema).max(366).default([]),
      })
      .strict(),
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

export const scopeStatusCardInputSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(120),
    periodLabel: z.string().trim().min(1).max(120).optional(),
    summary: z
      .object({
        allowed: z.number().int().nonnegative(),
        denied: z.number().int().nonnegative(),
      })
      .strict(),
    projects: z
      .array(
        z
          .object({
            displayName: z.string().trim().min(1).max(120),
            permission: z.enum(["allowed", "denied"]),
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
export type StatusCardInput = z.input<typeof statusCardInputSchema>;
export type ScopeCardInput = z.input<typeof scopeCardInputSchema>;
export type ScopeStatusCardInput = z.input<typeof scopeStatusCardInputSchema>;

export const SCOPE_FORM_PROJECT_LIMIT = 12;
export const SCOPE_FORM_FIELD_PREFIX = "scope_decision_";

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

function scopeDecisionForm(input: {
  projects: ScopeCardInput["projects"];
  value: FeishuActionValue;
}): FeishuCardElement {
  const submit: FeishuCardElement = {
    tag: "button",
    element_id: "scope_submit_btn",
    text: plainText("提交审核"),
    type: "primary",
    width: "fill",
    action_type: "form_submit",
    name: "scope_submit",
    value: feishuActionValueSchema.parse(input.value),
    confirm: {
      title: plainText("确认提交项目权限"),
      text: plainText("提交后，本页所有项目的采集权限将一次性生效。"),
    },
  };
  return {
    tag: "form",
    name: "scope_decision_form",
    elements: [
      ...input.projects.flatMap((project, index) => [
        markdown(
          `**${safeMarkdownText(project.displayName, 100)}**（${project.sessionCount} 个 Session）`,
          `scope_project_${index}`,
        ),
        {
          tag: "select_static",
          element_id: `scope_select_${index}`,
          name: `${SCOPE_FORM_FIELD_PREFIX}${index}`,
          required: true,
          width: "fill",
          placeholder: plainText("选择采集权限"),
          options: [
            { text: plainText("允许采集"), value: "allow" },
            { text: plainText("不采集"), value: "deny" },
          ],
        },
      ]),
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
        `Partner Report 将把项目权限和工作卡片私发给：\n\n**${recipient}**\n\n确认后，此飞书账号将用于接收和处理对应审核。插件会先上传项目显示名、匿名项目标识、首次发现时间和 Session 数量，用于生成采集范围授权卡；在你允许前不会读取或上传 Session 内容。`,
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
  const individuallyReviewable = input.projects.slice(
    0,
    SCOPE_FORM_PROJECT_LIMIT,
  );
  const elements: FeishuCardElement[] = [
    markdown(
      input.initial
        ? "请为每个项目选择采集权限，最后统一提交。"
        : "请确认本周期新发现项目的采集权限，最后统一提交。",
      "scope_projects",
    ),
    notation(
      input.initial
        ? "提交前所有选择都不会生效；待审批项目不会读取 Session 内容。"
        : "提交前所有选择都不会生效；允许后会补采本周期内容。",
      "scope_effective_time",
    ),
    scopeDecisionForm({
      projects: individuallyReviewable,
      value: { ...baseValue, action: "scope_submit" },
    }),
  ];
  if (input.projects.length > individuallyReviewable.length) {
    elements.push(
      notation(
        `另有 ${input.projects.length - individuallyReviewable.length} 个项目；提交本页后会在同一张卡片继续显示，无需返回 Codex。`,
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
            : "当前卡片中的全部项目将立即允许采集，并补采本周期内容。",
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

export function renderScopeStatusCard(
  rawInput: ScopeStatusCardInput,
): FeishuCard {
  const input = scopeStatusCardInputSchema.parse(rawInput);
  const allowed = input.projects.filter(
    (project) => project.permission === "allowed",
  );
  const denied = input.projects.filter(
    (project) => project.permission === "denied",
  );
  const visibleAllowed = allowed.slice(0, 60);
  const visibleDenied = denied.slice(0, 60);
  const hiddenCount =
    input.summary.allowed +
    input.summary.denied -
    visibleAllowed.length -
    visibleDenied.length;
  const projectList = (
    title: string,
    projects: typeof input.projects,
    total: number,
  ) => [
    `**${title}（${total}）**`,
    ...(projects.length > 0
      ? projects.map(
          (project) =>
            `- ${safeMarkdownText(project.displayName, 100)}（${project.sessionCount} 个 Session）`,
        )
      : ["- 无"]),
  ];
  const elements: FeishuCardElement[] = [
    markdown(
      truncateCardText(
        [
          ...projectList("允许采集", visibleAllowed, input.summary.allowed),
          "",
          ...projectList("不采集", visibleDenied, input.summary.denied),
        ].join("\n"),
        FEISHU_CARD_BODY_TEXT_LIMIT,
      ),
      "scope_status_projects",
    ),
    notation(
      hiddenCount > 0
        ? `另有 ${hiddenCount} 个项目未在卡片中展开。当前没有待审批项目，插件只会采集已允许的项目。`
        : "当前没有待审批项目，插件只会采集已允许的项目。",
      "scope_status_notice",
    ),
  ];

  return createCard({
    title: "项目采集权限状态",
    subtitle: input.periodLabel ?? input.deviceName,
    summary: `允许采集 ${input.summary.allowed} 个 · 不采集 ${input.summary.denied} 个`,
    template: "green",
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
          180,
        )}`,
    );
  if (input.item.dailyProgress.length > dailyProgress.length) {
    dailyProgress.push(
      `- 另有 ${input.item.dailyProgress.length - dailyProgress.length} 条进展未在卡片中展开`,
    );
  }
  const itemBody = [
    `**${safeMarkdownText(input.item.title, 160)}**`,
    ...(input.item.projectDescription
      ? [
          "",
          "**项目描述**",
          safeMarkdownText(input.item.projectDescription, 600),
        ]
      : []),
    "",
    safeMarkdownText(input.item.overview, 500),
    ...(dailyProgress.length > 0 ? ["", "**每日进展**", ...dailyProgress] : []),
  ].join("\n");
  const baseValue = {
    deliveryId: input.deliveryId,
    aggregateId: input.aggregateId,
    itemId: input.item.id,
    baseVersion: input.baseVersion,
  };
  const elements: FeishuCardElement[] = [
    notation(progressText, "review_progress"),
    markdown(
      truncateCardText(itemBody, FEISHU_CARD_BODY_TEXT_LIMIT),
      "review_item",
    ),
  ];

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
        confirm: {
          title: "确认忽略",
          text: "该项目不会进入本期团队报告汇总。",
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
      }),
    ]),
  );

  return createCard({
    title: "项目工作卡片审核",
    subtitle: input.periodLabel ?? progressText,
    summary: `待审核：${input.item.title}`,
    template: "blue",
    elements,
  });
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
    title: "审核已完成",
    message: "本期审核结果已经锁定，当前卡片不再接受修改。",
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
