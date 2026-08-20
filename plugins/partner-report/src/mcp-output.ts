import { readFileSync } from "node:fs";

export type CliOutput = Record<string, unknown>;

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
  } else if (nextCommand.startsWith("project-scope-card-wait")) {
    const deadline = Number(nextCommand.match(/--deadline\s+(\d+)/)?.[1]);
    const attempt = Number(nextCommand.match(/--attempt\s+(\d+)/)?.[1]);
    nextTool = {
      name: "project_scope_card_wait",
      arguments: {
        periodKey: result.periodKey,
        version: result.policyVersion,
        deadline,
        attempt,
        force: nextCommand.includes("--force"),
      },
    };
  }
  return nextTool ? { ...rest, nextTool } : rest;
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
