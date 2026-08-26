import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SCHEDULED_COLLECTION_TASK } from "./collection-config.js";

export const SCHEDULED_COLLECTION_TASK_ID = "partner-report-daily-collection";

export type ScheduledTaskInstallation =
  | { status: "required" | "existing"; taskId: string }
  | {
      status: "failed";
      errorCode: "SCHEDULED_TASK_CREATE_FAILED";
      message: string;
    };

type InstallOptions = {
  codexHome?: string;
};

function topLevelString(source: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`^${escapedKey}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"),
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as string;
  } catch {
    return null;
  }
}

function existingTaskId(automationsRoot: string) {
  if (!existsSync(automationsRoot)) return null;
  for (const entry of readdirSync(automationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskPath = resolve(automationsRoot, entry.name, "automation.toml");
    if (!existsSync(taskPath)) continue;
    let source: string;
    try {
      source = readFileSync(taskPath, "utf8");
    } catch {
      continue;
    }
    if (topLevelString(source, "name") !== SCHEDULED_COLLECTION_TASK.name)
      continue;
    return topLevelString(source, "id") ?? entry.name;
  }
  return null;
}

export function installScheduledCollectionTask(
  options: InstallOptions = {},
): ScheduledTaskInstallation {
  try {
    const codexHome = resolve(
      options.codexHome ??
        process.env.CODEX_HOME ??
        resolve(homedir(), ".codex"),
    );
    const automationsRoot = resolve(codexHome, "automations");
    const existing = existingTaskId(automationsRoot);
    if (existing) return { status: "existing", taskId: existing };
    // Codex owns scheduled task persistence. The Skill creates the task through
    // the official automation tool using the structured config returned by MCP.
    return { status: "required", taskId: SCHEDULED_COLLECTION_TASK_ID };
  } catch (error) {
    return {
      status: "failed",
      errorCode: "SCHEDULED_TASK_CREATE_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "Codex Scheduled Task 创建失败。",
    };
  }
}
