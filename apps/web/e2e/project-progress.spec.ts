import { expect, test, type Page } from "@playwright/test";
import {
  addProgressDays,
  calculateProgress,
  type ProgressEvent,
  type ProjectProgressResponse,
} from "@partner-report/contracts/project-progress";
const today = "2026-09-08";
function fixture(): ProjectProgressResponse {
  return {
    today,
    timezone: "Asia/Shanghai",
    from: "2026-09-01",
    to: today,
    generatedAt: "2026-09-08T08:00:00Z",
    members: [
      { id: "member-a", name: "陈明", status: "active", contributionDays: 6 },
      { id: "member-b", name: "林安", status: "active", contributionDays: 1 },
    ],
    projects: [
      {
        partnerId: "member-a",
        projectId: "project-a",
        projectName: "Partner Report",
        version: 1,
        events: [
          { date: "2026-09-01", type: "start", reason: "确认启动" },
          { date: "2026-09-04", type: "pause", reason: "支援客户上线" },
          { date: "2026-09-07", type: "resume", reason: "支援结束" },
        ],
        days: [
          {
            date: "2026-09-07",
            entries: [
              {
                id: "d1",
                summary: "完成贡献采集接口与异常恢复，支持多项目同时采集。",
                source: "reviewed",
                reviewId: "review-a",
                periodKey: "业务周期 A",
              },
            ],
          },
        ],
        contributionDays: 5,
        undatedCount: 0,
        conflictingDays: [],
        reviewId: "review-a",
        lastUpdatedAt: "2026-09-08T07:00:00Z",
      },
      {
        partnerId: "member-a",
        projectId: "project-b",
        projectName: "数据服务",
        version: 1,
        events: [{ date: "2026-09-03", type: "start", reason: "并行推进" }],
        days: [
          {
            date: "2026-09-07",
            entries: [
              {
                id: "d2",
                summary: "优化数据查询，处理接口超时问题。",
                source: "reviewed",
                reviewId: "review-a",
                periodKey: "业务周期 A",
              },
            ],
          },
        ],
        contributionDays: 3,
        undatedCount: 0,
        conflictingDays: [],
        reviewId: null,
        lastUpdatedAt: "2026-09-08T07:00:00Z",
      },
      {
        partnerId: "member-b",
        projectId: "project-c",
        projectName: "客户门户",
        version: 0,
        events: [],
        days: [],
        contributionDays: 1,
        undatedCount: 1,
        conflictingDays: [],
        reviewId: null,
        lastUpdatedAt: "2026-09-08T07:00:00Z",
      },
    ].map((project) => ({
      ...project,
      latestProgress: project.days[0]
        ? {
            date: project.days[0].date,
            summary: project.days[0].entries[0]!.summary,
            source: project.days[0].entries[0]!.source,
          }
        : null,
      events: project.events as ProgressEvent[],
      metrics: calculateProgress(project.events as ProgressEvent[], today),
    })) as ProjectProgressResponse["projects"],
  };
}
async function setup(
  page: Page,
  options: { fail?: boolean; empty?: boolean; conflict?: boolean } = {},
) {
  const data = fixture();
  const writes: any[] = [];
  const reads: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/v1/me")
      return route.fulfill({
        json: {
          userId: "admin",
          roles: ["admin"],
          displayName: "管理员",
          email: "admin@test.local",
          teamName: "测试团队",
        },
      });
    if (url.pathname === "/v1/admin/overview")
      return route.fulfill({
        json: {
          team: { name: "测试团队", period_rule: {} },
          partners: [],
          connections: [],
          periods: [],
          bindingCodes: [],
          reviewQueue: [],
          jobs: [],
        },
      });
    if (url.pathname === "/v1/admin/project-progress") {
      reads.push(url.search);
      if (options.fail)
        return route.fulfill({
          status: 503,
          json: { code: "UNAVAILABLE", message: "项目进展暂时不可用" },
        });
      return route.fulfill({
        json: {
          ...data,
          from: url.searchParams.get("from") ?? data.from,
          to: url.searchParams.get("to") ?? data.to,
          projects: options.empty ? [] : data.projects,
          members: options.empty ? [] : data.members,
        },
      });
    }
    if (url.pathname.startsWith("/v1/project-progress/participations/")) {
      const project = data.projects.find((p) =>
        url.pathname.endsWith(`/${p.partnerId}/${p.projectId}`),
      )!;
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        writes.push(input);
        if (options.conflict)
          return route.fulfill({
            status: 409,
            json: {
              code: "VERSION_CONFLICT",
              message:
                "时间记录已被其他人修改，请重新载入后核查；当前草稿未覆盖服务器记录。",
            },
          });
        project.version++;
        project.events = input.events;
        project.metrics = calculateProgress(project.events, today);
        return route.fulfill({
          json: { version: project.version, events: project.events },
        });
      }
      return route.fulfill({
        json: {
          version: project.version,
          events: project.events,
          today,
          timezone: data.timezone,
          history: [],
        },
      });
    }
    if (url.pathname === "/v1/reviews/review-a")
      return route.fulfill({
        json: {
          review: {
            id: "review-a",
            partner_id: "member-a",
            partner_name: "陈明",
            period_key: "业务周期 A",
            state: "COMPLETED",
            version: 1,
          },
          items: [
            {
              id: "card",
              project_id: "project-a",
              project_name: "Partner Report",
              review_status: "approved",
              status: "completed",
              payload: {
                overview: "周卡摘要",
                dailyProgress: [
                  { date: "2026-09-07", summary: "完成采集接口" },
                ],
              },
            },
          ],
          regenerationJobs: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { message: "Unexpected request" },
    });
  });
  await page.goto("/admin");
  await expect(page.getByRole("tab", { name: "项目进展" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return { data, writes, reads, options };
}

test("shows a familiar month calendar and actual daily achievements", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole("heading", { name: "项目日历" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "2026 年 9 月" }),
  ).toBeVisible();
  await expect(page.locator(".pc-month-grid > .pc-day")).toHaveCount(35);
  await expect(page.locator(".pc-project")).toHaveCount(3);
  await expect(
    page.locator(".pp-overview-stats, .pp-legend, .pp-chart"),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增人员" })).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Partner Report 2026-09-07 的进展",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "完成贡献采集接口与异常恢复",
  );
  await expect(page.getByRole("dialog")).toContainText("优化数据查询");
});

