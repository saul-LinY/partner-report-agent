#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pluginArtifactMismatches } from "./plugin-artifact-integrity.mjs";

const configureOnly = process.argv.includes("--configure-only");
const explicitSelector = process.argv.find(
  (value, index) => index > 1 && !value.startsWith("--"),
);
const repositoryRoot = resolve(import.meta.dirname, "..");
const sourcePluginPath = resolve(repositoryRoot, "plugins/partner-report");
const marketplacePath = resolve(
  repositoryRoot,
  ".agents/plugins/marketplace.json",
);
const codexRoot =
  process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex");
const pluginCreatorScripts = resolve(
  codexRoot,
  "skills/.system/plugin-creator/scripts",
);

function pluginCreatorHelper(name) {
  const path = resolve(pluginCreatorScripts, name);
  if (!existsSync(path)) {
    throw new Error(`缺少 Codex plugin-creator helper：${path}`);
  }
  return path;
}

function readMarketplaceName() {
  return execFileSync(
    "python3",
    [
      pluginCreatorHelper("read_marketplace_name.py"),
      "--marketplace-path",
      marketplacePath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  ).trim();
}

const marketplaceName = explicitSelector
  ? null
  : configureOnly
    ? "partner-report-marketplace"
    : readMarketplaceName();
const selector = explicitSelector ?? `partner-report@${marketplaceName}`;
let installedPath = null;

if (!configureOnly) {
  if (!explicitSelector) {
    execFileSync("npm", ["run", "build", "-w", "@partner-report/plugin"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    execFileSync(
      "python3",
      [pluginCreatorHelper("update_plugin_cachebuster.py"), sourcePluginPath],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
  }
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

if (installedPath && !explicitSelector) {
  const mismatches = pluginArtifactMismatches(sourcePluginPath, installedPath);
  if (mismatches.length > 0) {
    throw new Error(
      `安装产物与仓库不一致：${mismatches.join(", ")}。请勿继续测试。`,
    );
  }
  process.stdout.write("Partner Report 安装产物校验通过。\n");
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
