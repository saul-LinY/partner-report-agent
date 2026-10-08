import { expect, test, type Page } from "@playwright/test";

const date = "2026-09-08T09:00:00Z";

async function setup(page: Page, path: string, longReview = false) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let reviewVersion = 6;
  let projectStatus = "development";

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({
      path: url.pathname,
      method: request.method(),
      body: request.postDataJSON(),
    });
    const send = (json: unknown) => route.fulfill({ json });
    if (url.pathname === "/v1/me")
      return send({
        userId: "admin",
        tenantId: "test",
        teamId: "team",
        roles: ["admin"],
        email: "admin@example.test",
        displayName: "管理员",
        teamName: "产品研发团队",
      });
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/project-status")
    ) {
      projectStatus = request.postDataJSON().projectStatus;
      return send({ version: ++reviewVersion, changed: true });
    }
    if (request.method() === "POST") return send({ ok: true, version: 7 });
    if (url.pathname === "/v1/admin/agent-jobs")
      return send(
        url.searchParams.get("status") === "FAILED"
          ? [
              {
                id: "job-1",
                partner_id: "member-1",
                plugin_instance_id: null,
                partner_name: "陈明",
                plugin_device_name: null,
                type: "AGGREGATE_WORK_ITEMS",
                status: "FAILED",
                attempt_count: 3,
                max_attempts: 3,
                error_code: "MODEL_REQUEST_TIMEOUT",
                error_message: "请求超时，请稍后重试。",
                created_at: date,
                updated_at: date,
              },
            ]
          : [],
      );
    if (url.pathname === "/v1/admin/plugin-monitoring")
      return send({
        checkedAt: date,
        schedule: {
          timezone: "Asia/Shanghai",
          time: "17:00",
          graceMinutes: 30,
          staleRunMinutes: 30,
        },
        summary: { total: 8, normal: 0, warning: 0, critical: 8, unknown: 0 },
        plugins: Array.from({ length: 8 }, (_, i) => ({
          id: `plugin-${i}`,
          partnerId: `member-${i}`,
          partnerName: `成员 ${i}`,
          deviceName: `研发工作设备 ${i}`,
          version: "2.1.0",
          lastHeartbeatAt: date,
          lastSyncAt: date,
          lastCollectionStartedAt: date,
          lastCollectionCompletedAt: date,
          latestEventAt: date,
          latestStage: "上传贡献",
          latestEventCode: "UPLOAD_FAILED",
          latestMessage: "上传超时",
          pendingLocalJobs: 0,
          runnerState: "idle",
          status: {
            severity: "critical",
            code: "UPLOAD_FAILED",
            label: "上传异常",
            reason: "贡献上传超时",
            action: "检查网络后重试",
          },
        })),
      });
    if (url.pathname === "/v1/admin/plugin-logs")
      return send({
        pluginInstanceId: url.searchParams.get("pluginInstanceId"),
        window: {
          mode: "recent",
          date: null,
          timezone: "Asia/Shanghai",
          startedAt: date,
          endedAt: date,
        },
        selectedExecutionId: "execution-1",
        modelAnalysis: null,
        executions: [
          {
            executionId: "execution-1",
            grouping: "invocation",
            invocationId: "invocation-1",
            runId: "run-1",
            command: "collect",
            startedAt: date,
            lastEventAt: date,
            durationMs: 2000,
            eventCount: 2,
            errorCount: 1,
            warningCount: 0,
            finalSummary: "贡献上传超时",
            diagnosis: {
              severity: "critical",
              state: "failed",
              title: "上传未完成",
              cause: "连接超时",
              action: "检查连接并重试",
              failedStage: "upload",
              evidenceCode: "UPLOAD_FAILED",
              retryable: true,
            },
          },
        ],
        events: ["info", "error"].map((level, i) => ({
          id: `event-${i}`,
          invocation_id: "invocation-1",
          run_id: "run-1",
          sequence: i,
          command: "collect",
          event_type: level === "error" ? "error" : "progress",
          level,
          stage: "upload",
          event_code: level === "error" ? "UPLOAD_FAILED" : "UPLOAD_START",
          message: level === "error" ? "上传超时，贡献已保留" : "开始上传贡献",
          stack: null,
          retryable: true,
          attempt: 1,
          duration_ms: 2000,
          request_id: "request-1",
          details: { retained: true },
          occurred_at: date,
        })),
      });
    if (url.pathname === "/v1/admin/project-scope-backups/latest")
      return send({ plugins: [] });
    if (url.pathname === "/v1/reviews/review-1")
      return send({
        review: {
          id: "review-1",
          state: "IN_PROGRESS",
          version: reviewVersion,
        },
        regenerationJobs: [],
        items: [
          {
            id: "card-1",
            title: "项目贡献",
            project_name: "Partner Report",
            status: "in_progress",
            review_status: "pending",
            created_at: date,
            payload: {
              overview: "完成项目权限与贡献上传验证。",
              projectStatus,
              dailyProgress: longReview
                ? Array.from({ length: 7 }, (_, i) => ({
                    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
                    summary: `第 ${i + 1} 天：${"验证上传结果并保留历史记录。".repeat(35)}`,
                  }))
                : [
                    {
                      date: "2026-09-08",
                      summary: "验证上传结果并保留历史记录。",
                    },
                  ],
            },
          },
        ],
      });
    return route.fulfill({
      status: 404,
      json: { message: `Unexpected request: ${url.pathname}` },
    });
  });
  await page.goto(path);
  return calls;
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

