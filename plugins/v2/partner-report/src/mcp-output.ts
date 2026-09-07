import { readFileSync } from "node:fs";

export type CliOutput = Record<string, unknown>;

const BEIJING_TIME_KEYS = new Set([
  "collectionStartsAt",
  "collectionEndsAt",
  "scanStartsAt",
  "scanEndsAt",
  "collectionFloorAt",
  "lastSuccessfulRunStartedAt",
]);

function formatBeijingTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}（北京时间）`;
}

export function withBeijingDisplayTimes(result: CliOutput) {
  const displayed: CliOutput = {
    ...result,
    displayTimezone: "Asia/Shanghai",
  };
  for (const key of BEIJING_TIME_KEYS) {
    const value = displayed[key];
    if (typeof value === "string") displayed[key] = formatBeijingTime(value);
  }
  return displayed;
}

export function withoutInternalPaths(result: CliOutput) {
  const {
    inputPath: _input,
    resultPath: _result,
    resultSchema: _schema,
    ...safe
  } = result;
  return safe;
}

export function withNextTool(result: CliOutput) {
  const { nextCommand, ...rest } = result;
  if (typeof nextCommand !== "string") return rest;
  const runPath = typeof result.runPath === "string" ? result.runPath : null;
  if (!runPath) throw new Error("MCP 续跑结果缺少 runPath。");
  let nextTool: { name: string; arguments: Record<string, unknown> } | null =
    null;
  if (nextCommand.startsWith("collect-next") && runPath) {
    nextTool = { name: "collect_next", arguments: { runPath } };
  } else if (nextCommand.startsWith("collect-review") && runPath) {
    nextTool = { name: "collect_review", arguments: { runPath } };
  } else if (nextCommand.startsWith("collect-submit") && runPath) {
    nextTool = {
      name: "collect_submit",
      arguments: { runPath, jobId: result.jobId },
    };
  } else if (nextCommand.startsWith("project-description-submit") && runPath) {
    nextTool = {
      name: "project_description_submit",
      arguments: { runPath, jobId: result.jobId },
    };
  } else if (nextCommand.startsWith("collect-skip") && runPath) {
    const causeCode = nextCommand.match(/--cause-code\s+(\S+)/)?.[1];
    nextTool = {
      name: "collect_skip",
      arguments: {
        runPath,
        jobId: result.jobId,
        errorCode: result.errorCode,
        ...(causeCode ? { causeCode } : {}),
      },
    };
  }
  if (!nextTool) throw new Error(`MCP 不支持续跑指令：${nextCommand}`);
  return { ...rest, nextTool };
}

export function exposeJobInput(result: CliOutput) {
  if (
    !["job", "project_description_job"].includes(String(result.status)) ||
    typeof result.inputPath !== "string"
  ) {
    return result;
  }
  const jobInput = JSON.parse(
    readFileSync(result.inputPath, "utf8"),
  ) as unknown;
  return { ...withoutInternalPaths(result), jobInput };
}
