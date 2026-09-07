import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`groups owners and nests blockers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const progress =
      "本周完善了主要使用流程，已完成全面测试，用户可以完成从创建到查看结果的操作。".repeat(
        4,
      );
    const table = `## 项目人员与工作明细\n\n| 项目负责人 | 项目名称 | 较上周进展 |\n| --- | --- | --- |\n| Saul 林勇 | Headroom_MVP | ${progress} |\n| Saul 林勇 | partner-report-agent | ${progress} |\n| Leon | marketing | ${progress} |`;
    const versions = [
      {
        version: 3,
        markdown: `${table}\n\n## 项目阻塞\n\n- **Saul 林勇**\n  - **Headroom_MVP**\n    - 开发账户未登录，无法完成真机测试。\n  - **partner-report-agent**\n    - 外部服务暂不可用，发布暂停。`,
      },
      {
        version: 2,
        markdown: `${table}\n\n## 项目阻塞\n\n- **Saul 林勇 · Headroom_MVP**\n  - 开发账户未登录，无法完成真机测试。\n- **Saul 林勇 · partner-report-agent**\n  - 外部服务暂不可用，发布暂停。`,
      },
      {
        version: 1,
        markdown: `${table}\n\n## 项目阻塞\n\n- Saul 林勇 · Headroom_MVP：开发账户未登录，无法完成真机测试。\n- Saul 林勇 · partner-report-agent：外部服务暂不可用，发布暂停。`,
      },
    ].map((v) => ({
      ...v,
      id: `v${v.version}`,
      title: "团队周报 2026-W35",
      summary: "本周推进了产品验证和团队协作能力。",
      created_at: "2026-09-07T08:00:00Z",
      payload: {},
    }));
    await page.route("**/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/v1/me")
        return route.fulfill({
          json: {
            userId: "admin",
            tenantId: "test",
            teamId: "team",
            roles: ["admin"],
            email: "admin@example.test",
            displayName: "管理员",
            teamName: "产品团队",
          },
        });
      if (path === "/v1/admin/team-reports/layout")
        return route.fulfill({
          json: {
            report: {
              id: "layout",
              period_key: "2026-W35",
              status: "LOCKED",
              current_version: 3,
            },
            current: versions[0],
            versions,
          },
        });
      return route.fulfill({ json: {} });
    });
    await page.goto("/admin/team-reports/layout");
    const document = page.locator(".report-document");
    for (const version of [3, 2, 1]) {
      if (version !== 3)
        await page
          .getByRole("button", { name: new RegExp(`^v${version}`) })
          .click();
      const owner = document
        .locator("td:visible")
        .filter({ hasText: /^Saul 林勇$/ });
      await expect(owner).toHaveCount(1);
      await expect(owner).toHaveAttribute("rowspan", "2");
      await expect(document.locator("tbody tr")).toHaveCount(3);
      await expect(
        document.locator("tbody tr").nth(1).locator("td:visible"),
      ).toHaveCount(2);
      await expect(document.locator(":scope > ul > li > strong")).toHaveText([
        "Saul 林勇",
      ]);
      await expect(
        document.locator(":scope > ul > li > ul > li > strong"),
      ).toHaveText(["Headroom_MVP", "partner-report-agent"]);
      await expect(
        document.locator(":scope > ul > li > ul > li > ul > li"),
      ).toHaveText([
        "开发账户未登录，无法完成真机测试。",
        "外部服务暂不可用，发布暂停。",
      ]);
    }
    const firstProject = await document
      .locator("tbody tr")
      .nth(0)
      .locator("td")
      .nth(1)
      .boundingBox();
    const secondProject = await document
      .locator("tbody tr")
      .nth(1)
      .locator("td")
      .nth(1)
      .boundingBox();
    expect(Math.abs(firstProject!.x - secondProject!.x)).toBeLessThan(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/partner-report-layout-${width}.png`,
      fullPage: true,
    });
  });
}
