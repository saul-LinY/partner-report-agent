import { expect, test, type Page } from "@playwright/test";
import {
  calculateProgress,
  type ProgressEvent,
  type ProjectProgressResponse,
} from "@partner-report/contracts/project-progress";
import type { LeadershipSnapshot } from "@partner-report/contracts/leadership";
// The panel shows one published snapshot; "today" is the cutoff's local date.
const today = "2026-09-08";
const timezone = "Asia/Shanghai";

function progressFixture(): ProjectProgressResponse {
  return {
    today,
    timezone,
    from: "2026-09-01",
    to: today,
    generatedAt: "2026-09-09T05:00:00Z",
    members: [
      { id: "member-a", name: "陈明", status: "active", contributionDays: 6 },
      { id: "member-b", name: "林安", status: "active", contributionDays: 1 },
    ],
    projects: [
      {
        partnerId: "member-a",
        projectId: "project-a",
        projectName: "Partner Report",
        projectDescription: "面向研发团队的项目贡献采集与周报系统。",
        version: 1,
        events: [{ date: "2026-09-01", type: "start", reason: "确认启动" }],
        contributionDays: 5,
        currentFocus: {
          text: "完成多项目贡献采集",
          periodKey: "2026-W37",
          reviewId: "review-a",
        },
        keyEvents: [],
      },
      {
        partnerId: "member-a",
        projectId: "project-b",
        projectName: "数据服务",
        version: 1,
        events: [{ date: "2026-09-03", type: "start", reason: "并行推进" }],
        contributionDays: 3,
        currentFocus: {
          text: "梳理数据库迁移方案",
          periodKey: "2026-W37",
          reviewId: "review-a",
        },
        keyEvents: [
          {
            date: "2026-09-06",
            type: "blocker",
            title: "数据库迁移方案未定",
            detail: "迁移期间服务是否停机没有结论，上线时间无法确定。",
            neededSupport: "决定是否接受一小时停机迁移",
            periodKey: "2026-W37",
            reviewId: "review-a",
          },
        ],
      },
      {
        partnerId: "member-a",
        projectId: "project-d",
        projectName: "旧系统收尾",
        version: 1,
        events: [],
        contributionDays: 12,
        collectionStopped: true,
        currentFocus: {
          text: "服务停机收尾",
          periodKey: "2026-W36",
          reviewId: "review-old",
        },
        keyEvents: [],
      },
      {
        partnerId: "member-b",
        projectId: "project-c",
        projectName: "客户门户",
        version: 0,
        events: [],
        contributionDays: 0,
        currentFocus: null,
        keyEvents: [],
      },
    ].map((project) => ({
      days: [],
      undatedCount: 0,
      conflictingDays: [],
      reviewId: null,
      lastUpdatedAt: "2026-09-08T07:00:00Z",
      firstContributionDate: null,
      lastContributionDate: null,
      aiEvidence: {
        sessionCount: 0,
        periodCount: 0,
        workCardCount: 0,
        lastAnalyzedAt: null,
      },
      latestProgress: null,
      ...project,
      metrics: calculateProgress(project.events as ProgressEvent[], today),
    })) as unknown as ProjectProgressResponse["projects"],
  };
}

