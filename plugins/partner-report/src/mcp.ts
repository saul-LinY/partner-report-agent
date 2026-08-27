import { execFile } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PLUGIN_VERSION } from "./config.js";
import {
  exposeJobInput,
  withBeijingDisplayTimes,
  withNextTool,
  withoutInternalPaths,
  type CliOutput,
} from "./mcp-output.js";

const execFileAsync = promisify(execFile);
const cliPath =
  process.env.PARTNER_REPORT_CLI_PATH ??
  resolve(import.meta.dirname, "cli.mjs");

function parseCliOutput(raw: string) {
  const value = JSON.parse(raw.trim()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Partner Report CLI 返回了无效结果。");
  }
  return value as CliOutput;
}

async function invokeCli(command: string, args: string[] = []) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, command, ...args],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180_000,
      },
    );
    return parseCliOutput(stdout);
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String(error.stderr).trim();
      if (stderr) {
        try {
          throw Object.assign(new Error("Partner Report 命令执行失败。"), {
            result: parseCliOutput(stderr),
          });
        } catch (parseError) {
          if (
            parseError &&
            typeof parseError === "object" &&
            "result" in parseError
          )
            throw parseError;
        }
      }
    }
    throw error;
  }
}

async function currentJob(runPath: string, jobId: string) {
  const result = await invokeCli("collect-next", ["--run", runPath]);
  if (
    !["job", "project_description_job"].includes(String(result.status)) ||
    typeof result.resultPath !== "string"
  ) {
    throw Object.assign(new Error("当前 Run 没有等待模型提交的 Job。"), {
      result,
    });
  }
  if (result.jobId !== jobId) {
    throw Object.assign(new Error("提交的 Job 已过期或与当前 Job 不匹配。"), {
      result: withoutInternalPaths(result),
    });
  }
  return result;
}

