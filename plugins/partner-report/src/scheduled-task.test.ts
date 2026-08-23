import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installScheduledCollectionTask,
  SCHEDULED_COLLECTION_TASK_ID,
} from "./scheduled-task.js";

function testHome() {
  return mkdtempSync(resolve(tmpdir(), "partner-report-scheduled-task-test-"));
}

describe("projectless scheduled task installation", () => {
  it("creates the official task without a project", () => {
    const codexHome = testHome();
    try {
      const installed = installScheduledCollectionTask({
        codexHome,
        now: () => 1_787_289_116_663,
        uniqueId: () => "fixed-id",
      });
      expect(installed).toEqual({
        status: "created",
        taskId: SCHEDULED_COLLECTION_TASK_ID,
      });
      const taskPath = resolve(
        codexHome,
        "automations",
        SCHEDULED_COLLECTION_TASK_ID,
        "automation.toml",
      );
      const source = readFileSync(taskPath, "utf8");
      expect(source).toContain('kind = "cron"');
      expect(source).toContain('target = { type = "projectless" }');
      expect(source).toContain('cwds = ["~"]');
      expect(source).not.toContain("project_id");
      expect(source).not.toContain('target = { type = "project"');
      expect(source).toContain(
        'rrule = "RRULE:FREQ=DAILY;BYHOUR=16;BYMINUTE=0"',
      );
      expect(source).toContain('model = "gpt-5.6-sol"');
      expect(source).toContain('reasoning_effort = "medium"');
      expect(statSync(taskPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("preserves an existing same-name task exactly", () => {
    const codexHome = testHome();
    const taskDirectory = resolve(codexHome, "automations", "custom-task");
    const taskPath = resolve(taskDirectory, "automation.toml");
    const custom = [
      "version = 1",
      'id = "custom-task"',
      'name = "Partner Report daily collection"',
      'prompt = "用户自己的 Prompt"',
      'rrule = "RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=30"',
      'target = { type = "projectless" }',
      "",
    ].join("\n");
    mkdirSync(taskDirectory, { recursive: true });
    writeFileSync(taskPath, custom);
    try {
      expect(installScheduledCollectionTask({ codexHome })).toEqual({
        status: "existing",
        taskId: "custom-task",
      });
      expect(readFileSync(taskPath, "utf8")).toBe(custom);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("does not overwrite an unrelated task that uses the preferred id", () => {
    const codexHome = testHome();
    const occupied = resolve(
      codexHome,
      "automations",
      SCHEDULED_COLLECTION_TASK_ID,
    );
    mkdirSync(occupied, { recursive: true });
    writeFileSync(
      resolve(occupied, "automation.toml"),
      'id = "partner-report-daily-collection"\nname = "其他任务"\n',
    );
    try {
      const installed = installScheduledCollectionTask({
        codexHome,
        uniqueId: () => "12345678-rest",
      });
      expect(installed).toEqual({
        status: "created",
        taskId: "partner-report-daily-collection-12345678",
      });
      expect(
        readFileSync(resolve(occupied, "automation.toml"), "utf8"),
      ).toContain('name = "其他任务"');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("returns a safe failure without throwing when Codex home is not writable", () => {
    const codexHome = testHome();
    chmodSync(codexHome, 0o500);
    try {
      const installed = installScheduledCollectionTask({ codexHome });
      if (process.getuid?.() === 0) return;
      expect(installed).toMatchObject({
        status: "failed",
        errorCode: "SCHEDULED_TASK_CREATE_FAILED",
      });
    } finally {
      chmodSync(codexHome, 0o700);
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
