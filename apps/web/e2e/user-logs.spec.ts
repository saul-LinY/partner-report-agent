import { expect, test, type Page } from "@playwright/test";

const members = [
  {
    partnerId: "partner-chen",
    name: "陈明",
    devices: [
      {
        id: "device-chen",
        deviceName: "陈明的 MacBook",
        version: "0.3.1",
        lastLogAt: "2026-09-05T09:58:00.000Z",
        lastUploadAt: "2026-09-05T09:00:00.000Z",
      },
    ],
    appVersion: "0.3.1",
    online: true,
    lastLogAt: "2026-09-05T09:58:00.000Z",
    lastUploadAt: "2026-09-05T09:00:00.000Z",
    errorCount: 2,
    severity: "critical",
  },
  {
    partnerId: "partner-lin",
    name: "林安",
    devices: [
      {
        id: "device-lin",
        deviceName: "林安的 Mac mini",
        version: "0.3.0",
        lastLogAt: "2026-09-05T08:00:00.000Z",
        lastUploadAt: null,
      },
    ],
    appVersion: "0.3.0",
    online: false,
    lastLogAt: "2026-09-05T08:00:00.000Z",
    lastUploadAt: null,
    errorCount: 0,
    severity: "warning",
  },
];

const clientState = {
  startupStage: "ready",
  projectCount: 5,
  allowedProjectCount: 3,
  sessionCount: 41,
  unreadableSessionCount: 2,
  pendingSessionCount: 7,
  isScanning: false,
  isUploading: true,
  scanProcessed: 0,
  scanTotal: 0,
  uploadProcessed: 3,
  uploadTotal: 7,
  autoUpload: true,
  frequency: "weekly",
  uploadHour: 17,
  uploadMinute: 30,
  uploadWeekday: 6,
};

type LogEvent = {
  eventId: string;
  deviceId: string;
  deviceName: string;
  occurredAt: string;
  receivedAt: string;
  stage: string;
  level: "info" | "warning" | "error";
  code: string;
  uploadId: string | null;
  sessionCount: number;
  message: string | null;
  details: Record<string, unknown>;
};

function event(
  partner: "chen" | "lin",
  index: number,
  level: LogEvent["level"],
  stage: string,
  code: string,
  extra: Partial<LogEvent> = {},
): LogEvent {
  return {
    eventId: `${partner}-event-${index}`,
    deviceId: `device-${partner}`,
    deviceName: partner === "chen" ? "陈明的 MacBook" : "林安的 Mac mini",
    occurredAt: new Date(Date.UTC(2026, 8, 5, 9, 50 - index)).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 8, 5, 9, 51 - index)).toISOString(),
    stage,
    level,
    code,
    uploadId: null,
    sessionCount: 0,
    message: null,
    details: {},
    ...extra,
  };
}

const eventsByPartner: Record<string, LogEvent[]> = {
  "partner-chen": [
    event("chen", 0, "error", "upload", "UPLOAD_FAILED", {
      uploadId: "abcdef12-0000-4000-8000-000000000000",
      sessionCount: 7,
      message: "接收端返回 502",
      details: {
        httpStatus: 502,
        durationMs: 2500,
        errorKind: "server",
        apiErrorCode: "UPSTREAM_BAD_GATEWAY",
        bytes: 2048,
      },
    }),
    event("chen", 1, "warning", "permissions", "POLICY_SYNC_FAILED", {
      details: { errorKind: "network" },
    }),
    event("chen", 2, "info", "scan", "SCAN_COMPLETED", { sessionCount: 41 }),
  ],
  "partner-lin": [
    event("lin", 0, "info", "app", "APP_LAUNCHED", {
      details: { appVersion: "0.3.0", osVersion: "macOS 15.1" },
    }),
    event("lin", 1, "error", "scan", "SCAN_FAILED"),
  ],
};

const uploads: Record<string, unknown[]> = {
  "partner-chen": [
    {
      id: "abcdef12-0000-4000-8000-000000000000",
      device_name: "陈明的 MacBook",
      period_key: "2026-W36",
      period_id: "period-36",
      session_count: 7,
      status: "completed",
      created_at: "2026-09-05T09:40:00.000Z",
      completed_at: "2026-09-05T09:45:00.000Z",
      analysis_total: 7,
      analysis_completed: 5,
      analysis_ignored: 1,
      analysis_failed: 0,
      analysis_retrying: 1,
      error_code: "MODEL_REQUEST_TIMEOUT",
      card_error_code: null,
      report_error_code: null,
      next_retry_at: "2026-09-05T10:10:00.000Z",
      stage: "analysis_retrying",
      label: "分析等待重试",
      tone: "warning",
      review_id: null,
      pending_cards: 0,
      approved_cards: 0,
      report_id: null,
      cutoff_at: "2026-09-06T10:00:00.000Z",
    },
  ],
  "partner-lin": [],
};

