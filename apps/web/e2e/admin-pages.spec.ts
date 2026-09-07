import { expect, test, type Page } from "@playwright/test";

const partnerNames = ["陈明", "林安", "王宁", "李文"];
const date = "2026-09-05T09:00:00.000Z";
function fixture() {
  const partners = Array.from({ length: 16 }, (_, i) => ({
    id: `partner-${i}`,
    display_name: i < 4 ? partnerNames[i] : `测试成员 ${i}`,
    email: `member-${i}@example.test`,
    status: "active",
  }));
  const connections = partners.map((p, i) => ({
    partnerId: p.id,
    partnerName: p.display_name,
    partnerEmail: p.email,
    pluginInstanceId: i === 2 ? null : `plugin-${i}`,
    connectionState: [
      "active",
      "connected",
      "not_connected",
      "expired",
      "failed",
      "pending",
    ][i % 6],
    feishuConnectionState:
      i % 3 === 0 ? "connected" : i % 3 === 1 ? "failed" : "not_started",
    feishuConnectedAt: date,
    feishuLastAttemptAt: date,
    feishuLastErrorCode: i % 3 === 1 ? "FEISHU_RATE_LIMIT" : null,
    verifiedAt: date,
    lastUploadAt: i % 2 ? null : date,
    deviceName: `开发设备 ${i}`,
    version: "2.0.0",
    reviewProgress: {
      periodKey: "2026-W36",
      stage: i % 2 ? "not_started" : "reviewing_cards",
      reviewed: 2,
      total: 5,
      pending: 3,
      approved: 1,
      excluded: 1,
    },
  }));
  const periods = Array.from({ length: 14 }, (_, i) => ({
    id: `period-${i}`,
    period_key: `2026-W${36 - i}`,
    status: "open",
    starts_at: new Date(Date.UTC(2026, 7, 31 - i * 7)).toISOString(),
    ends_at: new Date(Date.UTC(2026, 8, 7 - i * 7)).toISOString(),
    cutoff_at: date,
  }));
  const reviewQueue = partners.map((p, i) => ({
    review_id: `review-${i}`,
    review_state: i % 3 === 1 ? "PENDING" : "IN_PROGRESS",
    partner_id: p.id,
    partner_name: p.display_name,
    partner_email: p.email,
    period_key: i % 2 ? "2026-W35" : "2026-W36",
    pending_count: 3,
    approved_count: 1,
    excluded_count: 1,
    updated_at: new Date(Date.UTC(2026, 8, 5, 9, -i)).toISOString(),
  }));
  const overview = {
    team: {
      id: "team",
      name: "产品研发团队",
      period_rule: { factCutoffWeekday: 5, factCutoffTime: "17:00" },
    },
    partners,
    connections,
    periods,
    reviewQueue,
    bindingCodes: [
      {
        id: "code-0",
        partner_id: "partner-0",
        code_value: "PR-TEST-0000",
        status: "active",
      },
    ],
    jobs: [
      { status: "FAILED", type: "GENERATE_WORK_ITEMS", count: 2 },
      { status: "RETRY_WAIT", type: "GENERATE_TEAM_REPORT", count: 1 },
    ],
  };
  const facts = Array.from({ length: 15 }, (_, i) => ({
    id: `fact-${i}`,
    partner_id: `partner-${i % 2}`,
    partner_name: partnerNames[i % 2],
    period_id: `period-${i % 2}`,
    period_key: i % 2 ? "2026-W35" : "2026-W36",
    session_id: `session-${i}`,
    external_fact_id: `contribution-original-${i}`,
    source_hash: `source-checksum-${i}`,
    source_occurred_at: i % 2 ? "2026-09-04T09:00:00.000Z" : date,
    payload: {
      title:
        i === 0
          ? "监控查询性能优化"
          : i === 1
            ? "历史贡献格式兼容"
            : `项目贡献 ${i}`,
      projectId: i % 3 === 2 ? undefined : `project-${i % 2}`,
      summary:
        i === 1 ? undefined : "完成查询流程调整，补充异常处理与自动化验证。",
      timeline: i === 1 ? [{ summary: "旧格式最后一条进展摘要" }] : [],
      contributions:
        i === 1
          ? undefined
          : [
              { kind: "outcome", text: "查询耗时降低 30%" },
              { kind: "progress", text: "完成接口联调" },
              { kind: "decision", text: "保留现有鉴权边界" },
              { kind: "blocker", text: "等待外部服务配额" },
              { kind: "next_step", text: "继续验证高峰期查询" },
            ],
      outcomes: ["历史成果"],
      actions: ["历史进展"],
      decisions: ["历史决策"],
      blockers: [],
      nextSteps: ["历史下一步"],
    },
  }));
  const archive = {
    periods: periods.map((p, i) => ({
      id: p.id,
      periodKey: p.period_key,
      startsAt: p.starts_at,
      endsAt: p.ends_at,
      teamReport:
        i % 3 === 1
          ? null
          : {
              id: `report-${i}`,
              title: `${p.period_key} 团队周报`,
              summary:
                "本周期完成系统监控与项目采集能力建设，继续跟进服务配额和待审工作卡。",
              version: 2,
            },
      people: partners.slice(0, 2).map((person, j) => ({
        id: person.id,
        name: person.display_name,
        email: person.email,
        workItems:
          i === 0 && j === 1
            ? []
            : [
                {
                  id: `work-${i}-${j}`,
                  title: `项目交付 ${i}-${j}`,
                  status: "completed",
                  reviewStatus: j ? "excluded" : "approved",
                  overview: `归档完整摘要 ${i}-${j}：完成接口优化、权限边界验证与上线检查。`,
                },
              ],
      })),
    })),
  };
  return { overview, facts, archive };
}

