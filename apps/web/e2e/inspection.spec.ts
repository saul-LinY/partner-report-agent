import { expect, test, type Page } from "@playwright/test";

type FindingFixture = {
  id: string;
  chain: "app" | "system" | "pipeline";
  rule: string;
  severity: "warning" | "critical";
  partnerId: string | null;
  partnerName: string | null;
  subject: string;
  title: string;
  evidence: Record<string, unknown>;
  status: "open" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrences: number;
  analysis: Record<string, unknown> | null;
  analysisStatus: "none" | "queued" | "running" | "completed" | "failed";
  analysisError: { code: string; message: string } | null;
  jobs: Array<Record<string, unknown>>;
};

const base = {
  firstSeenAt: "2026-09-05T09:00:00.000Z",
  lastSeenAt: "2026-09-05T09:55:00.000Z",
  resolvedAt: null,
  status: "open" as const,
  analysis: null,
  analysisStatus: "none" as const,
  analysisError: null,
  jobs: [],
};

function fixtures(): FindingFixture[] {
  return [
    {
      ...base,
      id: "finding-app",
      chain: "app",
      rule: "app.upload",
      severity: "critical",
      partnerId: "partner-chen",
      partnerName: "陈明",
      subject: "device:device-chen",
      title: "陈明的 App 上传失败",
      occurrences: 4,
      evidence: {
        codes: ["UPLOAD_FAILED"],
        counts: { errors: 3 },
        deviceId: "device-chen",
        partnerId: "partner-chen",
        eventIds: ["e1", "e2"],
      },
      analysisStatus: "completed",
      analysis: {
        summary: "上传接口持续返回 502",
        likelyCause: "接收端网关异常",
        impact: "陈明本周的会话包无法进入分析",
        recommendedActions: ["检查 API 网关", "确认后让成员重新上传"],
        confidence: "high",
        relatedChain: "system",
      },
    },
    {
      ...base,
      id: "finding-job",
      chain: "system",
      rule: "system.card_generation",
      severity: "critical",
      partnerId: "partner-lin",
      partnerName: "林安",
      subject: "job:job-1",
      title: "工作卡聚合任务失败",
      occurrences: 1,
      evidence: { jobIds: ["job-1"], executionId: "job:job-1" },
      analysisStatus: "failed",
      analysisError: { code: "MODEL_TIMEOUT", message: "模型请求超时" },
      jobs: [
        {
          id: "job-1",
          type: "AGGREGATE_WORK_ITEMS",
          status: "FAILED",
          errorCode: "MODEL_REQUEST_TIMEOUT",
          errorMessage: "请求超时，请稍后重试。",
          attemptCount: 3,
          maxAttempts: 3,
          nextRetryAt: null,
        },
      ],
    },
    {
      ...base,
      id: "finding-pipeline",
      chain: "pipeline",
      rule: "pipeline.no_review",
      severity: "warning",
      partnerId: "partner-lin",
      partnerName: "林安",
      subject: "upload:upload-1",
      title: "分析完成后没有生成审核",
      occurrences: 2,
      evidence: { uploadId: "upload-1" },
      analysisStatus: "queued",
    },
  ];
}

async function setup(
  page: Page,
  options: {
    modelConfigured?: boolean;
    running?: boolean;
    runStatus?: number;
    path?: string;
  } = {},
) {
  const calls: Array<{
    pathname: string;
    search: URLSearchParams;
    method: string;
  }> = [];
  const findings = fixtures();
  const state = {
    jobStatus: "FAILED",
    lastRun: {
      id: "run-1",
      trigger: "schedule",
      startedAt: "2026-09-05T09:55:00.000Z",
      finishedAt: "2026-09-05T09:55:03.000Z",
      openedCount: 2,
      resolvedCount: 1,
      openCount: 3,
      error: null as string | null,
    },
  };
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
    if (url.pathname === "/v1/admin/inspection/run") {
      if (options.runStatus === 409)
        return route.fulfill({
          status: 409,
          json: {
            code: "INSPECTION_RUNNING",
            message: "巡检正在进行中，请稍后再试。",
          },
        });
      state.lastRun = {
        ...state.lastRun,
        id: "run-2",
        trigger: "manual",
        finishedAt: "2026-09-05T10:00:02.000Z",
      };
      return route.fulfill({ json: { ok: true, run: state.lastRun } });
    }
    if (/\/v1\/admin\/inspection\/findings\/[^/]+\/analyze$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-2)!;
      const finding = findings.find((item) => item.id === id)!;
      finding.analysisStatus = "queued";
      finding.analysisError = null;
      return route.fulfill({ json: { ok: true, analysisStatus: "queued" } });
    }
    if (/\/v1\/admin\/agent-jobs\/[^/]+\/(retry|clear)$/.test(url.pathname)) {
      state.jobStatus = url.pathname.endsWith("/retry")
        ? "PENDING"
        : "CANCELLED";
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/v1/admin/inspection") {
      const status = url.searchParams.get("status") ?? "open";
      const chain = url.searchParams.get("chain");
      const partnerId = url.searchParams.get("partnerId");
      const visible = findings
        .filter(
          (item) =>
            status === "open" &&
            (!chain || item.chain === chain) &&
            (!partnerId || item.partnerId === partnerId),
        )
        .map((item) => ({
          ...item,
          jobs: item.jobs.map((job) => ({ ...job, status: state.jobStatus })),
        }));
      return route.fulfill({
        json: {
          checkedAt: "2026-09-05T10:00:00.000Z",
          running: options.running ?? false,
          modelConfigured: options.modelConfigured ?? true,
          lastRun: state.lastRun,
          summary: {
            open: {
              app: { warning: 0, critical: 1 },
              system: { warning: 0, critical: 1 },
              pipeline: { warning: 1, critical: 0 },
            },
            openTotal: 3,
            resolvedTotal: 5,
          },
          members: [
            { id: "partner-chen", name: "陈明" },
            { id: "partner-lin", name: "林安" },
          ],
          findings: visible,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Unexpected test request" },
    });
  });
  await page.goto(options.path ?? "/admin/inspection");
  await expect(
    page.getByRole("heading", { name: "异常巡检", exact: true }),
  ).toBeVisible();
  return { calls, state };
}

