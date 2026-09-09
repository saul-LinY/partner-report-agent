import { expect, test, type Page } from "@playwright/test";

const sources = ["job", "delivery", "report", "inbox", "outbox"];
const names = [
  "工作卡片生成",
  "飞书审核通知",
  "团队报告汇总",
  "审核回调接收",
  "项目授权事件",
];
const executions = Array.from({ length: 27 }, (_, index) => ({
  executionId: `${sources[index % 5]}:record-${index}`,
  source: sources[index % 5],
  sourceId: `record-${index}`,
  title: `${names[index % 5]} · ${String(index + 1).padStart(2, "0")}`,
  subject: index % 2 ? "林安 · 数据服务" : "陈明 · Partner Report",
  status:
    index % 3 === 0 ? "FAILED" : index % 3 === 1 ? "RETRY_WAIT" : "COMPLETED",
  severity:
    index % 3 === 0 ? "critical" : index % 3 === 1 ? "warning" : "normal",
  startedAt: new Date(Date.UTC(2026, 8, 5, 9, 40 - index)).toISOString(),
  lastEventAt: new Date(Date.UTC(2026, 8, 5, 9, 42 - index)).toISOString(),
  durationMs: 120000,
  eventCount: 2,
  summary:
    index % 3 === 0
      ? "模型调用超时，任务未完成"
      : index % 3 === 1
        ? "任务等待重试"
        : "任务已成功完成",
  errorCode: index % 3 === 0 ? "MODEL_TIMEOUT" : null,
}));
const components = ["api", "queue", "generation", "feishu", "reports"].map(
  (key, index) => ({
    key,
    label: ["API 与数据库", "后台任务队列", "内容生成", "飞书消息", "报告生成"][
      index
    ],
    severity: index === 2 ? "critical" : index === 1 ? "warning" : "normal",
    summary: [
      "服务响应正常",
      "3 个任务处理中",
      "9 个任务生成失败",
      "消息发送正常",
      "报告流水线正常",
    ][index],
    detail: [
      "数据库查询正常完成。",
      "最早的活动任务已等待 5 分钟。",
      "过去 24 小时完成 128 个生成任务。",
      "过去 24 小时成功发送 96 条消息。",
      "2 份报告待确认，过去 24 小时归档 5 份。",
    ][index],
    count: 0,
  }),
);
const monitoring = {
  checkedAt: "2026-09-05T09:45:00.000Z",
  overallSeverity: "critical",
  summary: {
    componentCount: 5,
    normal: 3,
    warning: 1,
    critical: 1,
    openIncidents: 2,
  },
  components,
  incidents: [
    {
      id: "incident-1",
      sourceId: "record-0",
      source: "generation",
      severity: "critical",
      title: "工作卡片生成失败",
      message: "模型调用超时，任务未能生成有效内容。",
      errorCode: "MODEL_TIMEOUT",
      partnerName: "陈明",
      occurredAt: "2026-09-05T09:42:00.000Z",
      action: "检查模型服务连接后重试任务。",
      href: "/admin/jobs",
    },
    {
      id: "incident-2",
      sourceId: "record-1",
      source: "feishu",
      severity: "warning",
      title: "飞书通知等待重试",
      message: "发送频率超过限制。",
      errorCode: "RATE_LIMITED",
      partnerName: "林安",
      occurredAt: "2026-09-05T09:41:00.000Z",
      action: "等待自动重试。",
      href: null,
    },
  ],
};