async function setup(
  page: Page,
  options: { path?: string; slowPartner?: string; uploadCount?: number } = {},
) {
  const calls: { pathname: string; search: URLSearchParams; method: string }[] =
    [];
  const release = Promise.withResolvers<void>();
  await page.clock.install({ time: new Date("2026-09-05T10:00:00Z") });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({
      pathname: url.pathname,
      search: url.searchParams,
      method: request.method(),
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
    if (url.pathname === "/v1/admin/user-logs")
      return route.fulfill({
        json: {
          checkedAt: "2026-09-05T10:00:00.000Z",
          onlineWindowMinutes: 5,
          windowHours: 24,
          members,
        },
      });
    const match = url.pathname.match(/^\/v1\/admin\/user-logs\/([^/]+)$/);
    if (match) {
      const partnerId = match[1]!;
      const member = members.find((item) => item.partnerId === partnerId);
      if (!member)
        return route.fulfill({
          status: 404,
          json: {
            code: "PARTNER_NOT_FOUND",
            message: "成员没有可用的 App 设备。",
          },
        });
      if (partnerId === options.slowPartner) await release.promise;
      const level = url.searchParams.get("level");
      const stage = url.searchParams.get("stage");
      const date = url.searchParams.get("date");
      const events = date
        ? []
        : (eventsByPartner[partnerId] ?? []).filter(
            (item) =>
              (!level || item.level === level) &&
              (!stage || item.stage === stage),
          );
      return route.fulfill({
        json: {
          partner: { id: partnerId, name: member.name },
          window: {
            mode: date ? "day" : "recent",
            date,
            timezone: "Asia/Shanghai",
            startedAt: "2026-09-04T10:00:00.000Z",
            endedAt: "2026-09-05T10:00:00.000Z",
          },
          devices: member.devices.map((device) => ({
            ...device,
            clientState: partnerId === "partner-chen" ? clientState : null,
            stateObservedAt:
              partnerId === "partner-chen" ? "2026-09-05T09:58:00.000Z" : null,
            online: member.online,
            notificationCode:
              partnerId === "partner-chen" ? "NOTIFICATIONS_DENIED" : null,
          })),
          events,
          uploads:
            options.uploadCount && partnerId === "partner-chen"
              ? Array.from({ length: options.uploadCount }, (_, index) => ({
                  ...uploads[partnerId]![0],
                  id: `abcdef12-0000-4000-8000-${String(index).padStart(12, "0")}`,
                }))
              : (uploads[partnerId] ?? []),
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Unexpected test request" },
    });
  });
  await page.goto(options.path ?? "/admin/user-logs");
  await expect(
    page.getByRole("heading", { name: "用户日志", exact: true }),
  ).toBeVisible();
  return { calls, release };
}

const memberButton = (page: Page, name: string) =>
  page.locator(".sm-member-button").filter({ hasText: name });

test("members list shows devices, version, online state, errors and severity", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".sm-member-button")).toHaveCount(2);
  const chen = memberButton(page, "陈明");
  await expect(chen).toContainText("陈明的 MacBook");
  await expect(chen).toContainText("App 0.3.1");
  await expect(chen).toContainText("在线");
  await expect(chen).toContainText("2 条错误");
  await expect(chen).toContainText("运行异常");
  const lin = memberButton(page, "林安");
  await expect(lin).toContainText("离线");
  await expect(lin).toContainText("尚未上传");
  await expect(lin).toContainText("无错误");
  await expect(lin).toContainText("日志或会话包接收延迟");
});

