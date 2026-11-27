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
    if (url.pathname === "/v1/admin/user-logs")
      return send({
        checkedAt: date,
        onlineWindowMinutes: 5,
        windowHours: 24,
        members: [],
      });
    if (url.pathname === "/v1/admin/system-monitoring")
      return send({
        checkedAt: date,
        overallSeverity: "normal",
        summary: {
          componentCount: 0,
          normal: 0,
          warning: 0,
          critical: 0,
          openIncidents: 0,
        },
        components: [],
        incidents: [],
        worker: null,
      });
    if (url.pathname === "/v1/admin/system-logs")
      return send({
        window: {
          mode: "recent",
          date: null,
          timezone: "Asia/Shanghai",
          startedAt: date,
          endedAt: date,
        },
        worker: null,
        selectedExecutionId: null,
        executions: [],
        events: [],
        modelAnalysis: null,
      });
    if (url.pathname === "/v1/admin/inspection")
      return send({
        checkedAt: date,
        running: false,
        modelConfigured: true,
        lastRun: null,
        summary: {
          open: {
            app: { warning: 0, critical: 0 },
            system: { warning: 0, critical: 0 },
            pipeline: { warning: 0, critical: 0 },
          },
          openTotal: 0,
          resolvedTotal: 0,
        },
        members: [],
        findings: [],
      });
    if (url.pathname === "/v1/reviews/review-1")
      return send({
        review: {
          id: "review-1",
          state: "IN_PROGRESS",
          version: reviewVersion,
        },
        period: {
          periodKey: "2026-W37",
          startsAt: "2026-09-01T08:00:00.000Z",
          cutoffAt: "2026-09-08T08:00:00.000Z",
          autoApproveAt: "2099-01-04T04:00:00.000Z",
          publishAt: "2099-01-04T05:00:00.000Z",
          timezone: "Asia/Shanghai",
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
              currentFocus: "完成权限与上传验证",
              keyEvents: [
                {
                  date: "2026-09-06",
                  type: "blocker",
                  title: "上传权限规则未定",
                  detail: longReview
                    ? "跨团队上传是否放开没有结论。".repeat(20)
                    : "跨团队上传是否放开没有结论。",
                  neededSupport: "决定是否放开跨团队上传",
                },
              ],
              resolvedBlockers: [
                {
                  title: "项目成员范围不明确",
                  resolvedOn: "2026-09-05",
                  evidence: "已确认按团队范围校验",
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
    await setup(page, "/admin/inspection");
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
      const logs = navigation.getByRole("link", {
        name: "系统日志",
        exact: true,
      });
      await expect(logs).toHaveAttribute("title", "系统日志");
      await logs.click();
      await expect(logs).toHaveAttribute("aria-current", "page");
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

test("the monitoring group has exactly three pages and old routes redirect", async ({
  page,
}) => {
  await setup(page, "/admin/jobs");
  await expect(page).toHaveURL(/\/admin\/inspection$/);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const group = navigation
    .locator(".nav-group")
    .filter({ hasText: "监控与排障" });
  await expect(group.getByRole("link")).toHaveText([
    "用户日志",
    "系统日志",
    "异常巡检",
  ]);
  await expect(
    navigation.getByRole("link", { name: "异常巡检", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goto("/admin/system-monitoring");
  await expect(page).toHaveURL(/\/admin\/system-logs$/);
  await expect(
    page.getByRole("heading", { name: "系统日志", exact: true }),
  ).toBeVisible();
});

test("the review card shows summary, focus and blockers, with the deadline banner", async ({
  page,
}, testInfo) => {
  await setup(page, "/partner/review/review-1", true);
  const banner = page.locator(".rv-deadline");
  await expect(banner).toContainText("出现在面板上");
  await expect(banner).toContainText("前没有处理的卡片，会按当前内容自动通过");
  await expect(banner.locator(".rv-count")).toContainText("距自动通过");
  const card = page.locator(".rv-card").first();
  await expect(card.getByText("本周总结", { exact: true })).toBeVisible();
  await expect(card).toContainText("完成项目权限与贡献上传验证。");
  await expect(card.locator(".rv-focus")).toHaveText("完成权限与上传验证");
  const open = card.locator(".rv-blk:not(.is-resolved)");
  await expect(open).toContainText("上传权限规则未定");
  await expect(open).toContainText("本周新发现");
  await expect(open.locator(".rv-ask")).toContainText(
    "需要的支持决定是否放开跨团队上传",
  );
  const resolved = card.locator(".rv-blk.is-resolved");
  await expect(resolved).toContainText("上期遗留 · 本周已解决");
  await expect(resolved).toContainText("✓ 已确认按团队范围校验");
  await expect(page.getByText("每日进展")).toHaveCount(0);
  const actions = card.locator(".rv-review");
  await actions.getByLabel("修改意见").fill("这个不算卡点");
  await expect(
    actions.getByRole("button", { name: "按修改意见重新生成", exact: true }),
  ).toBeEnabled();
  await expect(
    actions.getByRole("button", { name: "拒绝", exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole("button", { name: "通过", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("review-card.png") });
});

for (const width of [320, 390, 768, 1280, 1440, 1920]) {
  test(`monitoring and review workspaces retain their actions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = await setup(page, "/admin/user-logs");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    await expect(navigation.getByRole("link")).toHaveCount(8);
    await expect(
      navigation.getByRole("link", { name: "用户日志", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "用户日志", exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`user-logs-${width}.png`),
      fullPage: true,
    });
    await navigation
      .getByRole("link", { name: "异常巡检", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "异常巡检", exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "异常巡检" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      navigation.getByRole("link", { name: "项目进展" }),
    ).not.toHaveAttribute("aria-current");
    await expect(page.getByRole("button", { name: "立即巡检" })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`inspection-${width}.png`),
      fullPage: true,
    });

    await page.goto("/partner/review/review-1");
    await expect(
      page.getByRole("heading", { name: "W37 工作卡 · 请审核" }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "工作卡审核" }),
    ).toHaveAttribute("aria-current", "page");
    await noOverflow(page);
    expect(
      await page
        .locator(".rv-acts")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`review-${width}.png`),
      fullPage: true,
    });
    await page.getByLabel("修改意见").fill("补充验证结果");
    await page
      .getByRole("button", { name: "按修改意见重新生成", exact: true })
      .click();
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
    await page.getByRole("button", { name: "拒绝", exact: true }).click();
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
      .locator(".rv-card")
      .first()
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