const finding = (page: Page, title: string) =>
  page.locator(".sm-finding-button").filter({ hasText: title });

test("summary counts, last run and the finding list are shown", async ({
  page,
}) => {
  await setup(page);
  const summary = page.getByRole("region", { name: "数据汇总" });
  await expect(summary).toContainText("未处理异常");
  await expect(summary).toContainText("3");
  await expect(summary).toContainText("App 链路");
  await expect(summary).toContainText("1（异常 1 · 需关注 0）");
  await expect(summary).toContainText("处理链路");
  await expect(summary).toContainText("1（异常 0 · 需关注 1）");
  await expect(page.locator(".aw-header")).toContainText("上次巡检");
  await expect(page.locator(".sm-finding-button")).toHaveCount(3);
  const first = finding(page, "陈明的 App 上传失败");
  await expect(first).toContainText("App 链路");
  await expect(first).toContainText("异常");
  await expect(first).toContainText("出现 4 次");
  await expect(finding(page, "分析完成后没有生成审核")).toContainText(
    "需关注",
  );
});

test("filters by chain and member are sent to the API", async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByLabel("巡检链路", { exact: true }).selectOption("system");
  await expect(page.locator(".sm-finding-button")).toHaveCount(1);
  await expect(page.locator(".sm-finding-button")).toContainText(
    "工作卡聚合任务失败",
  );
  await page.getByLabel("巡检链路", { exact: true }).selectOption("");
  await page.getByLabel("巡检成员", { exact: true }).selectOption("partner-lin");
  await expect(page.locator(".sm-finding-button")).toHaveCount(2);
  await page.getByLabel("巡检状态", { exact: true }).selectOption("resolved");
  await expect(page.getByText("没有已恢复的异常")).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/inspection" &&
        call.search.get("chain") === "system",
    ),
  ).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/inspection" &&
        call.search.get("partnerId") === "partner-lin" &&
        call.search.get("status") === "resolved",
    ),
  ).toBe(true);
});

test("an App finding links to the member's user logs and shows a completed AI analysis", async ({
  page,
}) => {
  await setup(page);
  const detail = page.getByRole("region", { name: "异常详情" });
  await expect(detail).toContainText("陈明的 App 上传失败");
  await expect(detail).toContainText("首次发现");
  await expect(detail).toContainText("最近发现");
  await expect(detail).toContainText("出现次数");
  await expect(detail).toContainText("会话包上传失败");
  await expect(
    detail.getByRole("link", { name: "查看该成员的用户日志" }),
  ).toHaveAttribute("href", "/admin/user-logs?partnerId=partner-chen");
  await expect(detail.getByRole("link", { name: "查看任务运行记录" })).toHaveCount(0);
  const analysis = page.getByRole("region", { name: "AI 研判" });
  await expect(analysis).toContainText("完成");
  await expect(analysis).toContainText("上传接口持续返回 502");
  await expect(analysis).toContainText("接收端网关异常");
  await expect(analysis).toContainText("陈明本周的会话包无法进入分析");
  await expect(analysis).toContainText("检查 API 网关");
  await expect(analysis).toContainText("可信度：高");
  await expect(analysis).toContainText("系统链路");
  await expect(analysis.getByRole("button", { name: "重新研判" })).toBeEnabled();
  await expect(page.getByRole("region", { name: "关联任务" })).toHaveCount(0);
});