async function submitResult(
  runPath: string,
  jobId: string,
  result: unknown,
  expectedStatus: "job" | "project_description_job",
) {
  const current = await currentJob(runPath, jobId);
  if (current.status !== expectedStatus) {
    throw Object.assign(new Error("提交类型与当前 Job 不匹配。"), {
      result: withoutInternalPaths(current),
    });
  }
  writeFileSync(
    current.resultPath as string,
    `${JSON.stringify(result, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  chmodSync(current.resultPath as string, 0o600);
  const command =
    expectedStatus === "job" ? "collect-submit" : "project-description-submit";
  return invokeCli(command, [
    "--run",
    runPath,
    "--result",
    current.resultPath as string,
  ]);
}

function toolResult(result: CliOutput) {
  const prepared = withBeijingDisplayTimes(withNextTool(result));
  return {
    content: [{ type: "text" as const, text: JSON.stringify(prepared) }],
    structuredContent: prepared,
  };
}

function toolError(error: unknown) {
  const result =
    error && typeof error === "object" && "result" in error
      ? (error.result as CliOutput)
      : {
          status: "error",
          code:
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "MCP_TOOL_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

let commandQueue = Promise.resolve();
function execute(operation: () => Promise<CliOutput>) {
  const pending = commandQueue.then(operation, operation);
  commandQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending.then(toolResult, toolError);
}

const server = new McpServer({
  name: "partner-report",
  version: PLUGIN_VERSION,
});

const networkWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const localWrite = { ...networkWrite, openWorldHint: false };
const networkRead = {
  ...networkWrite,
  readOnlyHint: true,
  idempotentHint: true,
};
const localRead = { ...networkRead, openWorldHint: false };

// Keep the SDK's deeply recursive registerTool generics out of the plugin-wide
// typecheck. Zod still validates every tool input at runtime.
const registerTool = server.registerTool.bind(server) as (
  name: string,
  config: {
    description: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
    annotations: Record<string, boolean>;
  },
  handler: (args: any) => unknown,
) => void;

registerTool(
  "connect",
  {
    description:
      "连接 Partner Report，扫描首次项目，并仅在飞书项目权限卡成功送达后完成绑定。",
    inputSchema: {
      serverUrl: z.string().url(),
      bindingCode: z.string().min(1),
      deviceName: z.string().min(1).optional(),
      allowInsecureHttp: z.boolean().default(false),
    },
    annotations: networkWrite,
  },
  ({ serverUrl, bindingCode, deviceName, allowInsecureHttp }) =>
    execute(() =>
      invokeCli("connect", [
        "--server",
        serverUrl,
        "--binding-code",
        bindingCode,
        ...(deviceName ? ["--device-name", deviceName] : []),
        ...(allowInsecureHttp ? ["--allow-insecure-http"] : []),
      ]),
    ),
);

registerTool(
  "connectivity_test",
  {
    description: "验证已有 Partner Report 连接，并继续未完成的首次项目发现。",
    annotations: networkWrite,
  },
  () => execute(() => invokeCli("connectivity-test")),
);

registerTool(
  "server_url_set",
  {
    description: "保留现有绑定和状态，只更新数据中台地址并验证连接。",
    inputSchema: {
      serverUrl: z.string().url(),
      allowInsecureHttp: z.boolean().default(false),
    },
    annotations: networkWrite,
  },
  ({ serverUrl, allowInsecureHttp }) =>
    execute(() =>
      invokeCli("server-url-set", [
        "--server",
        serverUrl,
        ...(allowInsecureHttp ? ["--allow-insecure-http"] : []),
      ]),
    ),
);

registerTool(
  "migrate_credentials",
  {
    description: "把旧版 macOS Keychain 凭据一次性迁移到插件稳定数据目录。",
    annotations: localWrite,
  },
  () => execute(() => invokeCli("migrate-credentials")),
);

registerTool(
  "scheduled_task_config",
  {
    description: "返回 Partner Report 官方定时任务的默认配置。",
    annotations: localRead,
  },
  () => execute(() => invokeCli("scheduled-task-config")),
);

registerTool(
  "collect_start",
  {
    description: "启动一次采集 Run；普通运行不得设置 force。",
    inputSchema: { force: z.boolean().default(false) },
    annotations: networkWrite,
  },
  ({ force }) =>
    execute(() => invokeCli("collect-start", force ? ["--force"] : [])),
);

registerTool(
  "collect_next",
  {
    description: "推进一个采集 Run，并在需要模型处理时直接返回单个 Job 输入。",
    inputSchema: { runPath: z.string().min(1) },
    annotations: networkWrite,
  },
  ({ runPath }) =>
    execute(async () =>
      exposeJobInput(await invokeCli("collect-next", ["--run", runPath])),
    ),
);

registerTool(
  "collect_submit",
  {
    description: "提交当前 Session Job 的结构化模型结果并执行校验和上传。",
    inputSchema: {
      runPath: z.string().min(1),
      jobId: z.string().min(1),
      result: z.record(z.unknown()),
    },
    annotations: networkWrite,
  },
  ({ runPath, jobId, result }) =>
    execute(() => submitResult(runPath, jobId, result, "job")),
);

registerTool(
  "project_description_submit",
  {
    description: "提交当前项目描述 Job 的结构化模型结果。",
    inputSchema: {
      runPath: z.string().min(1),
      jobId: z.string().min(1),
      result: z.record(z.unknown()),
    },
    annotations: networkWrite,
  },
  ({ runPath, jobId, result }) =>
    execute(() =>
      submitResult(runPath, jobId, result, "project_description_job"),
    ),
);

registerTool(
  "collect_skip",
  {
    description: "仅按校验结果安全跳过连续失败或敏感输出的当前 Job。",
    inputSchema: {
      runPath: z.string().min(1),
      jobId: z.string().min(1),
      errorCode: z.enum(["EXTRACT_FAILED", "SENSITIVE_EGRESS_REJECTED"]),
      causeCode: z.string().min(1).optional(),
    },
    annotations: localWrite,
  },
  ({ runPath, jobId, errorCode, causeCode }) =>
    execute(() =>
      invokeCli("collect-skip", [
        "--run",
        runPath,
        "--job",
        jobId,
        "--error-code",
        errorCode,
        ...(causeCode ? ["--cause-code", causeCode] : []),
      ]),
    ),
);

registerTool(
  "collect_defer",
  {
    description: "安全延后当前 Run，并保留未处理队列供下次运行。",
    inputSchema: {
      runPath: z.string().min(1),
      reason: z.enum([
        "TIME_BUDGET_EXHAUSTED",
        "RUN_INTERRUPTED",
        "TEMPORARILY_UNAVAILABLE",
      ]),
    },
    annotations: localWrite,
  },
  ({ runPath, reason }) =>
    execute(() =>
      invokeCli("collect-defer", ["--run", runPath, "--reason", reason]),
    ),
);

registerTool(
  "collect_review",
  {
    description: "执行独立终态审查；只有 completed 且无 nextTool 才能结束。",
    inputSchema: { runPath: z.string().min(1) },
    annotations: networkWrite,
  },
  ({ runPath }) =>
    execute(() => invokeCli("collect-review", ["--run", runPath])),
);

registerTool(
  "status",
  {
    description: "查询连接、采集游标、排除项和项目权限聚合状态。",
    annotations: networkRead,
  },
  () => execute(() => invokeCli("status")),
);

registerTool(
  "project_scope_list",
  {
    description: "查询数据中台中的项目采集权限。",
    annotations: networkRead,
  },
  () => execute(() => invokeCli("project-scope-list")),
);

registerTool(
  "exclusion_set",
  {
    description: "添加或移除 Session 或绝对目录排除项。",
    inputSchema: {
      kind: z.enum(["session", "path"]),
      value: z.string().min(1),
      excluded: z.boolean().default(true),
    },
    annotations: localWrite,
  },
  ({ kind, value, excluded }) =>
    execute(() =>
      invokeCli(`${excluded ? "exclude" : "include"}-${kind}`, [
        kind === "session" ? "--session-id" : "--path",
        value,
      ]),
    ),
);

await server.connect(new StdioServerTransport());