function snapshotFixture(): LeadershipSnapshot {
  return {
    schedule: {
      timezone,
      current: {
        periodKey: "2026-W37",
        startsAt: "2026-09-01T08:00:00.000Z",
        cutoffAt: "2026-09-08T08:00:00.000Z",
        publishedAt: "2026-09-09T05:00:00.000Z",
      },
      next: {
        periodKey: "2026-W38",
        startsAt: "2026-09-08T08:00:00.000Z",
        cutoffAt: "2026-09-15T08:00:00.000Z",
        autoApproveAt: "2026-09-18T04:00:00.000Z",
        publishAt: "2026-09-18T05:00:00.000Z",
        step: "reviewing",
      },
    },
    progress: progressFixture(),
    activity: {
      timezone,
      from: "2026-06-11",
      to: today,
      days: 90,
      totals: { dropped: 0 },
      daily: [],
      members: [
        {
          id: "member-a",
          name: "陈明",
          turns: 5,
          sessions: 2,
          activeDays: 2,
          byDay: { "2026-09-07": 2, "2026-09-08": 3 },
          byProject: {
            "Partner Report": {
              turns: 3,
              lastActiveDate: "2026-09-08",
              byDay: { "2026-09-07": 1, "2026-09-08": 2 },
            },
            数据服务: {
              turns: 2,
              lastActiveDate: "2026-09-08",
              byDay: { "2026-09-07": 1, "2026-09-08": 1 },
            },
          },
          events: [
            { t: "2026-09-07T10:15", p: "Partner Report" },
            { t: "2026-09-07T10:40", p: "数据服务" },
            { t: "2026-09-08T09:05", p: "Partner Report" },
            { t: "2026-09-08T09:30", p: "Partner Report" },
            { t: "2026-09-08T14:10", p: "数据服务" },
          ],
        },
      ],
    } as LeadershipSnapshot["activity"],
    profiles: [
      {
        id: "profile-a",
        partnerId: "member-a",
        projectName: "Partner Report",
        updatedAt: "2026-09-08T00:00:00Z",
        sessions: 3,
        failed: false,
        note: {
          oneLine: { text: "让团队写周报更省事的小工具", refs: ["S1T1"] },
          intro: {
            text: "成员每周把工作交给 AI 整理，leader直接读到清楚的进展。",
            refs: ["S1T1"],
          },
          features: [{ text: "一键汇总每周工作", refs: ["S1T2"] }],
          status: { text: "", refs: [] },
          openIssues: [{ text: "成员是否愿意每周使用还没验证", refs: ["S1T3"] }],
        },
      },
    ] as LeadershipSnapshot["profiles"],
    reviews: [
      {
        partnerId: "member-a",
        approvedBy: "member",
        approvedAt: "2026-09-08T10:00:00.000Z",
      },
      { partnerId: "member-b", approvedBy: "auto", approvedAt: null },
    ],
  };
}

