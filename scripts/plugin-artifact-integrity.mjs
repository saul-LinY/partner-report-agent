import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PARTNER_REPORT_RUNTIME_ARTIFACTS = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "dist/cli.mjs",
  "dist/mcp.mjs",
  "dist/setup.mjs",
  "skills/partner-report-sync/SKILL.md",
];

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function pluginArtifactMismatches(sourceRoot, installedRoot) {
  return PARTNER_REPORT_RUNTIME_ARTIFACTS.filter((relativePath) => {
    const sourcePath = resolve(sourceRoot, relativePath);
    const installedPath = resolve(installedRoot, relativePath);
    return (
      !existsSync(sourcePath) ||
      !existsSync(installedPath) ||
      digest(sourcePath) !== digest(installedPath)
    );
  });
}
