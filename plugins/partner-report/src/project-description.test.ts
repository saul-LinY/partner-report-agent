import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectDescriptionSource,
  projectDescriptionIsChinese,
} from "./project-description.js";

describe("project description source", () => {
  it("uses bounded semantic files without exposing paths or secrets", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-description-"));
    try {
      mkdirSync(resolve(root, "src"));
      mkdirSync(resolve(root, "node_modules"));
      writeFileSync(
        resolve(root, "README.md"),
        "面向团队的周报采集和审核平台。 api_key=abcdefghijklmnop",
      );
      writeFileSync(
        resolve(root, "package.json"),
        JSON.stringify({
          name: "partner-report",
          description: "团队报告系统",
          scripts: { secret: "do-not-upload" },
        }),
      );
      const source = buildProjectDescriptionSource({
        projectName: "partner-report",
        localRoot: root,
        rootFingerprint: "a".repeat(64),
      });
      const serialized = JSON.stringify(source);
      expect(source?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(serialized).toContain("[REDACTED_SECRET]");
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain("do-not-upload");
      expect(serialized).not.toContain("node_modules");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects semantic changes and requires Chinese output", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-description-"));
    try {
      writeFileSync(resolve(root, "README.md"), "项目用于生成团队报告。");
      const first = buildProjectDescriptionSource({
        projectName: "report",
        localRoot: root,
        rootFingerprint: "b".repeat(64),
      });
      writeFileSync(
        resolve(root, "README.md"),
        "项目用于采集工作记录、审核并生成团队报告。",
      );
      const second = buildProjectDescriptionSource({
        projectName: "report",
        localRoot: root,
        rootFingerprint: "b".repeat(64),
      });
      expect(first?.sourceFingerprint).not.toBe(second?.sourceFingerprint);
      expect(projectDescriptionIsChinese("这是项目描述")).toBe(true);
      expect(projectDescriptionIsChinese("project description")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