async function setup(
  page: Page,
  options: {
    member?: string;
    path?: string;
    fail?: boolean;
    edit?: (snapshot: LeadershipSnapshot) => void;
  } = {},
) {
  const snapshot = snapshotFixture();
  options.edit?.(snapshot);
  const writes: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  const project = snapshot.progress!.projects[0]!;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    paths.push(url.pathname);
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
    if (url.pathname === "/v1/admin/leadership-snapshot") {
      if (options.fail)
        return route.fulfill({
          status: 503,
          json: { code: "UNAVAILABLE", message: "面板暂时不可用" },
        });
      return route.fulfill({ json: snapshot });
    }
    if (url.pathname.startsWith("/v1/project-progress/participations/")) {
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        writes.push(input);
        return route.fulfill({
          json: { version: project.version + 1, events: input.events },
        });
      }
      return route.fulfill({
        json: {
          version: project.version,
          events: project.events,
          today,
          timezone,
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
            state: "IN_PROGRESS",
            version: 1,
          },
          period: null,
          items: [
            {
              id: "card",
              title: "Partner Report",
              project_id: "project-a",
              project_name: "Partner Report",
              review_status: "pending",
              status: "in_progress",
              payload: { overview: "周卡摘要", currentFocus: "完成采集接口" },
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
  await page.goto(options.path ?? `/admin/members/${options.member ?? "member-a"}`);
  return { snapshot, writes, paths };
}

test("the member page opens on the published update bar with the next update steps", async ({
  page,
}) => {
  const { paths } = await setup(page);
  const bar = page.getByRole("region", { name: "数据更新" });
  await expect(bar).toContainText("W37 · 9月1日 16:00 – 9月8日 16:00");
  // How each item was confirmed is shown on the item itself, not in the bar.
  await expect(page.locator(".lb-source").first()).toContainText("陈明 已于 9月8日审核确认");
  await expect(bar).toContainText(
    "9月18日（周五）13:00 更新为 W38（9月8日 16:00 – 9月15日 16:00）",
  );
  const steps = bar.getByRole("list", { name: "W38 更新进度" }).getByRole("listitem");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("采集本周会话");
  await expect(steps.nth(1)).toContainText("发放审核卡");
  await expect(steps.nth(2)).toContainText("成员审核");
  await expect(steps.nth(2)).toContainText("9月18日 12:00 前，逾期自动通过");
  await expect(steps.nth(3)).toContainText("面板更新");
  await expect(bar.locator("li.is-on")).toHaveText(/成员审核/);
  await expect(page.getByText("每分钟自动刷新")).toHaveCount(0);
  // The page reads only the published snapshot, never the live endpoints.
  await expect.poll(() => paths).toContain("/v1/admin/leadership-snapshot");
  expect(paths).not.toContain("/v1/admin/project-progress");
  expect(paths).not.toContain("/v1/admin/ai-activity");
  expect(paths).not.toContain("/v1/admin/project-profiles");
});

test("states the verdict, then the blockers, then the moving projects; stalled ones wait in a dialog", async ({
  page,
}) => {
  await setup(page);
  const verdict = page.getByRole("region", { name: "整体结论" });
  await expect(verdict).toContainText("2 个在推进的项目中");
  await expect(verdict).toContainText("1 个正常推进");
  await expect(verdict).toContainText("1 个有卡点需要你拍板");
  await expect(verdict.locator(".lb-strip span")).toHaveCount(2);

  const issues = page.locator(".lb-issue");
  await expect(issues).toHaveCount(1);
  const blocked = issues.nth(0);
  await expect(blocked).toContainText("有卡点");
  await expect(blocked).toContainText("数据服务");
  await expect(blocked).toContainText("数据库迁移方案未定");
  await expect(blocked).toContainText("迁移期间服务是否停机没有结论");
  await expect(blocked.locator(".lb-ask")).toContainText(
    "需要你决定是否接受一小时停机迁移",
  );
  await expect(blocked).toContainText("9月6日出现 · 截至本期已持续 2 天");
  await expect(blocked).toContainText(
    "来源：W37 工作卡 · 陈明 已于 9月8日审核确认",
  );

  // Projects are always open: no folding, no stage bars, blocked first; the stalled one is not on the page.
  const cards = page.locator(".lb-pcard");
  await expect(cards.locator(".lb-name")).toHaveText(["数据服务", "Partner Report"]);
  await expect(page.locator("details, .lc-stage-bar")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /展开|收起/ }),
  ).toHaveCount(0);
  await expect(page.locator(".lb-verdict p, .lb-attn, .lb-pgrid").getByText("旧系统收尾")).toHaveCount(0);

  await verdict.getByRole("button", { name: "停滞 1 个" }).click();
  const dialog = page.getByRole("dialog", { name: "停滞与搁置的项目" });
  await expect(dialog.locator("li")).toHaveCount(1);
  await expect(dialog).toContainText("旧系统收尾");
  await expect(dialog).toContainText("已停止采集");
  await expect(dialog).toContainText("最后在做：服务停机收尾");
});

test("lists only blockers from the latest work card, not older open ones", async ({
  page,
}) => {
  await setup(page, {
    edit: (snapshot) => {
      snapshot.progress!.projects[1]!.keyEvents.push({
        date: "2026-08-25",
        type: "blocker",
        title: "上上周的老卡点",
        detail: "",
        step: null,
        periodKey: "2026-W36",
        reviewId: "review-old",
      });
    },
  });
  const blockers = page.locator(".lb-issue.is-block");
  await expect(blockers).toHaveCount(1);
  await expect(blockers).toContainText("数据库迁移方案未定");
  await expect(page.getByText("上上周的老卡点")).toHaveCount(0);
});

test("shows a blocker resolved on the latest card, hides older ones, and shelves a long-idle project", async ({
  page,
}) => {
  await setup(page, {
    edit: (snapshot) => {
      const report = snapshot.progress!.projects[0]!;
      report.keyEvents = [
        {
          date: "2026-09-02",
          type: "blocker",
          title: "接口权限没开",
          detail: "",
          step: null,
          periodKey: "2026-W37",
          reviewId: "review-a",
          resolvedOn: "2026-09-05",
          resolvedBy: "model",
          resolvedEvidence: "运维已开通读权限",
        },
        {
          date: "2026-08-28",
          type: "blocker",
          title: "上期已解决的卡点",
          detail: "",
          step: null,
          periodKey: "2026-W36",
          reviewId: "review-old",
          resolvedOn: "2026-09-05",
        },
      ];
      // 30 days idle with a blocker still open: shelved, not on the attention list.
      snapshot.activity!.members[0]!.byProject["数据服务"]!.lastActiveDate =
        "2026-08-09";
    },
  });
  const done = page.locator(".lb-issue.is-done");
  await expect(done).toHaveCount(1);
  await expect(done.locator(".lb-pill")).toHaveText("已解决");
  await expect(done).toContainText("接口权限没开");
  await expect(done).toContainText("运维已开通读权限");
  await expect(page.getByText("上期已解决的卡点")).toHaveCount(0);

  await expect(page.locator(".lb-issue", { hasText: "数据服务" })).toHaveCount(0);
  await expect(page.locator(".lb-pcard", { hasText: "数据服务" })).toHaveCount(0);
  await page.getByRole("button", { name: "停滞 1 个 · 已搁置 1 个" }).click();
  const shelved = page.getByRole("dialog").locator("li", { hasText: "数据服务" });
  await expect(shelved.locator(".lb-pill")).toHaveText("已搁置");
});

test("shows each project's focus, plain-language profile and unverified risks", async ({
  page,
}) => {
  // An older focus names its card: make the wind-down project active again so it shows on the page.
  await setup(page, {
    edit: (snapshot) => {
      snapshot.progress!.projects[2]!.collectionStopped = false;
      snapshot.activity!.members[0]!.byProject["旧系统收尾"] = {
        turns: 1,
        lastActiveDate: "2026-09-08",
        byDay: {},
      };
    },
  });
  const card = page.locator(".lb-pcard", { hasText: "Partner Report" });
  await expect(card.locator(".lb-pill")).toHaveCount(0);
  await expect(card.locator(".lb-what")).toHaveText("让团队写周报更省事的小工具");
  await expect(card.locator(".lb-now")).toContainText("当前重点完成多项目贡献采集");
  await expect(card.locator(".lb-now small")).toHaveCount(0);
  await expect(card).toContainText("成员每周把工作交给 AI 整理");
  await expect(card).toContainText("已开发5 天");
  await expect(card.getByText("一键汇总每周工作")).toBeVisible();
  await expect(card.locator(".lb-risk")).toContainText("成员是否愿意每周使用还没验证");
  await expect(card.locator(".lb-risk")).toContainText(
    "风险是还没验证的假设，不等于卡点。",
  );
  // A project without a profile shows no empty placeholders.
  const bare = page.locator(".lb-pcard", { hasText: "旧系统收尾" });
  await expect(bare.locator(".lb-what, .lb-risk")).toHaveCount(0);
  await expect(bare.getByRole("heading", { name: "主要功能" })).toHaveCount(0);
  await expect(bare.locator(".lb-now")).toContainText("沿用 W36 工作卡");
});

test("sums up the work input and charts AI interactions by hour and by month", async ({
  page,
}) => {
  await setup(page);
  const stats = page.locator(".lb-stats");
  await expect(stats).toContainText("近 28 天活跃2 天");
  await expect(stats).toContainText("最近活跃9月8日");
  await expect(stats).toContainText("近 28 天交互5 轮");
  await expect(stats).toContainText("（截至 9月8日 16:00 的近 28 天）");
  await expect(stats.locator(".lb-share-labels")).toContainText("Partner Report 60%");
  await expect(stats.locator(".lb-share-labels")).toContainText("数据服务 40%");

  const panel = page.locator(".lc-panel", { hasText: "会话活跃度" });
  await expect(panel.getByRole("heading")).toHaveText("2026年9月8日 会话活跃度");
  await expect(panel.locator(".lc-axis-title")).toHaveText([
    "时间（小时）",
    "交互轮数（轮）",
  ]);
  await expect(panel).toContainText("数据截至 9月8日 16:00，每周一 13:00 随面板更新。");
  // With several projects an extra "总计" line adds them up: 9:00 has two Partner Report turns and none elsewhere.
  await expect(panel.getByRole("button", { name: "总计" })).toBeVisible();
  const svg = panel.locator("svg");
  const box = (await svg.boundingBox())!;
  await svg.hover({
    position: {
      x: box.width * ((52 + 9 * ((720 - 52 - 12) / 23)) / 720),
      y: box.height / 2,
    },
  });
  // A project with no turns in the viewed range (the stalled 旧系统收尾) gets no line.
  await expect(panel.getByRole("button", { name: "旧系统收尾" })).toHaveCount(0);
  await expect(panel.locator(".lc-tip")).toContainText(
    "9:00–9:59 · 数据服务 0 · Partner Report 2 · 总计 2",
  );
  await panel.getByRole("button", { name: "按月看" }).click();
  await expect(panel.getByRole("heading")).toHaveText("2026年9月 会话活跃度");
  await expect(panel.locator(".lc-axis-title")).toHaveText([
    "日期（日）",
    "交互轮数（轮）",
  ]);
  await expect(panel.getByRole("button", { name: "上一月" })).toBeEnabled();
  // A legend entry hides that project's line.
  await expect(panel.locator("svg polyline")).toHaveCount(3);
  await panel.getByRole("button", { name: "数据服务" }).click();
  await expect(panel.locator("svg polyline")).toHaveCount(2);
  await panel.getByRole("button", { name: "按天看" }).click();
  await expect(panel.getByRole("heading")).toHaveText("2026年9月8日 会话活跃度");
});

test("a member whose only project has no activity has it in the stalled dialog, not on the page", async ({
  page,
}) => {
  await setup(page, { member: "member-b" });
  const verdict = page.getByRole("region", { name: "整体结论" });
  await expect(verdict).toContainText("林安 本期没有在推进的项目");
  await expect(page.locator(".lb-issue, .lb-pcard")).toHaveCount(0);
  await verdict.getByRole("button", { name: "停滞 1 个" }).click();
  await expect(page.getByRole("dialog")).toContainText("客户门户");
});

test("recovers from an unavailable panel", async ({ page }) => {
  await setup(page, { fail: true });
  await expect(page.getByRole("alert")).toContainText("暂时不可用");
  await expect(page.locator(".lb-pcard")).toHaveCount(0);
});

test("项目进展 opens the first member and switches members from the name list", async ({
  page,
}) => {
  await setup(page, { path: "/admin" });
  const names = page.getByRole("navigation", { name: "成员" }).getByRole("link");
  await expect(names).toHaveText(["陈明3", "林安1"]);
  await expect(names.first()).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".lb-pcard .lb-name")).toHaveText(["数据服务", "Partner Report"]);
  await names.filter({ hasText: "林安" }).click();
  await expect(page).toHaveURL(/\/admin\/members\/member-b$/);
  await expect(names.nth(1)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "整体结论" })).toContainText("林安");
});

test("keeps time editing accessible on the weekly review page", async ({
  page,
}) => {
  const { writes } = await setup(page, { path: "/partner/review/review-a" });
  await expect(page).toHaveURL(/\/partner\/review\/review-a$/);
  await page.getByRole("button", { name: "核查时间" }).click();
  await page.getByLabel("本次核查说明").fill("确认本周时间无调整");
  await page.getByRole("button", { name: "保存核查" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes[0]!.reviewId).toBe("review-a");
});

for (const width of [390, 768, 1440]) {
  test(`the member brief fits ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await expect(page.locator(".lb-pcard")).toHaveCount(2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`member-brief-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
