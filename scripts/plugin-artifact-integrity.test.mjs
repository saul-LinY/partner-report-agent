import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PARTNER_REPORT_RUNTIME_ARTIFACTS,
  pluginArtifactMismatches,
} from "./plugin-artifact-integrity.mjs";

function writeArtifacts(root, content = "current") {
  for (const relativePath of PARTNER_REPORT_RUNTIME_ARTIFACTS) {
    const path = resolve(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${content}:${relativePath}\n`);
  }
}

describe("plugin artifact integrity", () => {
  it("accepts an installed plugin that matches the source runtime", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-artifacts-"));
    const source = resolve(root, "source");
    const installed = resolve(root, "installed");
    try {
      writeArtifacts(source);
      writeArtifacts(installed);
      expect(pluginArtifactMismatches(source, installed)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports stale and missing runtime files", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-artifacts-"));
    const source = resolve(root, "source");
    const installed = resolve(root, "installed");
    try {
      writeArtifacts(source);
      writeArtifacts(installed);
      writeFileSync(resolve(installed, "dist/cli.mjs"), "stale\n");
      rmSync(resolve(installed, "dist/mcp.mjs"));
      expect(pluginArtifactMismatches(source, installed)).toEqual([
        "dist/cli.mjs",
        "dist/mcp.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
