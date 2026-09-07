import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

describe("separate plugin editions", () => {
  it("keeps the existing team marketplace on the legacy edition", () => {
    const marketplace = json(".agents/plugins/marketplace.json");
    const source = marketplace.plugins.find(
      (plugin) => plugin.name === "partner-report",
    ).source.path;
    expect(source).toBe("./plugins/partner-report");
    expect(json(`${source}/package.json`).version).toBe("2.0.0");
    expect(
      json(`${source}/.codex-plugin/plugin.json`).version.split("+")[0],
    ).toBe("2.0.0");
  });

  it("keeps independent runtimes for legacy bootstrap and central resolution", () => {
    const legacy = read("plugins/partner-report/dist/cli.mjs");
    const modern = read("plugins/v2/partner-report/dist/cli.mjs");
    expect(legacy).toContain('"/v1/project-scope/bootstrap"');
    expect(legacy).not.toContain('"/v2/project-scope/resolve"');
    expect(modern).toContain('"/v2/project-scope/resolve"');
    expect(modern).not.toContain('"/v1/project-scope/bootstrap"');
    expect(json("plugins/v2/partner-report/package.json").version).toBe(
      "2.1.0",
    );
    expect(
      json("plugins/v2/partner-report/.codex-plugin/plugin.json").name,
    ).toBe("partner-report");
  });
});