test("the first member is selected by default and the device card shows client state", async ({
  page,
}) => {
  await setup(page);
  await expect(memberButton(page, "陈明")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const card = page.getByRole("article", { name: "设备 陈明的 MacBook" });
  await expect(card).toContainText("启动阶段");
  await expect(card).toContainText("已就绪");
  await expect(card).toContainText("项目 / 已允许");
  await expect(card).toContainText("5 / 3");
  await expect(card).toContainText("无法读取");
  await expect(card).toContainText("待上传");
  await expect(card).toContainText("上传中 3/7");
  await expect(card).toContainText("每周五 17:30");
  await expect(card).toContainText("未开启");
});

test("switching members changes the events and never mixes them", async ({
  page,
}) => {
  await setup(page);
  const events = page.locator(".sm-event");
  await expect(events).toHaveCount(3);
  await expect(page.getByText("会话包上传失败")).toBeVisible();
  await expect(page.getByText("App 已启动")).toHaveCount(0);
  await memberButton(page, "林安").click();
  await expect(page).toHaveURL(/partnerId=partner-lin/);
  await expect(events).toHaveCount(2);
  await expect(page.getByText("App 已启动")).toBeVisible();
  await expect(page.getByText("会话包上传失败")).toHaveCount(0);
  await expect(page.getByText("分析等待重试")).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "设备 林安的 Mac mini" }),
  ).toContainText("等待 App 上报");
  await expect(page.getByRole("article", { name: /陈明/ })).toHaveCount(0);
});

test("a slow member request never shows the previous member's events", async ({
  page,
}) => {
  const { release } = await setup(page, { slowPartner: "partner-lin" });
  await expect(page.locator(".sm-event")).toHaveCount(3);
  await memberButton(page, "林安").click();
  await expect(page.getByText("加载成员日志")).toBeVisible();
  await expect(page.locator(".sm-event")).toHaveCount(0);
  await expect(page.getByText("会话包上传失败")).toHaveCount(0);
  release.resolve();
  await expect(page.locator(".sm-event")).toHaveCount(2);
});

test("partnerId in the URL deep-links to that member", async ({ page }) => {
  const { calls } = await setup(page, {
    path: "/admin/user-logs?partnerId=partner-lin",
  });
  await expect(memberButton(page, "林安")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".sm-event")).toHaveCount(2);
  expect(
    calls.some((call) => call.pathname === "/v1/admin/user-logs/partner-chen"),
  ).toBe(false);
});

test("an unknown partnerId says the member has no usable device", async ({
  page,
}) => {
  await setup(page, { path: "/admin/user-logs?partnerId=partner-missing" });
  await expect(page.getByText("该成员没有可用的 App 设备")).toBeVisible();
  await expect(page.locator(".sm-event")).toHaveCount(0);
});

test("level and stage filters are sent to the API and narrow the timeline", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await expect(page.locator(".sm-event")).toHaveCount(3);
  await page.getByLabel("日志级别", { exact: true }).selectOption("error");
  await expect(page.locator(".sm-event")).toHaveCount(1);
  await expect(page.locator(".sm-event")).toContainText("会话包上传失败");
  await page.getByLabel("日志级别", { exact: true }).selectOption("");
  await page.getByLabel("日志阶段", { exact: true }).selectOption("scan");
  await expect(page.locator(".sm-event")).toHaveCount(1);
  await expect(page.locator(".sm-event")).toContainText("扫描完成");
  await page.getByLabel("日志级别", { exact: true }).selectOption("error");
  await expect(page.getByText("没有符合条件的日志")).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/user-logs/partner-chen" &&
        call.search.get("level") === "error" &&
        call.search.get("stage") === "scan",
    ),
  ).toBe(true);
});

test("events are newest first and expand to Chinese-labelled details", async ({
  page,
}) => {
  await setup(page);
  const titles = page.locator(".sm-event .sm-event-title strong");
  await expect(titles).toHaveText([
    "会话包上传失败",
    "项目权限同步失败",
    "扫描完成",
  ]);
  const failed = page.locator(".sm-event").first();
  await expect(failed).toHaveJSProperty("open", true);
  await expect(failed).toContainText("接收端返回 502");
  await expect(failed).toContainText("HTTP 状态");
  await expect(failed).toContainText("502");
  await expect(failed).toContainText("耗时");
  await expect(failed).toContainText("2.5 秒");
  await expect(failed).toContainText("错误类型");
  await expect(failed).toContainText("接收端");
  await expect(failed).toContainText("接口错误码");
  await expect(failed).toContainText("UPSTREAM_BAD_GATEWAY");
  await expect(failed).toContainText("数据大小");
  await expect(failed).toContainText("2.0 KB");
  const info = page.locator(".sm-event").nth(2);
  await expect(info).toHaveJSProperty("open", false);
  await info.locator("summary").click();
  await expect(info).toContainText("会话数");
  await expect(info).toContainText("41");
});