for (const width of [390, 768, 1440]) {
  test(`navigation collapses, stays usable and remembers the choice at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page, "/admin/jobs");
    const sidebar = page.locator(".sidebar");
    const main = page.locator(".main-content");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const expandedSidebar = await sidebar.boundingBox();
    const expandedMain = await main.boundingBox();
    await page.getByRole("button", { name: "收拢导航栏" }).click();
    const expand = page.getByRole("button", { name: "展开导航栏" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    if (width > 760) {
      expect((await sidebar.boundingBox())!.width).toBeLessThan(
        expandedSidebar!.width,
      );
      expect((await main.boundingBox())!.width).toBeGreaterThan(
        expandedMain!.width,
      );
      await expect(navigation.getByRole("link")).toHaveCount(8);
      const plugins = navigation.getByRole("link", {
        name: "插件状态与日志",
        exact: true,
      });
      await expect(plugins).toHaveAttribute("title", "插件状态与日志");
      await plugins.click();
      await expect(plugins).toHaveAttribute("aria-current", "page");
      await expect(expand).toBeVisible();
    } else {
      await expect(navigation).toBeHidden();
      expect((await sidebar.boundingBox())!.height).toBeLessThan(
        expandedSidebar!.height,
      );
    }
    await noOverflow(page);
    await page.reload();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await page.screenshot({
      path: testInfo.outputPath(`navigation-collapsed-${width}.png`),
    });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "收拢导航栏" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      navigation.getByRole("link", { name: "项目进展", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "收拢导航栏" }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`navigation-expanded-${width}.png`),
    });
  });
}

test("review decisions stay available while reading a long work card", async ({
  page,
}, testInfo) => {
  await setup(page, "/partner/review/review-1", true);
  const actions = page.getByRole("complementary", { name: "工作卡审核操作" });
  await actions.getByLabel("修改意见").fill("补充验证结果");
  await page.getByText(/^第 6 天/).scrollIntoViewIfNeeded();
  await expect(
    actions.getByRole("button", { name: "通过", exact: true }),
  ).toBeInViewport();
  await expect(
    actions.getByRole("button", { name: "拒绝并忽略", exact: true }),
  ).toBeInViewport();
  await expect(actions.getByLabel("修改意见")).toHaveValue("补充验证结果");
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("review-scrolled.png") });
});

for (const width of [320, 390, 768, 1280, 1440, 1920]) {
  test(`plugin, task and review workspaces retain their actions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = await setup(page, "/admin/plugin-logs");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    await expect(navigation.getByRole("link")).toHaveCount(8);
    await expect(
      navigation.getByRole("link", { name: "插件状态与日志" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByText("上传超时，贡献已保留", { exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`plugins-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: /成员 7 研发工作设备 7/ }).click();
    await expect(page.locator(".plugin-log-summary")).toContainText("成员 7");
    await page.getByRole("button", { name: "仅看问题" }).click();
    await expect(page.getByText("开始上传贡献", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("上传超时，贡献已保留", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "模型分析", exact: true }).click();
    await expect
      .poll(() => calls.find((c) => c.path.endsWith("/plugin-logs/analyze"))?.body)
      .toEqual({ pluginInstanceId: "plugin-7", executionId: "execution-1" });
    await page.getByRole("button", { name: "历史日志", exact: true }).click();
    await expect(page.getByLabel("历史日志日期")).toBeVisible();
    await page.getByRole("button", { name: "权限备份", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "权限备份预览" }),
    ).toBeVisible();
    await expect(page.getByText("还没有权限备份")).toBeVisible();
    await noOverflow(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page.getByTitle("恢复 成员 7 的监控状态", { exact: true }).click();
    await expect
      .poll(() =>
        calls.some(
          (c) => c.path.endsWith("/plugin-7/recover") && c.method === "POST",
        ),
      )
      .toBe(true);

    await navigation
      .getByRole("link", { name: "异常任务处理", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "异常任务处理", exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "异常任务处理" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      navigation.getByRole("link", { name: "项目进展" }),
    ).not.toHaveAttribute("aria-current");
    await expect(page.getByRole("button", { name: "手动重试" })).toBeVisible();
    await noOverflow(page);
    expect(
      await page
        .locator(".agent-job-detail")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`jobs-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "手动重试" }).click();
    await expect(page.getByText("任务已重新入队，等待执行。")).toBeVisible();
    expect(
      calls.some(
        (c) =>
          c.path === "/v1/admin/agent-jobs/job-1/retry" && c.method === "POST",
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "清除异常", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "清除异常任务" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认清除" }).click();
    await expect(
      page.getByText("异常任务已清除，任务记录已保留。"),
    ).toBeVisible();
    expect(
      calls.some(
        (c) =>
          c.path === "/v1/admin/agent-jobs/job-1/clear" && c.method === "POST",
      ),
    ).toBe(true);

    await page.goto("/partner/review/review-1");
    await expect(
      page.getByRole("heading", { name: "项目工作卡片" }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "工作卡审核" }),
    ).toHaveAttribute("aria-current", "page");
    await noOverflow(page);
    expect(
      await page
        .locator(".project-review-actions")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`review-${width}.png`),
      fullPage: true,
    });
    await page.getByLabel("修改意见").fill("补充验证结果");
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await expect(page.getByLabel("修改意见")).toHaveValue("");
    expect(
      calls.find((c) => c.path.endsWith("/card-1/regenerate"))?.body,
    ).toEqual({ instruction: "补充验证结果", baseVersion: 6 });
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect
      .poll(() =>
        calls
          .filter((c) => c.path.endsWith("/card-1/decision"))
          .map((c) => c.body),
      )
      .toContainEqual({ decision: "approve", baseVersion: 6 });
    await page.getByRole("button", { name: "拒绝并忽略", exact: true }).click();
    await expect
      .poll(() =>
        calls
          .filter((c) => c.path.endsWith("/card-1/decision"))
          .map((c) => c.body),
      )
      .toContainEqual({ decision: "exclude", baseVersion: 6 });
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`reviews work directly without project status selection at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const calls = await setup(page, "/partner/review/review-1");
    await expect(page.getByRole("group", { name: "选择项目状态" })).toHaveCount(
      0,
    );
    await expect(page.getByLabel("当前项目状态", { exact: true })).toHaveCount(
      0,
    );
    await noOverflow(page);
    await page
      .getByRole("complementary", { name: "工作卡审核操作" })
      .screenshot({ path: testInfo.outputPath(`work-review-${width}.png`) });
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect
      .poll(() => calls.find((call) => call.path.endsWith("/decision"))?.body)
      .toEqual({ decision: "approve", baseVersion: 6 });
    expect(
      calls.filter((call) => call.path.endsWith("/project-status")),
    ).toHaveLength(0);
  });
}