test("re-analysis posts to the finding and shows the queued state", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("button", { name: "重新研判" }).click();
  await expect
    .poll(() =>
      calls.some(
        (call) =>
          call.pathname === "/v1/admin/inspection/findings/finding-app/analyze" &&
          call.method === "POST",
      ),
    )
    .toBe(true);
  const analysis = page.getByRole("region", { name: "AI 研判" });
  await expect(analysis).toContainText("排队");
  await expect(analysis.getByRole("button", { name: "重新研判" })).toBeDisabled();
});

test("a failed AI analysis shows its error and can be retried", async ({
  page,
}) => {
  await setup(page);
  await finding(page, "工作卡聚合任务失败").click();
  const analysis = page.getByRole("region", { name: "AI 研判" });
  await expect(analysis).toContainText("失败");
  await expect(analysis.getByRole("alert")).toContainText("模型请求超时");
  await expect(analysis.getByRole("button", { name: "重新研判" })).toBeEnabled();
});

test("without a configured model the analysis block says so and cannot start", async ({
  page,
}) => {
  await setup(page, { modelConfigured: false });
  await finding(page, "分析完成后没有生成审核").click();
  const analysis = page.getByRole("region", { name: "AI 研判" });
  await expect(analysis).toContainText("未配置模型");
  await expect(analysis.getByRole("button", { name: "重新研判" })).toBeDisabled();
});

test("job-backed findings link to the execution and offer retry", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await finding(page, "工作卡聚合任务失败").click();
  const detail = page.getByRole("region", { name: "异常详情" });
  await expect(
    detail.getByRole("link", { name: "查看任务运行记录" }),
  ).toHaveAttribute("href", "/admin/system-logs?executionId=job%3Ajob-1");
  const jobs = page.getByRole("region", { name: "关联任务" });
  await expect(jobs).toContainText("工作卡聚合");
  await expect(jobs).toContainText("已失败");
  await expect(jobs).toContainText("中台模型响应超时");
  await expect(jobs).toContainText("请求超时，请稍后重试。");
  await expect(jobs).toContainText("3 / 3");
  await jobs.getByRole("button", { name: "手动重试" }).click();
  await expect(page.getByText("任务已重新入队，等待执行。")).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/agent-jobs/job-1/retry" &&
        call.method === "POST",
    ),
  ).toBe(true);
  await expect(jobs.getByRole("button", { name: "手动重试" })).toHaveCount(0);
  await expect(jobs).toContainText("无需手动处理");
});

test("clearing a job asks for confirmation first", async ({ page }) => {
  const { calls } = await setup(page);
  await finding(page, "工作卡聚合任务失败").click();
  await page.getByRole("button", { name: "清除异常", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "清除异常任务" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("工作卡聚合");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.some((call) => call.pathname.endsWith("/clear"))).toBe(false);
  await page.getByRole("button", { name: "清除异常", exact: true }).click();
  await page.getByRole("button", { name: "确认清除" }).click();
  await expect(page.getByText("异常任务已清除，任务记录已保留。")).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/agent-jobs/job-1/clear" &&
        call.method === "POST",
    ),
  ).toBe(true);
});

test("立即巡检 triggers a run and refreshes the findings", async ({ page }) => {
  const { calls } = await setup(page);
  const before = calls.filter(
    (call) => call.pathname === "/v1/admin/inspection",
  ).length;
  await page.getByRole("button", { name: "立即巡检" }).click();
  await expect(page.getByText("巡检已完成。")).toBeVisible();
  expect(
    calls.some(
      (call) =>
        call.pathname === "/v1/admin/inspection/run" && call.method === "POST",
    ),
  ).toBe(true);
  await expect
    .poll(
      () =>
        calls.filter((call) => call.pathname === "/v1/admin/inspection").length,
    )
    .toBeGreaterThan(before);
});

test("a 409 from 立即巡检 shows the server message", async ({ page }) => {
  await setup(page, { runStatus: 409 });
  await page.getByRole("button", { name: "立即巡检" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "巡检正在进行中，请稍后再试。",
  );
  await expect(page.getByText("巡检已完成。")).toHaveCount(0);
});

test("a running inspection disables the button and says so", async ({
  page,
}) => {
  await setup(page, { running: true });
  await expect(page.locator(".aw-header")).toContainText("巡检进行中");
  await expect(page.getByRole("button", { name: "立即巡检" })).toBeDisabled();
});

for (const width of [320, 390, 768, 1440]) {
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
      path: testInfo.outputPath(`inspection-${width}.png`),
      fullPage: true,
    });
    await finding(page, "工作卡聚合任务失败").click();
    await expect(page.getByRole("region", { name: "关联任务" })).toBeVisible();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`inspection-detail-${width}.png`),
      fullPage: true,
    });
    if (width <= 1150) {
      await page.getByRole("button", { name: "返回异常列表" }).click();
      await expect(finding(page, "陈明的 App 上传失败")).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