async function setup(
  page: Page,
  options: {
    empty?: boolean;
    failHealth?: boolean;
    failLogs?: boolean;
    unknown?: boolean;
  } = {},
) {
  const calls: {
    pathname: string;
    method: string;
    date: string | null;
    executionId: string | null;
    body: unknown;
  }[] = [];
  const analyses = new Map<string, string>();
  await page.clock.install({ time: new Date("2026-09-05T10:00:00Z") });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({
      pathname: url.pathname,
      method: request.method(),
      date: url.searchParams.get("date"),
      executionId: url.searchParams.get("executionId"),
      body: request.postDataJSON(),
    });
    if (url.pathname === "/v1/me")
      return route.fulfill({
        json: {
          userId: "admin",
          tenantId: "test",
          teamId: "test",
          roles: ["admin"],
          email: "admin@example.test",
          displayName: "管理员",
          teamName: "产品研发团队",
        },
      });
    if (url.pathname === "/v1/admin/system-monitoring") {
      if (options.failHealth)
        return route.fulfill({
          status: 503,
          json: { code: "UNAVAILABLE", message: "状态服务暂不可用" },
        });
      return route.fulfill({
        json: {
          ...monitoring,
          ...(options.unknown ? { overallSeverity: "unknown" } : {}),
          ...(options.empty
            ? {
                overallSeverity: "normal",
                incidents: [],
                summary: {
                  componentCount: 5,
                  normal: 5,
                  warning: 0,
                  critical: 0,
                  openIncidents: 0,
                },
              }
            : {}),
        },
      });
    }
    if (url.pathname.endsWith("/test")) {
      const component = url.pathname.split("/").at(-2);
      return route.fulfill({
        json: {
          component,
          status: "passed",
          summary: "模块测试通过",
          detail: "探测已正常完成。",
          errorCode: null,
          durationMs: 125,
          checkedAt: "2026-09-05T10:00:00.000Z",
        },
      });
    }
    if (url.pathname === "/v1/admin/system-logs/analyze") {
      analyses.set(request.postDataJSON().executionId, "RETRY_WAIT");
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/v1/admin/system-logs") {
      if (options.failLogs)
        return route.fulfill({
          status: 503,
          json: { code: "LOGS_UNAVAILABLE", message: "日志查询失败" },
        });
      const records =
        options.empty || url.searchParams.get("date") === "2026-08-20"
          ? []
          : executions;
      const selected =
        records.find(
          (item) => item.executionId === url.searchParams.get("executionId"),
        ) ?? records[0];
      const id = selected?.executionId;
      const status = id ? analyses.get(id) : undefined;
      return route.fulfill({
        json: {
          window: {
            mode: url.searchParams.has("date") ? "day" : "recent",
            date: url.searchParams.get("date"),
            timezone: "Asia/Shanghai",
            startedAt: "2026-09-04T10:00:00Z",
            endedAt: "2026-09-05T10:00:00Z",
          },
          executions: records,
          selectedExecutionId: id ?? null,
          events: selected
            ? [
                {
                  id: `${id}-start`,
                  executionId: id,
                  source: selected.source,
                  level: "info",
                  stage: "接收",
                  eventCode: "TASK_STARTED",
                  title: "任务已进入处理队列",
                  message: `开始处理 ${id}`,
                  occurredAt: selected.startedAt,
                  details: { executionId: id, attempt: 1 },
                },
                {
                  id: `${id}-end`,
                  executionId: id,
                  source: selected.source,
                  level: selected.severity === "critical" ? "error" : "info",
                  stage: "生成",
                  eventCode: selected.errorCode ?? "TASK_COMPLETED",
                  title: selected.summary,
                  message: `运行结果 ${id}`,
                  occurredAt: selected.lastEventAt,
                  details: {
                    executionId: id,
                    errorCode: selected.errorCode,
                    durationMs: selected.durationMs,
                  },
                },
              ]
            : [],
          modelAnalysis: status
            ? {
                id: "analysis-1",
                status,
                error_code: null,
                error_message: null,
                output_payload:
                  status === "COMPLETED"
                    ? {
                        summary: "上游模型请求超时",
                        failedStep: "内容生成",
                        rootCause: "模型网关没有在时限内响应",
                        evidence: ["模型请求持续 120 秒后超时"],
                        recommendedActions: ["检查网关状态", "恢复后重试任务"],
                        confidence: "high",
                      }
                    : null,
              }
            : null,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Unexpected test request" },
    });
  });
  await page.goto("/admin/system-monitoring");
  await expect(
    page.getByRole("heading", { name: "系统监控", exact: true }),
  ).toBeVisible();
  return { calls, analyses };
}