test("upload batches show the pipeline stage and member-scoped actions", async ({
  page,
}) => {
  const { calls } = await setup(page);
  const row = page.locator(".sm-table tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("2026-W36");
  await expect(row).toContainText("整批已确认");
  await expect(row).toContainText("分析等待重试");
  await expect(row).toContainText("已分析 5 / 7，忽略 1");
  await expect(row).toContainText("MODEL_REQUEST_TIMEOUT");
  await expect(row).toContainText("下次重试");
  let retried = false;
  await page.route("**/v1/admin/collector-uploads/*/retry", (route) => {
    retried =
      route.request().method() === "POST" &&
      new URL(route.request().url()).pathname ===
        "/v1/admin/collector-uploads/abcdef12-0000-4000-8000-000000000000/retry";
    return route.fulfill({ json: { ok: true, retried: 1 } });
  });
  await row.getByRole("button", { name: "重试处理" }).click();
  await expect.poll(() => retried).toBe(true);
  await memberButton(page, "林安").click();
  await expect(page.getByText("暂无会话包")).toBeVisible();
});

test("history mode uses the selected team-timezone day and returns to recent", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("button", { name: "历史日志", exact: true }).click();
  await page.getByLabel("用户历史日志日期").fill("2026-09-01");
  await expect(page.getByText("这一天没有 App 日志")).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/user-logs/partner-chen" &&
        call.search.get("date") === "2026-09-01",
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "最近 24 小时" }).click();
  await expect(page.getByLabel("用户历史日志日期")).toHaveCount(0);
  await expect(page.locator(".sm-event")).toHaveCount(3);
});

test("auto refresh polls the member list and the selected member", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await expect(page.locator(".sm-event")).toHaveCount(3);
  const count = () =>
    calls.filter((call) => call.pathname === "/v1/admin/user-logs").length;
  const before = count();
  await page.clock.fastForward(10_100);
  await expect.poll(count).toBeGreaterThan(before);
  await page.getByRole("switch", { name: "自动刷新" }).uncheck();
  const paused = calls.length;
  await page.clock.fastForward(30_000);
  expect(calls).toHaveLength(paused);
});

for (const width of [320, 390, 768, 1024, 1176, 1440, 1920]) {
  test(`layout and detail navigation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    const noOverflow = async () =>
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBeTruthy();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`user-logs-${width}.png`),
      fullPage: true,
    });
    await memberButton(page, "陈明").click();
    await expect(
      page.getByRole("region", { name: "成员日志详情" }),
    ).toBeVisible();
    await expect(page.locator(".sm-event").first()).toBeVisible();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`user-logs-detail-${width}.png`),
      fullPage: true,
    });
    if (width <= 1150) {
      await page.getByRole("button", { name: "返回成员列表" }).click();
      await expect(memberButton(page, "林安")).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1176, 1440, 1920]) {
  test(`upload columns remain readable and reachable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await setup(page, { uploadCount: 14 });
    await memberButton(page, "陈明").click();
    const detail = page.getByRole("region", { name: "成员日志详情" });
    const table = page.getByRole("region", { name: "上传批次表格" });
    await expect(table.locator("tbody tr")).toHaveCount(14);
    if (width > 1150) {
      const list = await page.getByLabel("成员列表").boundingBox();
      expect(list!.width).toBeLessThanOrEqual(280);
      expect(await detail.evaluate((node) => node.scrollTop)).toBe(0);
    }
    await table.scrollIntoViewIfNeeded();
    await expect(
      table.getByRole("columnheader", { name: "采集周期" }),
    ).toBeInViewport();
    await table.evaluate((node) => {
      node.scrollTop = 300;
    });
    await expect(
      table.getByRole("columnheader", { name: "采集周期" }),
    ).toBeInViewport();
    await table.evaluate((node) => {
      node.scrollTop = 0;
    });
    expect(
      await table
        .locator("th")
        .evaluateAll((headers) =>
          headers.every((header) => header.getBoundingClientRect().height < 45),
        ),
    ).toBe(true);
    expect(
      await table
        .locator(".badge")
        .evaluateAll((badges) =>
          badges.every((badge) => badge.getBoundingClientRect().height <= 26),
        ),
    ).toBe(true);
    expect(
      await table
        .locator(".button")
        .first()
        .evaluate((button) => {
          const cell = button.closest("td")!.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          return box.left >= cell.left && box.right <= cell.right;
        }),
    ).toBe(true);
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`user-uploads-${width}.png`),
      fullPage: width <= 1150,
    });
    await table.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    expect(
      await table.evaluate((node) => {
        const last = node
          .querySelector("th:last-child")!
          .getBoundingClientRect();
        const frame = node.getBoundingClientRect();
        return last.left >= frame.left && last.right <= frame.right + 1;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
