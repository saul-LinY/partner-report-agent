import { expect, test, type Page } from "@playwright/test";
import {
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
        projectDescription:
          "面向研发团队的项目贡献采集与周报系统。支持成员确认工作卡片。",
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
        projectDescription: "为业务应用提供统一的数据查询服务。",
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
        contributionDays: 0,
        undatedCount: 1,
        conflictingDays: [],
        reviewId: null,
        lastUpdatedAt: "2026-09-08T07:00:00Z",
      },
    ].map((project) => ({
      ...project,
      firstContributionDate: project.days.length ? "2026-08-20" : null,
      lastContributionDate: project.days[0]?.date ?? null,
      currentFocus:
        project.projectId === "project-a"
          ? {
              text: "完成多项目贡献采集与异常恢复，验证跨项目的数据隔离，并补充接口超时、断线重试以及重复上传场景的测试，确保周报审核后的研发记录能够准确回溯。",
              periodKey: "业务周期 A",
              reviewId: "review-a",
            }
          : null,
      keyEvents:
        project.projectId === "project-a"
          ? [
              {
                date: "2026-09-07",
                type: "milestone",
                title: "完成多项目贡献采集接口",
                detail:
                  "打通贡献采集、异常恢复与周报审核链路。验证重复上传的去重逻辑，并补充跨项目隔离和接口超时场景的测试。",
                periodKey: "业务周期 A",
                reviewId: "review-a",
              },
              {
                date: "2026-09-03",
                type: "decision",
                title: "确定按审核日期统计研发天数",
                detail:
                  "采用已审核工作卡片中的每日进展作为日期依据，同一天的多条工作记录只计一天，避免把项目跨度误算成研发天数。",
                periodKey: "业务周期 A",
                reviewId: "review-a",
              },
            ]
          : [],
      aiEvidence: {
        sessionCount: 0,
        periodCount: 0,
        workCardCount: 0,
        lastAnalyzedAt: null,
      },
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
          projects: options.empty
            ? []
            : data.projects.map((project) => ({
                ...project,
                days: project.days.filter(
                  (day) =>
                    day.date >= (url.searchParams.get("from") ?? data.from) &&
                    day.date <= (url.searchParams.get("to") ?? data.to),
                ),
              })),
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
        const status = project.events
          .filter((event) => event.projectStatus)
          .at(-1);
        if (status?.projectStatus)
          project.currentStatus = {
            value: status.projectStatus,
            reason: status.reason,
            confirmedAt: `${today}T08:00:00Z`,
            periodKey: null,
            reviewId: null,
            source: "manual",
          };
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
  await expect(
    page.getByRole("heading", { name: "项目进展", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".overview-page .aw-header")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "运行总览", exact: true }),
  ).toHaveCount(0);
  return { data, writes, reads, options };
}

test("shows a familiar month calendar and actual daily achievements", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole("heading", { name: "项目进展" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "2026 年 9 月" }),
  ).toBeVisible();
  await expect(page.locator(".pc-month-grid > .pc-day")).toHaveCount(35);
  await expect(page.locator(".pc-project-choice")).toHaveCount(2);
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
  await expect(page.getByRole("dialog")).not.toContainText("优化数据查询");
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.getByRole("button", { name: "陈明", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 陈明 的 数据服务", exact: true })
    .click();
  await page
    .getByRole("button", { name: "数据服务 2026-09-07 的进展", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("优化数据查询");
  await expect(page.getByRole("dialog")).not.toContainText("完成贡献采集接口");
});

test("selects a person on the left and switches their projects at the top", async ({
  page,
}) => {
  const { data } = await setup(page);
  const people = page.getByRole("complementary", { name: "人员列表" });
  await expect(people.getByRole("button")).toHaveText(["陈明", "林安"]);
  await expect(people.locator(".pc-project-choice")).toHaveCount(0);
  await expect(
    people.getByRole("button", { name: "陈明", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const picker = page.getByRole("group", { name: "陈明的项目", exact: true });
  await expect(picker.getByRole("button")).toHaveText([
    "Partner Report",
    "数据服务",
  ]);
  await expect(
    page.getByRole("button", { name: /项目详情|设置状态|调整状态/ }),
  ).toHaveCount(0);
  await expect(page.locator(".pc-project-description")).toHaveText(
    data.projects[0]!.projectDescription!,
  );
  await expect(page.getByLabel("累计研发天数")).toHaveText("已开发 5 天");
  await expect(page.locator(".pc-project-title")).not.toContainText("陈明");
  await expect(
    page.locator(".pc-development-stats, .pc-development-bar"),
  ).toHaveCount(0);
  await picker
    .getByRole("button", { name: "查看 陈明 的 数据服务", exact: true })
    .click();
  await expect(
    picker.getByRole("button", { name: "查看 陈明 的 数据服务", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "当前项目进度" }).getByRole("heading"),
  ).toHaveText("数据服务");
  // Clicking the selected person and refreshing must preserve the project choice.
  await people.getByRole("button", { name: "陈明", exact: true }).click();
  data.projects[0]!.latestProgress!.date = today;
  await page.getByTitle("刷新项目进展").click();
  await expect(
    page.getByRole("region", { name: "当前项目进度" }).getByRole("heading"),
  ).toHaveText("数据服务");
  await people.getByRole("button", { name: "林安", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("group", { name: "林安的项目", exact: true })
      .getByRole("button"),
  ).toHaveText(["客户门户"]);
  await expect(
    page.getByRole("region", { name: "当前项目进度" }),
  ).toContainText("客户门户");
  await expect(picker).toHaveCount(0);
  await expect(
    people.getByRole("button", { name: "林安", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("keeps each person's work separate when the project names match", async ({
  page,
}) => {
  const { data } = await setup(page);
  data.projects[2]!.projectId = data.projects[0]!.projectId;
  data.projects[2]!.projectName = data.projects[0]!.projectName;
  data.projects[2]!.projectDescription = "林安负责的工作说明";
  await page.getByTitle("刷新项目进展").click();
  await page.getByRole("button", { name: "林安", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "林安的项目", exact: true })
      .getByRole("button"),
  ).toHaveText(["Partner Report"]);
  await expect(page.locator(".pc-project-description")).toHaveText(
    "林安负责的工作说明",
  );
  await expect(page.getByLabel("累计研发天数")).toContainText("0 天");
  await expect(page.locator(".pc-calendar-entry")).toHaveCount(0);
});

test("shows the complete description, focus and every event directly in the overview", async ({
  page,
}) => {
  const { data } = await setup(page);
  const project = data.projects[0]!;
  project.keyEvents.push(
    {
      ...project.keyEvents[0]!,
      title: "补齐自动恢复测试",
      detail: "补充异常场景，验证恢复后的数据一致性。",
    },
    {
      ...project.keyEvents[0]!,
      title: "确认历史数据迁移方案",
      detail: "保留历史审核结果和贡献日期，验证迁移完整性。",
    },
  );
  await page.getByTitle("刷新项目进展").click();
  const overview = page.getByRole("region", { name: "当前项目进度" });
  await expect(overview.locator(".pc-project-description")).toHaveText(
    project.projectDescription!,
  );
  await expect(overview.locator(".pc-latest")).toHaveText(
    project.currentFocus!.text,
  );
  await expect(
    overview.getByRole("button", {
      name: /项目详情|查看全文|查看全部|查看所有/,
    }),
  ).toHaveCount(0);
  await expect(overview.locator("details")).toHaveCount(0);
  await expect(overview.locator(".pc-key-event")).toHaveCount(4);
  for (const event of project.keyEvents) {
    await expect(
      overview.getByText(event.title, { exact: true }),
    ).toBeVisible();
    await expect(
      overview.getByText(event.detail, { exact: true }),
    ).toBeVisible();
  }
  await expect(overview).toContainText("同一天多条记录计 1 天");
});

test("selects a member's project without inventing dates when no dated work exists", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "林安", exact: true }).click();
  await expect(page.locator(".pc-project-choice.selected")).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "当前项目进度" }),
  ).toContainText("客户门户");
  await expect(page.getByLabel("累计研发天数")).toHaveText("已开发 0 天");
  await expect(page.locator(".pc-calendar-entry")).toHaveCount(0);
});

test("switches calendar months and filters by member without hiding latest project progress", async ({
  page,
}) => {
  const { reads } = await setup(page);
  await page.getByRole("button", { name: "陈明", exact: true }).click();
  await expect(page.locator(".pc-project-choice")).toHaveCount(2);
  await page.getByRole("button", { name: "上个月" }).click();
  await expect(
    page.getByRole("heading", { name: "2026 年 8 月" }),
  ).toBeVisible();
  expect(reads.at(-1)).toBe("?from=2026-08-01&to=2026-08-31");
  await expect(page.getByLabel("累计研发天数")).toHaveText("已开发 5 天");
  await expect(page.locator(".pc-project-description")).toContainText(
    "面向研发团队的项目贡献采集与周报系统。",
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
  await page.getByTitle("刷新项目进展").click();
  await expect(
    page.getByText("暂无已审核的项目进展", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pc-calendar")).toHaveCount(0);
  options.empty = false;
  data.projects[0]!.currentFocus = null;
  data.projects[0]!.latestProgress!.summary = "本日完成上线验证";
  await page.getByTitle("刷新项目进展").click();
  await expect(page.locator(".pc-project-choice")).toHaveCount(2);
  await expect(page.locator(".pc-project-description")).toContainText(
    "面向研发团队的项目贡献采集与周报系统。",
  );
  await page.getByRole("button", { name: "陈明", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 陈明 的 Partner Report", exact: true })
    .click();
  await expect(page.locator(".pc-latest")).toContainText("本日完成上线验证");
});

for (const width of [390, 768, 1440]) {
  test(`keeps people and project choices fixed while content scrolls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    const content = page.getByRole("region", { name: "项目内容", exact: true });
    const people = page.getByRole("complementary", { name: "人员列表" });
    const picker = page.getByRole("group", { name: "陈明的项目", exact: true });
    await expect(content).toBeVisible();
    await page
      .locator(".aw-operations-view")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    const peopleBefore = await people.boundingBox();
    const pickerBefore = await picker.boundingBox();
    const windowBefore = await page.evaluate(() => window.scrollY);
    await content.hover();
    await page.mouse.wheel(0, 450);
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100);
    expect(await people.boundingBox()).toEqual(peopleBefore);
    expect(await picker.boundingBox()).toEqual(pickerBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(windowBefore);

    // Reaching the bottom must not pass scrolling to the page or hide navigation.
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.locator(".pc-day").last()).toBeInViewport();
    await page.mouse.wheel(0, 500);
    await page.mouse.wheel(0, 500);
    expect(await people.boundingBox()).toEqual(peopleBefore);
    expect(await picker.boundingBox()).toEqual(pickerBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(windowBefore);

    await picker
      .getByRole("button", { name: "查看 陈明 的 数据服务", exact: true })
      .click();
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBe(0);
    await expect(
      content.getByRole("heading", { name: "数据服务", exact: true }),
    ).toBeInViewport();
    await content.focus();
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await people.getByRole("button", { name: "林安", exact: true }).click();
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBe(0);
    await expect(
      content.getByRole("heading", { name: "客户门户", exact: true }),
    ).toBeInViewport();
  });

  test(`calendar and member project selection fit ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await expect(page.locator(".pc-project-choice")).toHaveCount(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`calendar-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "陈明", exact: true }).click();
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
}