test("search, filters, sorting and pagination keep the correct detail selected", async ({
  page,
}) => {
  await setup(page);
  const records = page.locator(".sm-record-button");
  await expect(records).toHaveCount(12);
  await page.getByTitle("下一页", { exact: true }).click();
  await expect(page.locator(".sm-pagination")).toContainText("2 / 3");
  await expect(
    page.getByRole("region", { name: "运行详情", exact: true }),
  ).toContainText("record-12");
  await page.getByRole("textbox", { name: "搜索运行记录" }).fill("record-24");
  await expect(records).toHaveCount(1);
  await expect(page.locator(".sm-meta-id")).toContainText("record-24");
  await page.getByRole("button", { name: "重置筛选" }).click();
  await page.getByLabel("日志来源", { exact: true }).selectOption("delivery");
  await page.getByLabel("日志状态", { exact: true }).selectOption("critical");
  await expect(records).toHaveCount(2);
  await page.getByLabel("日志排序", { exact: true }).selectOption("oldest");
  await expect(records.first()).toContainText("22");
  await page.getByRole("textbox", { name: "搜索运行记录" }).fill("no-match");
  await expect(page.getByText("没有符合条件的运行记录")).toBeVisible();
  await expect(page.locator(".sm-meta-id")).toHaveCount(0);
});

test("timeline, raw details and issue-only mode belong to the selected record", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".sm-event")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "仅看问题" }).check();
  await expect(page.locator(".sm-event")).toHaveCount(1);
  await expect(page.locator(".sm-event pre").last()).toContainText(
    "job:record-0",
  );
  await page.locator(".sm-record-button").nth(2).click();
  await expect(
    page.getByRole("checkbox", { name: "仅看问题" }),
  ).not.toBeChecked();
  await expect(page.locator(".sm-meta-id")).toContainText("record-2");
  await page.getByRole("checkbox", { name: "仅看问题" }).check();
  await expect(page.getByText("本次运行没有错误或警告")).toBeVisible();
});

test("history date navigation and analysis retry polling work while auto refresh is paused", async ({
  page,
}) => {
  const { calls, analyses } = await setup(page);
  await page.getByRole("switch", { name: "自动刷新" }).uncheck();
  await page.getByRole("button", { name: "历史日志", exact: true }).click();
  await page.getByLabel("中台历史日志日期").fill("2026-08-20");
  await expect(page.getByText("这一天没有中台日志")).toBeVisible();
  await page.getByTitle("后一天", { exact: true }).click();
  await expect(page.getByLabel("中台历史日志日期")).toHaveValue("2026-08-21");
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByText("分析任务等待重试")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "分析中", exact: true }),
  ).toBeDisabled();
  analyses.set("job:record-0", "COMPLETED");
  await page.clock.fastForward(10_100);
  await expect(
    page.getByText("上游模型请求超时", { exact: true }),
  ).toBeVisible();
  await page.getByText("分析证据 · 1").click();
  await expect(page.getByText("模型请求持续 120 秒后超时")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新分析" })).toBeEnabled();
  expect(calls.some((call) => call.date === "2026-08-20")).toBeTruthy();
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    executionId: "job:record-0",
  });
  await page.getByRole("button", { name: "最近 24 小时" }).click();
  await expect(page.getByLabel("中台历史日志日期")).toHaveCount(0);
});

test("all five module probes retain their results when switching tabs", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("tab", { name: "模块健康" }).click();
  for (const component of components) {
    await page
      .getByRole("button", { name: `测试${component.label}`, exact: true })
      .click();
  }
  await expect(page.getByText("模块测试通过", { exact: true })).toHaveCount(5);
  await page.getByRole("tab", { name: "运行日志", exact: true }).click();
  await page.getByRole("tab", { name: "模块健康" }).click();
  await expect(page.getByText("模块测试通过", { exact: true })).toHaveCount(5);
  expect(
    calls
      .filter((call) => call.pathname.endsWith("/test"))
      .map((call) => call.pathname),
  ).toEqual(
    components.map(
      (component) => `/v1/admin/system-monitoring/${component.key}/test`,
    ),
  );
});

