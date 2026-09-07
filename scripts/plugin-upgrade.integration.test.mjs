import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { pluginArtifactMismatches } from "./plugin-artifact-integrity.mjs";

const integration = process.env.RUN_PLUGIN_INSTALL_TESTS === "1" ? it : it.skip;
integration(
  "updates the same plugin selector from 2.0 to 2.1 without touching retained 2.0 or device state",
  () => {
    const temporary = mkdtempSync(
      resolve(tmpdir(), "partner-report-upgrade-test-"),
    );
    const repository = resolve(import.meta.dirname, "..");
    const fixture = resolve(temporary, "marketplace");
    const codexRoot = resolve(temporary, "codex");
    const dataRoot = resolve(temporary, "data");
    const run = (...args) =>
      JSON.parse(
        execFileSync("codex", [...args, "--json"], {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: codexRoot,
            PARTNER_REPORT_DATA: dataRoot,
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 20_000,
        }),
      );
    const manifest = (root) =>
      JSON.parse(
        readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"),
      );
    try {
      mkdirSync(codexRoot, { recursive: true });
      mkdirSync(dataRoot, { recursive: true });
      const state = {
        "config.json": '{"pluginInstanceId":"existing-test-device"}',
        "secrets.json": '{"access":"test-only"}',
        "project-scope.json": '{"version":23}',
        "collection-state.json": '{"checkpoint":"preserved"}',
      };
      for (const [name, contents] of Object.entries(state))
        writeFileSync(resolve(dataRoot, name), contents);
      for (const directory of [
        "plugins/partner-report",
        "plugins/v2/partner-report",
      ]) {
        mkdirSync(resolve(fixture, directory), { recursive: true });
        for (const path of [
          ".codex-plugin",
          ".mcp.json",
          "assets",
          "dist",
          "schemas",
          "skills",
          "package.json",
        ])
          cpSync(
            resolve(repository, directory, path),
            resolve(fixture, directory, path),
            { recursive: true },
          );
      }
      const marketplace = JSON.parse(
        readFileSync(
          resolve(repository, ".agents/plugins/marketplace.json"),
          "utf8",
        ),
      );
      const currentEntry = marketplace.plugins.find(
        (plugin) => plugin.name === "partner-report",
      );
      const publishedSource = currentEntry.source.path;
      currentEntry.source.path = "./plugins/partner-report";
      const marketplacePath = resolve(
        fixture,
        ".agents/plugins/marketplace.json",
      );
      mkdirSync(resolve(fixture, ".agents/plugins"), { recursive: true });
      writeFileSync(marketplacePath, JSON.stringify(marketplace));
      run("plugin", "marketplace", "add", fixture);
      const selector = "partner-report@partner-report-marketplace";
      const previous = run("plugin", "add", selector);
      expect(manifest(previous.installedPath).version.split("+")[0]).toBe(
        "2.0.0",
      );

      currentEntry.source.path = publishedSource;
      writeFileSync(marketplacePath, JSON.stringify(marketplace));
      expect(manifest(previous.installedPath).version.split("+")[0]).toBe(
        "2.0.0",
      );
      const updated = run("plugin", "add", selector);
      expect(manifest(updated.installedPath).version.split("+")[0]).toBe(
        "2.1.0",
      );
      expect(
        pluginArtifactMismatches(
          resolve(repository, "plugins/v2/partner-report"),
          updated.installedPath,
        ),
      ).toEqual([]);
      expect(
        manifest(resolve(fixture, "plugins/partner-report")).version.split(
          "+",
        )[0],
      ).toBe("2.0.0");
      const enabled = run("plugin", "list").installed.filter(
        (plugin) => plugin.name === "partner-report" && plugin.enabled,
      );
      expect(enabled).toHaveLength(1);
      expect(enabled[0].pluginId).toBe(selector);
      for (const [name, contents] of Object.entries(state))
        expect(readFileSync(resolve(dataRoot, name), "utf8")).toBe(contents);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  60_000,
);
