#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const configureOnly = process.argv.includes("--configure-only");
const selector =
  process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ??
  "partner-report@partner-report-marketplace";
let installedPath = null;

if (!configureOnly) {
  const separator = selector.lastIndexOf("@");
  const marketplaceName = separator > 0 ? selector.slice(separator + 1) : null;
  if (marketplaceName) {
    const marketplaces = JSON.parse(
      execFileSync("codex", ["plugin", "marketplace", "list", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    const marketplace = marketplaces.marketplaces?.find(
      (entry) => entry.name === marketplaceName,
    );
    if (marketplace && marketplace.marketplaceSource?.sourceType !== "local") {
      execFileSync(
        "codex",
        ["plugin", "marketplace", "upgrade", marketplaceName, "--json"],
        { stdio: "inherit" },
      );
    }
  }
  const installed = JSON.parse(
    execFileSync("codex", ["plugin", "add", selector, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  installedPath = installed.installedPath ?? null;
  process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
}

const listing = JSON.parse(
  execFileSync("codex", ["plugin", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const plugin = listing.installed?.find(
  (entry) =>
    entry.enabled &&
    (entry.pluginId === selector ||
      (!selector.includes("@") && entry.name === selector)),
);
const pluginPath = installedPath ?? plugin?.source?.path;
if (!pluginPath) {
  throw new Error("没有找到已启用的 partner-report 插件。");
}

const setupPath = resolve(pluginPath, "dist/setup.mjs");
if (!existsSync(setupPath)) {
  throw new Error(
    "已安装版本缺少 dist/setup.mjs，请升级 Partner Report 插件。",
  );
}
execFileSync(process.execPath, [setupPath], { stdio: "inherit" });
process.stdout.write(
  "Partner Report 已安装并完成插件级 MCP 授权。请重启 Codex 并新建对话。\n",
);
