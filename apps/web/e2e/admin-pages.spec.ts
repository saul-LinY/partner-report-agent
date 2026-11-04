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
  const sessions = Array.from({ length: 15 }, (_, i) => ({
    id: `preprocess-${i}`,
    verdict: "keep" as "keep" | "drop",
    reason: null as string | null,
    decided_by: "rule" as "rule" | "human",
    upload_id: `upload-${i}`,
    session_id: `session-${i}`,
    partner_id: `partner-${i % 2}`,
    partner_name: partnerNames[i % 2],
    period_id: `period-${i % 2}`,
    period_key: i % 2 ? "2026-W35" : "2026-W36",
    agent: i % 2 ? "claude" : "codex",
    title: i === 0 ? "监控查询性能优化" : `项目会话 ${i}`,
    modified_at: i % 2 ? "2026-09-04T09:00:00.000Z" : date,
    turn_count: i === 0 ? 25 : 2,
    preview: `会话 ${i} 的第一条提问`,
    project_name: i % 3 === 2 ? "数据服务" : "Partner Report",
  }));
  for (const [i, reason] of ["test", "chitchat", "empty"].entries()) {
    sessions.push({
      ...sessions[i]!,
      id: `dropped-${i}`,
      upload_id: `dropped-upload-${i}`,
      session_id: `dropped-session-${i}`,
      title: `已剔除会话 ${reason}`,
      preview: `不应展示的内容 ${reason}`,
      verdict: "drop",
      reason,
    });
  }
  const transcript = (row: (typeof sessions)[number]) => ({
    uploadId: row.upload_id,
    sessionId: row.session_id,
    agent: row.agent,
    title: row.title,
    modifiedAt: row.modified_at,
    partnerName: row.partner_name,
    periodKey: row.period_key,
    projectName: row.project_name,
    turns: Array.from({ length: row.turn_count }, (_, t) => ({
      id: `${row.session_id}-turn-${t}`,
      prompt:
        t === 1
          ? `粘贴的长日志开始\n${"日志行\n".repeat(40)}长日志结尾标记`
          : `${row.title} 第 ${t + 1} 个问题`,
      answer:
        t === 1
          ? null
          : `已完成第 ${t + 1} 步：\n\n- **查询耗时**降低 30%\n- 新增 \`isValid()\` 校验`,
      questionTime: "09月05日 17:00",
      answerTime: t === 1 ? null : "09月05日 17:02",
      model: t === 1 ? null : "gpt-test",
    })),
  });
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
  return { overview, sessions, transcript, archive };
}