test("sets the overall stage while preserving the project time history", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page
    .getByRole("button", { name: "查看 陈明 的 Partner Report", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "当前项目进度" }),
  ).toContainText("完成贡献采集接口");
  await page.getByRole("button", { name: "设置阶段" }).click();
  await page.getByLabel("当前阶段", { exact: true }).selectOption("validation");
  await page.getByLabel("最近完成了什么").fill("核心功能完成，正在联调");
  await page.getByRole("button", { name: "保存阶段" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "当前项目进度" }),
  ).toContainText("当前：联调测试");
  await expect(page.locator('.pc-stages [aria-current="step"]')).toHaveText(
    "3联调测试",
  );
  expect(writes[0].events).toHaveLength(4);
  expect(writes[0].events.at(-1)).toMatchObject({
    stage: "validation",
    type: "milestone",
    reason: "核心功能完成，正在联调",
  });
  await page.getByRole("button", { name: "项目详情" }).click();
  await expect(page.getByRole("dialog")).toContainText("8 天");
  await expect(page.getByRole("dialog")).toContainText("3 天");
});

test("keeps the stage draft on a concurrent update", async ({ page }) => {
  await setup(page, { conflict: true });
  await page.getByRole("button", { name: "查看 林安 的 客户门户" }).click();
  await page.getByRole("button", { name: "设置阶段" }).click();
  await page.getByLabel("最近完成了什么").fill("已完成需求确认");
  await page.getByRole("button", { name: "保存阶段" }).click();
  await expect(page.getByRole("alert")).toContainText("已被其他人修改");
  await expect(page.getByLabel("最近完成了什么")).toHaveValue("已完成需求确认");
});

test("switches calendar months and filters by member without hiding latest project progress", async ({
  page,
}) => {
  const { reads } = await setup(page);
  await page.getByLabel("成员", { exact: true }).selectOption("member-a");
  await expect(page.locator(".pc-project")).toHaveCount(2);
  await page.getByRole("button", { name: "上个月" }).click();
  await expect(
    page.getByRole("heading", { name: "2026 年 8 月" }),
  ).toBeVisible();
  expect(reads.at(-1)).toBe("?from=2026-08-01&to=2026-08-31");
  await expect(page.locator(".pc-project-summary").first()).toContainText(
    "完成贡献采集接口",
  );
  await page.getByRole("button", { name: "本月", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "2026 年 9 月" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "下个月" })).toBeDisabled();
});

test("keeps weekly review and time editing accessible inside details", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page
    .getByRole("button", {
      name: "Partner Report 2026-09-07 的进展",
      exact: true,
    })
    .click();
  await page
    .locator(".pc-day-detail")
    .filter({
      has: page.getByRole("heading", { name: "Partner Report", exact: true }),
    })
    .getByRole("button", { name: "查看周卡", exact: true })
    .click();
  await expect(page).toHaveURL(/\/partner\/review\/review-a$/);
  await page.getByRole("button", { name: "核查时间" }).click();
  await page.getByLabel("本次核查说明").fill("确认本周时间无调整");
  await page.getByRole("button", { name: "保存核查" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes[0].reviewId).toBe("review-a");
});

test("refreshes new progress and recovers from unavailable data", async ({
  page,
}) => {
  const options = { fail: true, empty: false };
  const { data } = await setup(page, options);
  await expect(page.getByRole("alert")).toContainText("暂时不可用");
  options.fail = false;
  options.empty = true;
  await page.getByTitle("刷新运行总览").click();
  await expect(
    page.getByText("暂无已审核的项目进展", { exact: true }),
  ).toBeVisible();
  options.empty = false;
  data.projects[0]!.latestProgress!.summary = "本日完成上线验证";
  await page.getByTitle("刷新运行总览").click();
  await expect(page.locator(".pc-project")).toHaveCount(3);
  await expect(
    page.getByText("本日完成上线验证", { exact: true }),
  ).toBeVisible();
});

for (const width of [390, 768, 1440])
  test(`calendar and project stages fit ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await expect(page.locator(".pc-project")).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`calendar-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "查看 陈明 的 Partner Report", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "当前项目进度" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`project-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
