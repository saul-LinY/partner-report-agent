import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  it("requests official creation without writing Codex files", () => {
    const codexHome = testHome();
    try {
      const installed = installScheduledCollectionTask({ codexHome });
      expect(installed).toEqual({
        status: "required",
        taskId: SCHEDULED_COLLECTION_TASK_ID,
      });
      expect(
        existsSync(
          resolve(
            codexHome,
            "automations",
            SCHEDULED_COLLECTION_TASK_ID,
            "automation.toml",
          ),
        ),
      ).toBe(false);
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
      const installed = installScheduledCollectionTask({ codexHome });
      expect(installed).toEqual({
        status: "required",
        taskId: SCHEDULED_COLLECTION_TASK_ID,
      });
      expect(
        readFileSync(resolve(occupied, "automation.toml"), "utf8"),
      ).toContain('name = "其他任务"');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("returns a safe failure when the automation root cannot be scanned", () => {
    const codexHome = testHome();
    writeFileSync(resolve(codexHome, "automations"), "not-a-directory");
    try {
      const installed = installScheduledCollectionTask({ codexHome });
      expect(installed).toMatchObject({
        status: "failed",
        errorCode: "SCHEDULED_TASK_CREATE_FAILED",
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
