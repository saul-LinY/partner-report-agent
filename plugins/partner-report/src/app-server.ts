import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { PLUGIN_VERSION } from "./config.js";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ThreadListOptions = {
  updatedSince?: string | number;
};

export const CODEX_THREAD_LIST_TIMEOUT_MS = 120_000;
export const CODEX_THREAD_READ_TIMEOUT_MS = 60_000;
export const CODEX_THREAD_TURNS_PAGE_LIMIT = 100;
export const MINIMUM_CODEX_APP_SERVER_VERSION = "0.149.0";

export type CodexThreadReadFailureCode =
  | "CODEX_THREAD_READ_FAILED"
  | "CODEX_THREAD_TURNS_LIST_FAILED"
  | "CODEX_THREAD_HISTORY_INVALID";

function threadReadError(
  code: CodexThreadReadFailureCode,
  message: string,
  cause?: unknown,
) {
  const error = new Error(message, { cause }) as Error & {
    code: CodexThreadReadFailureCode;
  };
  error.code = code;
  return error;
}

function paginatedThreadReadError(cause: unknown) {
  if (
    cause instanceof Error &&
    cause.message.includes("invalid paginated history lineage")
  ) {
    return threadReadError(
      "CODEX_THREAD_HISTORY_INVALID",
      "Codex Session 分页历史无效。",
      cause,
    );
  }
  return threadReadError(
    "CODEX_THREAD_TURNS_LIST_FAILED",
    "Codex Session 分页内容读取失败。",
    cause,
  );
}

type CodexBinaryProbe = (candidate: string) => string | null;

function versionCore(value: string) {
  const match = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/i.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionIsCompatible(value: string) {
  const actual = versionCore(value);
  const minimum = versionCore(`codex-cli ${MINIMUM_CODEX_APP_SERVER_VERSION}`)!;
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index])
      return actual[index]! > minimum[index]!;
  }
  return true;
}

function probeCodexBinary(candidate: string) {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || null;
}

export function selectCodexBinary(
  options: {
    explicit?: string;
    candidates?: string[];
    probe?: CodexBinaryProbe;
  } = {},
) {
  const explicit = options.explicit ?? process.env.CODEX_BIN;
  const candidates = explicit
    ? [explicit]
    : (options.candidates ?? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        "codex",
      ]);
  const probe = options.probe ?? probeCodexBinary;
  const inspected: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    const version = probe(candidate);
    if (!version) continue;
    inspected.push(`${candidate} (${version})`);
    if (versionIsCompatible(version)) return candidate;
  }
  const error = new Error(
    `未找到兼容的 Codex app-server，需要 codex-cli >= ${MINIMUM_CODEX_APP_SERVER_VERSION}${inspected.length ? `；已检查：${inspected.join("、")}` : ""}。`,
  ) as Error & { code: string };
  error.code = "CODEX_APP_SERVER_INCOMPATIBLE";
  throw error;
}

function createTimeoutError(method: string, timeoutMs: number) {
  const error = new Error(
    `${method} timed out after ${timeoutMs}ms`,
  ) as Error & {
    code: string;
  };
  error.code =
    method === "thread/list"
      ? "CODEX_SESSION_LIST_TIMEOUT"
      : "CODEX_APP_SERVER_TIMEOUT";
  return error;
}

function timestamp(value: unknown) {
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value !== "number") return Number.NaN;
  return value > 10_000_000_000 ? value : value * 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function threadUpdatedAt(thread: Record<string, unknown>) {
  return timestamp(
    thread.updatedAt ??
      thread.updated_at ??
      thread.createdAt ??
      thread.created_at,
  );
}