async function setup(
  page: Page,
  path = "/admin",
  options: { fail?: string[]; empty?: boolean } = {},
) {
  const data = fixture();
  const calls: Array<{
    path: string;
    method: string;
    body: any;
    params: Record<string, string>;
    simulatedPartner: string | undefined;
  }> = [];
  await page.clock.install({ time: new Date("2026-09-05T10:00:00Z") });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({
      path: url.pathname,
      method: request.method(),
      body: request.postDataJSON(),
      params: Object.fromEntries(url.searchParams),
      simulatedPartner: request.headers()["x-partner-id"],
    });
    if (options.fail?.includes(url.pathname))
      return route.fulfill({
        status: 503,
        json: { code: "TEMPORARY_FAILURE", message: "请求暂时失败，请重试" },
      });
    if (url.pathname === "/v1/me")
      return route.fulfill({
        json: {
          userId: "admin",
          tenantId: "test",
          teamId: "team",
          roles: ["admin"],
          email: "admin@example.test",
          displayName: "管理员",
          teamName: "产品研发团队",
        },
      });
    if (url.pathname === "/v1/admin/overview")
      return route.fulfill({
        json: options.empty
          ? {
              ...data.overview,
              partners: [],
              connections: [],
              periods: [],
              reviewQueue: [],
              jobs: [],
              bindingCodes: [],
            }
          : data.overview,
      });
    if (url.pathname === "/v1/admin/team") {
      data.overview.team.period_rule = request.postDataJSON().periodRule;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/v1/admin/partners" && request.method() === "POST")
      return route.fulfill({ json: { id: "created-partner" } });
    if (
      /\/partners\/[^/]+$/.test(url.pathname) &&
      ["PATCH", "DELETE"].includes(request.method())
    ) {
      const id = url.pathname.split("/").at(-1);
      if (request.method() === "PATCH") {
        data.overview.partners.find((p) => p.id === id)!.display_name =
          request.postDataJSON().displayName;
        data.overview.connections.find((p) => p.partnerId === id)!.partnerName =
          request.postDataJSON().displayName;
      } else {
        data.overview.partners = data.overview.partners.filter(
          (p) => p.id !== id,
        );
        data.overview.connections = data.overview.connections.filter(
          (p) => p.partnerId !== id,
        );
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.endsWith("/binding-codes"))
      return route.fulfill({ json: { code: "PR-RECOVERY-1234" } });
    if (url.pathname.endsWith("/project-scopes/reapproval"))
      return route.fulfill({ json: { ok: true } });
    if (url.pathname.endsWith("/project-scopes"))
      return route.fulfill({
        json: {
          partner: {
            id: "partner-0",
            displayName: "陈明",
            email: "member-0@example.test",
          },
          summary: { total: 3, allowed: 1, pending: 1, denied: 1 },
          instances: [
            {
              id: "plugin-0",
              deviceName: "开发设备 0",
              version: "2.0.0",
              policyVersion: 7,
              initialized: true,
              initializedAt: date,
              projects: ["allowed", "pending", "denied"].map(
                (permission, i) => ({
                  name: `项目权限 ${i}`,
                  permission,
                  effectiveFrom: date,
                  firstSeenPeriodKey: "2026-W36",
                  firstSeenAt: date,
                  lastSeenAt: date,
                  sessionCount: 3,
                }),
              ),
            },
          ],
        },
      });
    if (url.pathname === "/v1/admin/session-facts") {
      const records = options.empty
        ? []
        : data.facts.filter(
            (row) =>
              (!url.searchParams.has("partnerId") ||
                row.partner_id === url.searchParams.get("partnerId")) &&
              (!url.searchParams.has("periodId") ||
                row.period_id === url.searchParams.get("periodId")) &&
              (!url.searchParams.has("projectId") ||
                (url.searchParams.get("projectId") === "unassigned"
                  ? !row.payload.projectId
                  : row.payload.projectId ===
                    url.searchParams.get("projectId"))) &&
              (!url.searchParams.has("sessionDate") ||
                row.source_occurred_at.startsWith(
                  url.searchParams.get("sessionDate")!,
                )),
          );
      const current = Number(url.searchParams.get("page"));
      return route.fulfill({
        json: {
          items: records.slice((current - 1) * 10, current * 10),
          page: current,
          pageSize: 10,
          total: records.length,
          projects: [
            { id: "project-0", name: "Partner Report" },
            { id: "project-1", name: "数据服务" },
          ],
          hasUnassigned: true,
        },
      });
    }
    if (url.pathname === "/v1/admin/report-archive")
      return route.fulfill({
        json: options.empty ? { periods: [] } : data.archive,
      });
    if (url.pathname.startsWith("/v1/admin/team-reports/")) {
      const versions = [2, 1].map((version) => ({
        id: `version-${version}`,
        version,
        title: `团队报告版本 ${version}`,
        summary: `版本 ${version} 管理摘要`,
        markdown: `## 项目进展\n\n版本 ${version} 的报告正文`,
        payload: {},
        created_at: date,
      }));
      return route.fulfill({
        json: {
          report: {
            id: url.pathname.split("/").at(-1),
            period_key: "2026-W36",
            status: "LOCKED",
            current_version: 2,
          },
          current: versions[0],
          versions,
        },
      });
    }
    if (url.pathname.startsWith("/v1/reviews/"))
      return route.fulfill({
        json: {
          review: {
            id: "review-0",
            state: "IN_PROGRESS",
            version: 1,
            partner_name: "陈明",
            period_key: "2026-W36",
          },
          items: [],
          regenerationJobs: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Unexpected fixture request" },
    });
  });
  await page.goto(path);
  await expect(page.locator(".management-page")).toBeVisible();
  return { data, calls };
}

test("overview filters, pagination and member selection", async ({ page }) => {
  await setup(page);
  await expect(page.locator(".aw-person-table tbody tr")).toHaveCount(10);
  await page.locator(".aw-table-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.getByTitle("下一页", { exact: true }).click();
  await expect(page.locator(".aw-person-table tbody tr")).toHaveCount(6);
  expect(
    await page
      .locator(".aw-table-scroll")
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await page.getByRole("textbox", { name: "搜索人员" }).fill("林安");
  await expect(page.locator(".aw-person-table tbody tr")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "人员详情" })).toContainText(
    "开发设备 1",
  );
  await page.getByRole("button", { name: "重置筛选" }).click();
  await page.getByLabel("插件连接状态").selectOption("failed");
  await expect(page.locator(".aw-person-table tbody tr")).toHaveCount(2);
  await page.getByLabel("飞书连接状态").selectOption("connected");
  await expect(page.getByText("没有符合条件的人员")).toBeVisible();
  await expect(page.getByText("暂无人员详情")).toBeVisible();
});

test("create, edit and delete retain their original API contracts", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("button", { name: "新增人员", exact: true }).click();
  let modal = page.getByRole("dialog");
  await modal.getByLabel("姓名", { exact: true }).fill("新成员");
  await modal.getByLabel("唯一工作邮箱").fill("new@example.test");
  await modal.getByRole("button", { name: "创建", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(calls.find((c) => c.path === "/v1/admin/partners")?.body).toEqual({
    displayName: "新成员",
    email: "new@example.test",
  });
  await page.getByRole("button", { name: "编辑 陈明 的姓名" }).click();
  modal = page.getByRole("dialog");
  await modal.getByLabel("姓名", { exact: true }).fill("陈明更新");
  await modal.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "人员详情" })
      .getByRole("heading", { name: "陈明更新" }),
  ).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    displayName: "陈明更新",
  });
  await page
    .getByRole("button", { name: "删除 陈明更新", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  await page
    .getByRole("button", { name: "删除 陈明更新", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除" })
    .click();
  await expect(
    page.getByRole("button", { name: "查看 陈明更新 的详情" }),
  ).toHaveCount(0);
  expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
    "/v1/admin/partners/partner-0",
  );
});

test("binding codes support viewing, copying, recovery and new connection", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { calls } = await setup(page);
  await page.getByRole("button", { name: "复制 陈明 的绑定码" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "PR-TEST-0000",
  );
  await page.getByRole("button", { name: "查看绑定码", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("PR-TEST-0000");
  await page.getByRole("dialog").getByTitle("关闭", { exact: true }).click();
  expect(calls.filter((c) => c.path.endsWith("/binding-codes"))).toHaveLength(
    0,
  );
  await page.getByRole("button", { name: "查看 林安 的详情" }).click();
  await page.getByRole("button", { name: "恢复连接", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "生成", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("PR-RECOVERY-1234");
  expect(
    calls.find((c) => c.path.includes("partner-1/binding-codes"))?.body,
  ).toEqual({ label: "Codex Plugin", pluginInstanceId: "plugin-1" });
  await page.getByRole("dialog").getByTitle("关闭", { exact: true }).click();
  await page.getByRole("button", { name: "查看 王宁 的详情" }).click();
  await page.getByRole("button", { name: "生成绑定码", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "生成", exact: true })
    .click();
  await expect
    .poll(
      () => calls.find((c) => c.path.includes("partner-2/binding-codes"))?.body,
    )
    .toEqual({ label: "Codex Plugin" });
});

test("project permission review preserves approval confirmation and version", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("button", { name: "采集权限", exact: true }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText("项目权限 0", { exact: true })).toBeVisible();
  await expect(modal.getByText("允许采集", { exact: true })).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.dismiss());
  await modal.getByRole("button", { name: "重新发起审核" }).click();
  expect(calls.filter((c) => c.path.endsWith("/reapproval"))).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await modal.getByRole("button", { name: "重新发起审核" }).click();
  await expect
    .poll(() => calls.find((c) => c.path.endsWith("/reapproval"))?.body)
    .toEqual({ baseVersion: 7 });
});

test("schedule changes and unsaved fields survive tab navigation", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("tab", { name: "生成设置" }).click();
  await page
    .getByRole("combobox", { name: "每周", exact: true })
    .selectOption("4");
  await page.getByLabel("聚合时间", { exact: true }).fill("16:30");
  await page.getByRole("tab", { name: "人员管理" }).click();
  await page.getByRole("tab", { name: "生成设置" }).click();
  await expect(page.getByLabel("聚合时间", { exact: true })).toHaveValue(
    "16:30",
  );
  await page.getByRole("button", { name: "保存生成时间" }).click();
  await expect(page.getByRole("status")).toContainText("生成时间已保存");
  expect(calls.find((c) => c.path === "/v1/admin/team")?.body).toEqual({
    periodRule: {
      frequency: "weekly",
      weekStartsOn: 1,
      factCutoffWeekday: 4,
      factCutoffTime: "16:30",
    },
  });
});

test("review queue searches and filters before opening the right review", async ({
  page,
}) => {
  const { calls } = await setup(page, "/admin/reviews");
  await expect(page.locator(".aw-queue-table tbody tr")).toHaveCount(12);
  await page.getByRole("tab", { name: "生成中" }).click();
  await expect(page.locator(".aw-queue-table tbody tr")).toHaveCount(5);
  await page.getByRole("tab", { name: "全部记录" }).click();
  await page.getByLabel("审核周期").selectOption("2026-W36");
  await page.getByLabel("审核人员").selectOption("partner-0");
  await expect(page.locator(".aw-queue-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "审核项目卡" }).click();
  await expect(page).toHaveURL(/\/partner\/review\/review-0$/);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("partner-report-simulated-partner"),
    ),
  ).toBe("partner-0");
  await expect
    .poll(
      () =>
        calls.find((c) => c.path === "/v1/reviews/review-0")?.simulatedPartner,
    )
    .toBe("partner-0");
});

test("facts retain server filtering, pagination, legacy content and full provenance", async ({
  page,
}) => {
  const { calls } = await setup(page, "/admin/facts");
  await expect(page.locator(".aw-fact-table tbody tr")).toHaveCount(10);
  const detail = page.getByRole("region", { name: "贡献详情" });
  await expect(detail).toContainText("查询耗时降低 30%");
  await expect(detail).toContainText("source-checksum-0");
  await page.getByRole("button", { name: /历史贡献格式兼容/ }).click();
  await expect(detail).toContainText("旧格式最后一条进展摘要");
  await expect(detail).toContainText("历史成果");
  await expect(detail).toContainText("历史下一步");
  await page.getByTitle("下一页", { exact: true }).click();
  await expect(page.locator(".aw-fact-table tbody tr")).toHaveCount(5);
  await page.getByLabel("贡献人员").selectOption("partner-0");
  await page.getByLabel("贡献周期").selectOption("period-0");
  await page.getByLabel("贡献项目").selectOption("unassigned");
  await page.getByLabel("贡献会话日期").fill("2026-09-05");
  await expect(page.locator(".aw-fact-table tbody tr")).toHaveCount(3);
  expect(
    calls.filter((c) => c.path === "/v1/admin/session-facts").at(-1)?.params,
  ).toEqual({
    page: "1",
    pageSize: "10",
    partnerId: "partner-0",
    periodId: "period-0",
    projectId: "unassigned",
    sessionDate: "2026-09-05",
  });
  await page.getByLabel("贡献会话日期").fill("2026-08-01");
  await expect(page.getByText("当前筛选条件下没有 Session 贡献")).toBeVisible();
  await expect(detail).toContainText("暂无贡献详情");
});

test("facts never show prior filter content while the next request is pending", async ({
  page,
}) => {
  await setup(page, "/admin/facts");
  await expect(page.locator(".aw-fact-table tbody tr")).toHaveCount(10);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/admin/session-facts?**", async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await page.getByLabel("贡献项目").selectOption("project-1");
    await expect(page.getByText("加载贡献记录", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "贡献详情" }),
    ).not.toContainText("source-checksum-0");
    await expect(page.getByTitle("下一页", { exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator(".aw-fact-table tbody tr")).toHaveCount(5);
});

test("archive filters, waiting reports, work card snapshots and report versions", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page, "/admin/reports");
  await expect(page.locator(".aw-archive-table tbody tr")).toHaveCount(12);
  await page.getByTitle("下一页", { exact: true }).click();
  await expect(page.locator(".aw-archive-table tbody tr")).toHaveCount(2);
  await page.getByLabel("周报归档状态").selectOption("waiting");
  await expect(page.locator(".aw-archive-table tbody tr")).toHaveCount(5);
  await expect(page.getByRole("link", { name: "查看报告" })).toHaveCount(0);
  await page.getByRole("tab", { name: "项目工作卡" }).click();
  await page.getByLabel("归档周期", { exact: true }).selectOption("period-1");
  await page.getByLabel("归档人员", { exact: true }).selectOption("partner-1");
  await page.getByLabel("工作卡确认状态").selectOption("excluded");
  await expect(page.locator(".aw-archive-card")).toHaveCount(1);
  await page.locator(".aw-archive-card summary").click();
  await expect(
    page.getByText("归档完整摘要 1-1：完成接口优化、权限边界验证与上线检查。"),
  ).toBeVisible();
  await expect(page.getByText("work-1-1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置筛选" }).click();
  await page.getByLabel("归档周期", { exact: true }).selectOption("period-0");
  await expect(
    page.getByText("没有已确认的项目工作卡", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "团队周报" }).click();
  await page.getByRole("link", { name: "查看报告" }).click();
  await expect(page).toHaveURL(/\/admin\/team-reports\/report-0$/);
  await expect(
    page.getByRole("heading", { name: "团队报告版本 2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /v1/ }).click();
  await expect(
    page.getByRole("heading", { name: "团队报告版本 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "复制周报" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "版本 1 的报告正文",
  );
  await page.getByRole("link", { name: "返回归档" }).click();
  await expect(page).toHaveURL(/\/admin\/reports$/);
});

for (const [path, title, endpoint] of [
  ["/admin", "运行总览", "/v1/admin/overview"],
  ["/admin/reviews", "审核队列", "/v1/admin/overview"],
  ["/admin/facts", "贡献预览", "/v1/admin/session-facts"],
  ["/admin/reports", "报告归档", "/v1/admin/report-archive"],
]) {
  test(`${title} handles empty data and recoverable request failures`, async ({
    page,
  }) => {
    const options = { empty: true, fail: [] as string[] };
    await setup(page, path, options);
    await expect(page.locator(".empty-state").first()).toBeVisible();
    options.fail = [endpoint!];
    await page.getByTitle(`刷新${title}`, { exact: true }).click();
    await page.clock.fastForward(2000);
    await expect(page.getByRole("alert")).toContainText("请求暂时失败");
    options.fail = [];
    options.empty = false;
    await page.getByTitle(`刷新${title}`, { exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".aw-table tbody tr").first()).toBeVisible();
  });
}

for (const width of [320, 390, 768, 1440, 1920]) {
  test(`all four admin layouts and navigation at ${width}px`, async ({
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
    for (const [name, slug] of [
      ["运行总览", "overview"],
      ["审核队列", "reviews"],
      ["贡献预览", "facts"],
      ["报告归档", "archive"],
    ]) {
      await page
        .locator(".sidebar nav")
        .getByRole("link", { name, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      await expect(page.locator(".aw-table tbody tr").first()).toBeVisible();
      await noOverflow();
      await page.screenshot({
        path: testInfo.outputPath(`${slug}-${width}.png`),
        fullPage: true,
      });
      if (slug === "overview" || slug === "facts") {
        await page.locator(".aw-record-button").first().click();
        await expect(
          page.getByRole("region", {
            name: slug === "overview" ? "人员详情" : "贡献详情",
          }),
        ).toBeVisible();
        await noOverflow();
        await page.screenshot({
          path: testInfo.outputPath(`${slug}-detail-${width}.png`),
          fullPage: true,
        });
        if (width <= 1250)
          await page
            .getByRole("button", { name: "返回列表", exact: true })
            .click();
      }
    }
    await page.getByRole("tab", { name: "项目工作卡" }).click();
    await page.locator(".aw-archive-card summary").first().click();
    await noOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`cards-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