test("health failures do not block log review and manual refresh recovers", async ({
  page,
}) => {
  const options = { failHealth: true };
  await setup(page, options);
  await page.clock.fastForward(2000);
  await expect(page.getByRole("alert")).toContainText("状态服务暂不可用");
  await expect(page.locator(".sm-record-button")).toHaveCount(12);
  options.failHealth = false;
  await page.getByTitle("刷新系统状态", { exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("存在异常", { exact: true })).toBeVisible();
});

test("empty, unknown and log failure states are explicit and recoverable", async ({
  page,
}) => {
  const options = { empty: true, failLogs: false, unknown: false };
  await setup(page, options);
  await expect(page.getByText("最近 24 小时没有中台日志")).toBeVisible();
  options.empty = false;
  options.unknown = true;
  options.failLogs = true;
  await page.getByRole("tab", { name: "运行日志", exact: true }).click();
  await page.getByTitle("刷新系统状态", { exact: true }).click();
  await page.clock.fastForward(2000);
  await expect(page.getByText("状态未知", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("日志查询失败");
  options.failLogs = false;
  await page.getByTitle("刷新中台日志", { exact: true }).click();
  await expect(page.locator(".sm-record-button")).toHaveCount(12);
});

test("automatic refresh can be paused and resumed", async ({ page }) => {
  const { calls } = await setup(page);
  await expect(page.locator(".sm-event")).toHaveCount(2);
  await page.getByRole("switch", { name: "自动刷新" }).uncheck();
  const before = calls.length;
  await page.clock.fastForward(30_000);
  expect(calls).toHaveLength(before);
  await page.getByRole("switch", { name: "自动刷新" }).check();
  await page.clock.fastForward(10_100);
  await expect.poll(() => calls.length).toBeGreaterThan(before);
});

test("tabs support keyboard navigation", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "运行日志", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "模块健康" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "运行日志", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "模块健康" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "运行日志", exact: true }),
  ).toBeFocused();
});

test("a slow selection never shows the previous record's events", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".sm-event pre").last()).toContainText(
    "job:record-0",
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/admin/system-logs?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("executionId") ===
      "delivery:record-1"
    )
      await pending;
    await route.fallback();
  });
  try {
    await page.locator(".sm-record-button").nth(1).click();
    await expect(page.getByText("加载运行详情", { exact: true })).toBeVisible();
    await expect(page.locator(".sm-event")).toHaveCount(0);
    await expect(page.locator(".sm-meta-id")).toContainText("record-1");
  } finally {
    release();
  }
  await expect(page.locator(".sm-event")).toHaveCount(2);
  await page.locator(".sm-event summary").first().click();
  await expect(page.locator(".sm-event pre").first()).toContainText(
    "delivery:record-1",
  );
});

test("module and analysis request failures remain actionable", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/v1/admin/system-logs/analyze", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "MODEL_UNAVAILABLE", message: "模型服务暂不可用" },
    }),
  );
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByRole("alert")).toContainText("模型服务暂不可用");
  await expect(page.getByRole("button", { name: "开始分析" })).toBeEnabled();
  await page.getByRole("tab", { name: "模块健康" }).click();
  await page.route("**/v1/admin/system-monitoring/api/test", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "PROBE_UNAVAILABLE", message: "探测服务暂不可用" },
    }),
  );
  await page
    .getByRole("button", { name: "测试API 与数据库", exact: true })
    .click();
  await expect(page.getByText("模块测试未完成")).toBeVisible();
  await expect(page.getByText("探测服务暂不可用")).toBeVisible();
  await page.unroute("**/v1/admin/system-monitoring/api/test");
  await page
    .getByRole("button", { name: "测试API 与数据库", exact: true })
    .click();
  await expect(page.getByText("模块测试通过")).toBeVisible();
});

for (const width of [320, 390, 768, 1280, 1440, 1920]) {
  test(`layout and detail navigation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await expect(page.locator(".sm-record-button")).toHaveCount(12);
    const noOverflow = async () =>
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBeTruthy();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`monitoring-${width}.png`),
      fullPage: true,
    });
    await page.locator(".sm-record-button").first().click();
    await expect(
      page.getByRole("region", { name: "运行详情", exact: true }),
    ).toBeVisible();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`detail-${width}.png`),
      fullPage: true,
    });
    if (width <= 1150) {
      await page.getByRole("button", { name: "返回运行记录" }).click();
      await expect(page.locator(".sm-record-button").first()).toBeVisible();
    }
    await page.getByRole("tab", { name: "模块健康" }).click();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`components-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