export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";

  private readonly codexBin: string;
  private readonly workingDirectory: string;

  constructor(codexBin?: string, workingDirectory = homedir()) {
    this.codexBin = codexBin ?? selectCodexBinary();
    this.workingDirectory = workingDirectory;
  }

  async connect() {
    this.process = spawn(
      this.codexBin,
      [
        "app-server",
        "--stdio",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin",
      ],
      {
        cwd: this.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id);
      if (message.error)
        waiting.reject(
          new Error(message.error.message ?? "Codex app-server request failed"),
        );
      else waiting.resolve(message.result);
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.process.on("exit", (code) => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(
          new Error(
            `Codex app-server exited (${code ?? "unknown"}): ${this.stderr}`,
          ),
        );
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: {
        name: "partner_report",
        title: "Partner Report",
        version: PLUGIN_VERSION,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000) {
    if (!this.process) throw new Error("Codex app-server 尚未连接。");
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    if (!this.process) throw new Error("Codex app-server 尚未连接。");
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async listThreads(options: ThreadListOptions = {}) {
    const threads: any[] = [];
    let cursor: string | null = null;
    const updatedSince =
      options.updatedSince === undefined
        ? null
        : timestamp(options.updatedSince);
    if (updatedSince !== null && !Number.isFinite(updatedSince))
      throw new Error("Session 活动扫描开始时间无效。");
    let page = 0;
    do {
      page += 1;
      let result: any;
      try {
        result = await this.request(
          "thread/list",
          {
            ...(cursor ? { cursor } : {}),
            limit: 100,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: ["cli", "vscode", "appServer"],
            archived: false,
            useStateDbOnly: true,
          },
          CODEX_THREAD_LIST_TIMEOUT_MS,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderr = this.stderr.trim();
        const wrapped = new Error(
          `thread/list 第 ${page} 页失败：${message}${stderr ? `；Codex app-server: ${stderr}` : ""}`,
        );
        Object.assign(wrapped, {
          code:
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "CODEX_SESSION_LIST_FAILED",
        });
        throw wrapped;
      }
      const data: Record<string, unknown>[] = Array.isArray(result.data)
        ? result.data.filter(isRecord)
        : [];
      const activity = data.map((thread) => ({
        thread,
        updatedAt: threadUpdatedAt(thread),
      }));
      const recent =
        updatedSince === null
          ? data
          : activity
              .filter((item) => item.updatedAt >= updatedSince)
              .map((item) => item.thread);
      threads.push(...recent);
      const reachedCutoff =
        updatedSince !== null &&
        activity.some(
          (item) =>
            Number.isFinite(item.updatedAt) && item.updatedAt < updatedSince,
        );
      cursor = reachedCutoff ? null : (result.nextCursor ?? null);
    } while (cursor && threads.length < 2_000);
    return threads;
  }

  async readThread(threadId: string) {
    let thread: any;
    try {
      const result = await this.request(
        "thread/read",
        { threadId, includeTurns: false },
        CODEX_THREAD_READ_TIMEOUT_MS,
      );
      thread = result.thread;
    } catch (error) {
      throw threadReadError(
        "CODEX_THREAD_READ_FAILED",
        "Codex Session 摘要读取失败。",
        error,
      );
    }

    if (thread?.historyMode !== "paginated") {
      try {
        const result = await this.request(
          "thread/read",
          { threadId, includeTurns: true },
          CODEX_THREAD_READ_TIMEOUT_MS,
        );
        return result.thread;
      } catch (error) {
        throw threadReadError(
          "CODEX_THREAD_READ_FAILED",
          "Codex Session 内容读取失败。",
          error,
        );
      }
    }

    const turns: any[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      let result: any;
      try {
        result = await this.request(
          "thread/turns/list",
          {
            threadId,
            ...(cursor ? { cursor } : {}),
            limit: CODEX_THREAD_TURNS_PAGE_LIMIT,
            sortDirection: "asc",
            itemsView: "full",
          },
          CODEX_THREAD_READ_TIMEOUT_MS,
        );
      } catch (error) {
        throw paginatedThreadReadError(error);
      }
      if (!Array.isArray(result.data)) {
        throw threadReadError(
          "CODEX_THREAD_TURNS_LIST_FAILED",
          "Codex Session 分页内容响应无效。",
        );
      }
      turns.push(...result.data);
      const nextCursor =
        typeof result.nextCursor === "string" && result.nextCursor
          ? result.nextCursor
          : null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw threadReadError(
          "CODEX_THREAD_TURNS_LIST_FAILED",
          "Codex Session 分页游标重复。",
        );
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return { ...thread, turns };
  }

  close() {
    if (!this.process) return;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.process = null;
  }
}
