import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SCHEDULED_COLLECTION_TASK } from "./collection-config.js";

export const SCHEDULED_COLLECTION_TASK_ID =
  "partner-report-daily-collection";

export type ScheduledTaskInstallation =
  | { status: "created" | "existing"; taskId: string }
  | { status: "failed"; errorCode: "SCHEDULED_TASK_CREATE_FAILED"; message: string };

type InstallOptions = {
  codexHome?: string;
  now?: () => number;
  uniqueId?: () => string;
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

function tomlString(value: string) {
  return JSON.stringify(value);
}

function renderTask(taskId: string, timestamp: number) {
  return [
    "version = 1",
    `id = ${tomlString(taskId)}`,
    'kind = "cron"',
    `name = ${tomlString(SCHEDULED_COLLECTION_TASK.name)}`,
    `prompt = ${tomlString(SCHEDULED_COLLECTION_TASK.prompt)}`,
    'status = "ACTIVE"',
    `rrule = ${tomlString(SCHEDULED_COLLECTION_TASK.schedule.rrule)}`,
    `model = ${tomlString(SCHEDULED_COLLECTION_TASK.model)}`,
    `reasoning_effort = ${tomlString(SCHEDULED_COLLECTION_TASK.reasoningEffort)}`,
    'execution_environment = "local"',
    'target = { type = "projectless" }',
    'cwds = ["~"]',
    `created_at = ${timestamp}`,
    `updated_at = ${timestamp}`,
    "",
  ].join("\n");
}

function taskIdForCreate(automationsRoot: string, uniqueId: () => string) {
  const preferred = resolve(automationsRoot, SCHEDULED_COLLECTION_TASK_ID);
  if (!existsSync(preferred)) return SCHEDULED_COLLECTION_TASK_ID;
  return `${SCHEDULED_COLLECTION_TASK_ID}-${uniqueId().slice(0, 8)}`;
}

export function installScheduledCollectionTask(
  options: InstallOptions = {},
): ScheduledTaskInstallation {
  try {
    const codexHome = resolve(
      options.codexHome ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
    );
    const automationsRoot = resolve(codexHome, "automations");
    const existing = existingTaskId(automationsRoot);
    if (existing) return { status: "existing", taskId: existing };

    mkdirSync(automationsRoot, { recursive: true, mode: 0o700 });
    const uniqueId = options.uniqueId ?? randomUUID;
    const taskId = taskIdForCreate(automationsRoot, uniqueId);
    const taskDirectory = resolve(automationsRoot, taskId);
    mkdirSync(taskDirectory, { mode: 0o700 });

    const target = resolve(taskDirectory, "automation.toml");
    const temporary = resolve(taskDirectory, `.automation-${uniqueId()}.tmp`);
    try {
      writeFileSync(temporary, renderTask(taskId, (options.now ?? Date.now)()), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      linkSync(temporary, target);
      chmodSync(target, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { status: "created", taskId };
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