async function setup(
  page: Page,
  path = "/admin/team-settings",
  options: {
    fail?: string[];
    empty?: boolean;
    notificationStatus?: string;
  } = {},
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
    if (url.pathname === "/v1/admin/project-progress")
      return route.fulfill({
        json: {
          today: "2026-09-08",
          timezone: "Asia/Shanghai",
          from: "2026-08-26",
          to: "2026-09-08",
          generatedAt: date,
          members: [],
          projects: [],
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
    if (url.pathname.endsWith("/notifications/test"))
      return route.fulfill({
        json: { id: "notification-test", status: "queued" },
      });
    if (url.pathname.endsWith("/notifications/notification-test"))
      return route.fulfill({
        json: {
          id: "notification-test",
          status: options.notificationStatus ?? "queued",
        },
      });
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
    if (url.pathname.endsWith("/verdict") && request.method() === "PUT") {
      const row = data.sessions.find(
        (item) =>
          url.pathname === `/v1/admin/session-preprocess/${item.id}/verdict`,
      );
      if (row) {
        const { verdict } = request.postDataJSON();
        row.verdict = verdict === "auto" ? "keep" : verdict;
        row.reason = verdict === "drop" ? "manual" : null;
        row.decided_by = verdict === "auto" ? "rule" : "human";
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/v1/admin/session-preprocess/rerun")
      return route.fulfill({
        json: { ok: true, judged: data.sessions.length },
      });
    if (url.pathname === "/v1/admin/session-preprocess") {
      const records = options.empty
        ? []
        : data.sessions.filter(
            (row) =>
              (!url.searchParams.has("partnerId") ||
                row.partner_id === url.searchParams.get("partnerId")) &&
              (!url.searchParams.has("periodId") ||
                row.period_id === url.searchParams.get("periodId")) &&
              (!url.searchParams.has("project") ||
                row.project_name === url.searchParams.get("project")) &&
              (!url.searchParams.has("agent") ||
                row.agent === url.searchParams.get("agent")) &&
              (!url.searchParams.has("verdict") ||
                row.verdict === url.searchParams.get("verdict")) &&
              (!url.searchParams.has("decidedBy") ||
                row.decided_by === url.searchParams.get("decidedBy")),
          );
      const current = Number(url.searchParams.get("page"));
      return route.fulfill({
        json: {
          items: records.slice((current - 1) * 10, current * 10),
          page: current,
          pageSize: 10,
          total: records.length,
          projects: ["Partner Report", "数据服务"],
          agents: [...new Set(data.sessions.map((row) => row.agent))],
        },
      });
    }
    if (url.pathname === "/v1/admin/collector-sessions/detail") {
      const row = data.sessions.find(
        (item) => item.upload_id === url.searchParams.get("uploadId"),
      );
      return row
        ? route.fulfill({ json: data.transcript(row) })
        : route.fulfill({ status: 404, json: { code: "SESSION_NOT_FOUND" } });
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

test("team settings appears after reviews and supports direct entry", async ({
  page,
}) => {
  const { calls } = await setup(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const teamGroup = navigation
    .locator(".nav-group")
    .filter({ hasText: "进展与成果" });
  await expect(teamGroup.getByRole("link")).toHaveText([
    "项目进展",
    "周报与工作卡",
  ]);
  const contributionGroup = navigation
    .locator(".nav-group")
    .filter({ hasText: "采集与管理" });
  await expect(contributionGroup.getByRole("link")).toHaveText([
    "会话预处理",
    "工作卡审核",
    "团队管理",
  ]);
  await expect(
    navigation.getByRole("link", { name: "会话预处理", exact: true }),
  ).toHaveCount(1);
  await expect(
    navigation.getByRole("link", { name: "会话原文", exact: true }),
  ).toHaveCount(0);
  await expect(navigation.getByText("数据提取", { exact: true })).toHaveCount(
    0,
  );
  const monitoringGroup = navigation
    .locator(".nav-group")
    .filter({ hasText: "监控与排障" });
  await expect(monitoringGroup.getByRole("link")).toHaveText([
    "用户日志",
    "系统日志",
    "异常巡检",
  ]);
  await expect(
    navigation.getByRole("link", { name: "团队管理", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "人员管理" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "生成设置" })).toBeVisible();
  expect(calls.some((call) => call.path === "/v1/admin/project-progress")).toBe(
    false,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "团队管理", exact: true }),
  ).toBeVisible();
  await navigation.getByRole("link", { name: "项目进展", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "项目进展", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增人员" })).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "项目进展", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    navigation.getByRole("link", { name: "团队管理", exact: true }),
  ).not.toHaveAttribute("aria-current");
  await navigation.getByRole("link", { name: "团队管理", exact: true }).click();
  await page.getByRole("tab", { name: "生成设置" }).click();
  await expect(
    page.getByRole("button", { name: "保存生成时间" }),
  ).toBeVisible();
});

test("team settings pagination and member selection", async ({ page }) => {
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
  await page.getByTitle("上一页", { exact: true }).click();
  await expect(page.locator(".aw-person-table tbody tr")).toHaveCount(10);
  await page
    .getByRole("button", { name: "查看 林安 的详情", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "人员详情" })).toContainText(
    "开发设备 1",
  );
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

test("queues an App test notification for the selected member without claiming delivery", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page
    .getByRole("button", { name: "测试 App 通知", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "已排队，等待 App 的系统通知回执。App 运行时约每 10 秒同步。",
  );
  expect(
    calls.find((c) => c.path.endsWith("/notifications/test")),
  ).toMatchObject({
    method: "POST",
    path: "/v1/admin/partners/partner-0/notifications/test",
  });
  await page
    .getByRole("button", { name: "查看 林安 的详情", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("test notification status follows permission recovery through the macOS receipt", async ({
  page,
}) => {
  const options = { notificationStatus: "permission_denied" };
  await setup(page, "/admin/team-settings", options);
  await page
    .getByRole("button", { name: "测试 App 通知", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("macOS 通知权限未开启");
  options.notificationStatus = "permission_required";
  await page.clock.runFor(2100);
  await expect(page.getByRole("status")).toContainText("等待首次通知授权");
  options.notificationStatus = "app_offline";
  await page.clock.runFor(2100);
  await expect(page.getByRole("status")).toContainText("请打开已绑定的 App");
  options.notificationStatus = "queued";
  await page.clock.runFor(2100);
  await expect(page.getByRole("status")).toContainText(
    "等待 App 的系统通知回执",
  );
  options.notificationStatus = "delivered";
  await page.clock.runFor(2100);
  await expect(page.getByRole("status")).toContainText("macOS 已接受通知");
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
  ).toEqual({ label: "Weekly Report App", pluginInstanceId: "plugin-1" });
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
    .toEqual({ label: "Weekly Report App" });
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

test("preprocessing only shows kept sessions through filtering and pagination", async ({
  page,
}) => {
  const { calls } = await setup(page, "/admin/sessions");
  const rows = page.locator(".aw-session-table tbody tr");
  await expect(rows).toHaveCount(10);
  await expect(page.getByLabel("会话判定", { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("combobox", { name: "会话判定", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "会话原因" })).toHaveCount(0);
  await expect(page.getByText(/已剔除会话|不应展示的内容/)).toHaveCount(0);
  const detail = page.getByRole("region", { name: "会话详情" });
  await expect(
    detail.getByRole("heading", { name: "监控查询性能优化", exact: true }),
  ).toBeVisible();
  const turns = detail.locator(".sx-turn");
  await expect(turns).toHaveCount(20);
  await expect(turns.first().locator(".sx-user")).toContainText(
    "监控查询性能优化 第 1 个问题",
  );
  await expect(
    turns.first().locator(".sx-assistant strong").first(),
  ).toHaveText("回复 · gpt-test");
  await expect(
    turns.first().locator(".sx-assistant").getByText("查询耗时"),
  ).toHaveCSS("font-weight", "700");
  await expect(turns.nth(1)).toContainText("未记录回复");
  const longPrompt = turns.nth(1).locator(".sx-user");
  await expect(longPrompt.locator(".sx-body")).toHaveClass(/is-collapsed/);
  await longPrompt.getByRole("button", { name: /展开全文/ }).click();
  await expect(longPrompt.locator(".sx-body")).not.toHaveClass(/is-collapsed/);
  await expect(longPrompt).toContainText("长日志结尾标记");
  await detail
    .getByRole("button", { name: "显示后续 5 轮（剩余 5 轮）" })
    .click();
  await expect(turns).toHaveCount(25);

  await page.getByTitle("下一页", { exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByText(/已剔除会话|不应展示的内容/)).toHaveCount(0);
  await page.getByLabel("会话人员").selectOption("partner-0");
  await page.getByLabel("会话周期").selectOption("period-0");
  await page.getByLabel("会话项目").selectOption("数据服务");
  await page.getByLabel("会话工具").selectOption("codex");
  await expect(rows).toHaveCount(3);
  expect(
    calls.filter((c) => c.path === "/v1/admin/session-preprocess").at(-1)
      ?.params,
  ).toEqual({
    page: "1",
    pageSize: "10",
    verdict: "keep",
    partnerId: "partner-0",
    periodId: "period-0",
    project: "数据服务",
    agent: "codex",
  });
  await page.getByLabel("会话工具").selectOption("claude");
  await expect(page.getByText("当前筛选条件下没有会话")).toBeVisible();
  await expect(detail).toContainText("暂无会话");
  await page
    .getByRole("button", { name: "重置筛选", exact: true })
    .first()
    .click();
  await expect(rows).toHaveCount(10);
  expect(
    calls
      .filter((call) => call.path === "/v1/admin/session-preprocess")
      .every((call) => call.params.verdict === "keep"),
  ).toBeTruthy();
  expect(
    calls.some((call) => call.path === "/v1/admin/collector-sessions"),
  ).toBe(false);
  expect(
    calls.some((call) => call.params.uploadId?.startsWith("dropped-")),
  ).toBe(false);
});

test("legacy preprocessing address redirects to the single active navigation entry", async ({
  page,
}) => {
  await setup(page, "/admin/preprocess");
  await expect(page).toHaveURL(/\/admin\/sessions$/);
  await expect(
    page.getByRole("heading", { name: "会话预处理", exact: true }),
  ).toBeVisible();
  const entry = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "会话预处理", exact: true });
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveClass(/active/);
  await expect(page.locator(".aw-session-table tbody tr")).toHaveCount(10);
});

test("manually dropping a session removes its content and keeps reruns filtered", async ({
  page,
}) => {
  const { calls } = await setup(page, "/admin/sessions");
  const detail = page.getByRole("region", { name: "会话详情" });
  await expect(
    detail.getByRole("heading", { name: "监控查询性能优化", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "改为剔除", exact: true }).click();
  await expect(page.locator(".aw-session-table")).not.toContainText(
    "监控查询性能优化",
  );
  await expect(
    detail.getByRole("heading", { name: "项目会话 1", exact: true }),
  ).toBeVisible();
  expect(
    calls.find(
      (call) =>
        call.path === "/v1/admin/session-preprocess/preprocess-0/verdict",
    )?.body,
  ).toEqual({ verdict: "drop" });
  await page.getByRole("button", { name: "重新判定", exact: true }).click();
  await expect
    .poll(
      () =>
        calls.filter((call) => call.path === "/v1/admin/session-preprocess")
          .length,
    )
    .toBeGreaterThanOrEqual(3);
  await expect(page.getByText(/已剔除会话|不应展示的内容/)).toHaveCount(0);
  await expect(page.locator(".aw-session-table")).not.toContainText(
    "监控查询性能优化",
  );
  await page.getByTitle("下一页", { exact: true }).click();
  await expect(page.locator(".aw-session-table tbody tr")).toHaveCount(4);
});

test("session selection responds across the whole row without moving the list", async ({
  page,
}) => {
  const { calls } = await setup(page, "/admin/sessions");
  const rows = page.locator(".aw-session-table tbody tr");
  const detail = page.getByRole("region", { name: "会话详情" });
  const list = page.locator(".sessions-page .aw-table-scroll");
  await expect(rows).toHaveCount(10);
  const reads = calls.filter(
    (call) => call.path === "/v1/admin/session-preprocess",
  ).length;

  await rows.nth(4).scrollIntoViewIfNeeded();
  const scrollTop = await list.evaluate((element) => element.scrollTop);
  await rows
    .nth(4)
    .locator("td")
    .last()
    .getByText("规则 · 陈明", { exact: true })
    .click();
  await expect(
    detail.getByRole("heading", { name: "项目会话 4", exact: true }),
  ).toBeVisible();
  await expect(detail.locator(".sx-turn")).toHaveCount(2);
  await expect(rows.nth(4).getByRole("button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await list.evaluate((element) => element.scrollTop)).toBe(scrollTop);

  for (const index of [3, 4, 3, 4]) {
    await rows
      .nth(index)
      .locator("td")
      .first()
      .click({ position: { x: 5, y: 5 } });
    await expect(
      detail.getByRole("heading", { name: `项目会话 ${index}`, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".aw-session-table .is-selected")).toHaveCount(1);
  }
  const button = rows.nth(3).getByRole("button");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  expect(
    calls.filter((call) => call.path === "/v1/admin/session-preprocess"),
  ).toHaveLength(reads);
});

test("sessions never show prior filter content while the next request is pending", async ({
  page,
}) => {
  await setup(page, "/admin/sessions");
  await expect(page.locator(".aw-session-table tbody tr")).toHaveCount(10);
  const release = Promise.withResolvers<void>();
  await page.route("**/v1/admin/session-preprocess?**", async (route) => {
    await release.promise;
    await route.fallback();
  });
  try {
    await page.getByLabel("会话项目").selectOption("数据服务");
    await expect(page.getByText("加载会话", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "会话详情" }),
    ).not.toContainText("监控查询性能优化");
    await expect(page.getByTitle("下一页", { exact: true })).toBeDisabled();
  } finally {
    release.resolve();
  }
  await expect(page.locator(".aw-session-table tbody tr")).toHaveCount(5);
});

test("weekly page shows the full report of the chosen period, or approved work while it is pending", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page, "/admin/reports");
  const periods = page.getByRole("navigation", { name: "报告周期" });
  await expect(periods.getByRole("button")).toHaveCount(14);
  // The newest period with a report opens in place; there is no separate detail page to visit.
  await expect(
    page.getByRole("heading", { name: "团队报告版本 2" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "查看完整报告" })).toHaveCount(0);
  await page.getByRole("button", { name: "复制周报" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "版本 2 的报告正文",
  );
  await expect(page.getByLabel("报告版本")).toHaveCount(0);
  // A period without a generated report lists approved cards only and folds members without any.
  await periods.getByRole("button").nth(1).click();
  const pending = page.getByRole("article");
  await expect(pending).toContainText("该周期的团队周报尚未生成");
  await expect(pending).toContainText("归档完整摘要 1-0");
  await expect(pending).not.toContainText("归档完整摘要 1-1");
  await expect(pending).toContainText("本周没有已确认工作卡");
  await periods.getByRole("button").first().click();
  await expect(
    page.getByRole("heading", { name: "团队报告版本 2" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/reports$/);
});

for (const [path, title, endpoint] of [
  ["/admin/team-settings", "团队管理", "/v1/admin/overview"],
  ["/admin/reviews", "工作卡审核", "/v1/admin/overview"],
  ["/admin/sessions", "会话预处理", "/v1/admin/session-preprocess"],
  ["/admin/reports", "周报与工作卡", "/v1/admin/report-archive"],
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
    await expect(
      page.locator(".aw-table tbody tr, .wr-periods button").first(),
    ).toBeVisible();
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
      ["团队管理", "settings"],
      ["工作卡审核", "reviews"],
      ["会话预处理", "sessions"],
      ["周报与工作卡", "archive"],
    ]) {
      await page
        .locator(".sidebar nav")
        .getByRole("link", { name, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".aw-table tbody tr, .wr-periods button").first(),
      ).toBeVisible();
      await noOverflow();
      await page.screenshot({
        path: testInfo.outputPath(`${slug}-${width}.png`),
        fullPage: true,
      });
      if (slug === "settings" || slug === "sessions") {
        await page.locator(".aw-record-button").first().click();
        await expect(
          page.getByRole("region", {
            name: slug === "settings" ? "人员详情" : "会话详情",
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
    expect(errors).toEqual([]);
  });
}
