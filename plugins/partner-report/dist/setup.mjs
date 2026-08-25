#!/usr/bin/env node

// src/setup.ts
import { resolve as resolve2 } from "node:path";

// src/app-server.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// src/config.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
var PLUGIN_VERSION = "1.1.0";
var DATA_DIRECTORY_SERVICE = "partner-report:data-directory";
var BOOTSTRAP_CONFIG_SERVICE = "partner-report:bootstrap-config";
var LEGACY_PARTNER_REPORT_APP_GROUP = "9RN69TVL38.partnerreport.shared";
var LEGACY_PARTNER_REPORT_DATA_DIRECTORY = "PartnerReportPluginData";
function readKeychainValue(service) {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", "partner-report", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || null;
  } catch {
    return null;
  }
}
function legacyMacOSAppGroupDirectory(home = homedir()) {
  return resolve(
    home,
    "Library",
    "Group Containers",
    LEGACY_PARTNER_REPORT_APP_GROUP,
    LEGACY_PARTNER_REPORT_DATA_DIRECTORY
  );
}
function defaultDataDirectory(home = homedir(), _platform = process.platform) {
  return resolve(home, ".partner-report-data");
}
function migratePersistentDataDirectory(source, target, removeSource = false) {
  const sourceDirectory = resolve(source);
  const targetDirectory = resolve(target);
  if (sourceDirectory === targetDirectory || !existsSync(sourceDirectory))
    return;
  mkdirSync(dirname(targetDirectory), { recursive: true, mode: 448 });
  for (const entry of readdirSync(sourceDirectory)) {
    if (entry === "collection.lock" || entry.startsWith(".write-probe-") || entry.endsWith(".tmp"))
      rmSync(resolve(sourceDirectory, entry), { recursive: true, force: true });
  }
  if (removeSource && !existsSync(targetDirectory)) {
    try {
      renameSync(sourceDirectory, targetDirectory);
      return;
    } catch {
    }
  }
  mkdirSync(targetDirectory, { recursive: true, mode: 448 });
  for (const entry of readdirSync(sourceDirectory)) {
    const sourcePath = resolve(sourceDirectory, entry);
    const targetPath = resolve(targetDirectory, entry);
    if (!existsSync(targetPath))
      cpSync(sourcePath, targetPath, {
        recursive: true,
        preserveTimestamps: true
      });
  }
  if (removeSource) rmSync(sourceDirectory, { recursive: true, force: true });
}
function prepareWritableDataDirectory(directory) {
  const location = resolve(directory);
  mkdirSync(location, { recursive: true, mode: 448 });
  const probePath = resolve(location, `.write-probe-${randomUUID()}`);
  let descriptor = null;
  try {
    descriptor = openSync(probePath, "wx", 384);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(probePath)) unlinkSync(probePath);
  }
  return location;
}
function selectWritableDataDirectory(candidates, prepare = prepareWritableDataDirectory) {
  const uniqueCandidates = [
    ...new Set(candidates.filter((value) => Boolean(value)))
  ];
  let lastError;
  for (const candidate of uniqueCandidates) {
    try {
      return prepare(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(
    new Error(
      "Partner Report \u672C\u5730\u6570\u636E\u76EE\u5F55\u4E0D\u53EF\u5199\u3002\u8BF7\u5141\u8BB8\u672C\u6B21\u4EFB\u52A1\u5199\u5165\u63D2\u4EF6\u6570\u636E\u76EE\u5F55\u540E\u91CD\u8BD5\u3002",
      { cause: lastError }
    ),
    { code: "LOCAL_DATA_WRITE_PERMISSION_REQUIRED" }
  );
}
function dataDirectory() {
  const runtimeDirectory = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  const explicitDirectory = process.env.PARTNER_REPORT_DATA;
  const stableDirectory = defaultDataDirectory();
  if (!explicitDirectory && process.platform === "darwin")
    migratePersistentDataDirectory(
      legacyMacOSAppGroupDirectory(),
      stableDirectory,
      true
    );
  const location = selectWritableDataDirectory(
    explicitDirectory ? [explicitDirectory] : [stableDirectory, runtimeDirectory]
  );
  if (!explicitDirectory) {
    for (const legacyDirectory of [runtimeDirectory]) {
      if (legacyDirectory)
        migratePersistentDataDirectory(legacyDirectory, location, true);
    }
  }
  return location;
}
function configPath() {
  return resolve(dataDirectory(), "config.json");
}
function fallbackSecretsPath() {
  return resolve(dataDirectory(), "secrets.json");
}
function loadConfig(required = true) {
  const path = configPath();
  if (!existsSync(path)) {
    if (required)
      throw new Error("Plugin \u5C1A\u672A\u8FDE\u63A5\u3002\u8BF7\u5148\u8FD0\u884C partner-report connect\u3002");
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
function saveConfig(config) {
  const directory = dataDirectory();
  const path = resolve(directory, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  chmodSync(path, 384);
}
function keychainService(instanceId, kind) {
  return `partner-report:${instanceId}:${kind}`;
}
function saveFileSecret(instanceId, kind, value) {
  const path = fallbackSecretsPath();
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  existing[`${instanceId}:${kind}`] = value;
  writeFileSync(path, `${JSON.stringify(existing)}
`, { mode: 384 });
  chmodSync(path, 384);
}
function loadSecret(instanceId, kind) {
  const path = fallbackSecretsPath();
  if (existsSync(path)) {
    const secrets = JSON.parse(readFileSync(path, "utf8"));
    const value = secrets[`${instanceId}:${kind}`];
    if (value) return value;
  }
  const legacyValue = readKeychainValue(keychainService(instanceId, kind));
  if (legacyValue) {
    saveFileSecret(instanceId, kind, legacyValue);
    return legacyValue;
  }
  throw Object.assign(new Error(`Plugin ${kind} Token \u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002`), {
    code: process.platform === "darwin" ? "CREDENTIAL_MIGRATION_REQUIRED" : "PLUGIN_TOKEN_MISSING"
  });
}
function migrateLegacyInstallation() {
  const target = dataDirectory();
  const rememberedDirectory = readKeychainValue(DATA_DIRECTORY_SERVICE);
  if (rememberedDirectory)
    migratePersistentDataDirectory(rememberedDirectory, target);
  let config = loadConfig(false);
  if (!config) {
    const bootstrap = readKeychainValue(BOOTSTRAP_CONFIG_SERVICE);
    if (bootstrap) {
      config = JSON.parse(bootstrap);
      saveConfig(config);
    }
  }
  if (!config) return { status: "not_connected", migratedSecrets: 0 };
  let migratedSecrets = 0;
  for (const kind of ["access", "refresh", "recovery"]) {
    const path = fallbackSecretsPath();
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8"))[`${config.pluginInstanceId}:${kind}`] : null;
    if (existing) continue;
    const value = readKeychainValue(
      keychainService(config.pluginInstanceId, kind)
    );
    if (!value) continue;
    saveFileSecret(config.pluginInstanceId, kind, value);
    migratedSecrets += 1;
  }
  loadSecret(config.pluginInstanceId, "access");
  loadSecret(config.pluginInstanceId, "refresh");
  return { status: "credentials_ready", migratedSecrets };
}

// src/app-server.ts
var CODEX_THREAD_LIST_TIMEOUT_MS = 12e4;
var CODEX_THREAD_READ_TIMEOUT_MS = 6e4;
var CODEX_THREAD_TURNS_PAGE_LIMIT = 100;
function threadReadError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}
function paginatedThreadReadError(cause) {
  if (cause instanceof Error && cause.message.includes("invalid paginated history lineage")) {
    return threadReadError(
      "CODEX_THREAD_HISTORY_INVALID",
      "Codex Session \u5206\u9875\u5386\u53F2\u65E0\u6548\u3002",
      cause
    );
  }
  return threadReadError(
    "CODEX_THREAD_TURNS_LIST_FAILED",
    "Codex Session \u5206\u9875\u5185\u5BB9\u8BFB\u53D6\u5931\u8D25\u3002",
    cause
  );
}
function validFullHistoryThread(value) {
  return isRecord(value) && Array.isArray(value.turns) && value.turns.length > 0;
}
function createTimeoutError(method, timeoutMs) {
  const error = new Error(
    `${method} timed out after ${timeoutMs}ms`
  );
  error.code = method === "thread/list" ? "CODEX_SESSION_LIST_TIMEOUT" : "CODEX_APP_SERVER_TIMEOUT";
  return error;
}
function timestamp(value) {
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value !== "number") return Number.NaN;
  return value > 1e10 ? value : value * 1e3;
}
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function threadUpdatedAt(thread) {
  return timestamp(
    thread.updatedAt ?? thread.updated_at ?? thread.createdAt ?? thread.created_at
  );
}
var CodexAppServer = class {
  constructor(codexBin = process.env.CODEX_BIN ?? "codex") {
    this.codexBin = codexBin;
  }
  process = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  stderr = "";
  async connect() {
    this.process = spawn(
      this.codexBin,
      [
        "app-server",
        "--stdio",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message;
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
          new Error(message.error.message ?? "Codex app-server request failed")
        );
      else waiting.resolve(message.result);
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4e3);
    });
    this.process.on("exit", (code) => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(
          new Error(
            `Codex app-server exited (${code ?? "unknown"}): ${this.stderr}`
          )
        );
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: {
        name: "partner_report",
        title: "Partner Report",
        version: PLUGIN_VERSION
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify("initialized", {});
  }
  request(method, params, timeoutMs = 3e4) {
    if (!this.process) throw new Error("Codex app-server \u5C1A\u672A\u8FDE\u63A5\u3002");
    const id = this.nextId++;
    return new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve3, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}
`);
    });
  }
  notify(method, params) {
    if (!this.process) throw new Error("Codex app-server \u5C1A\u672A\u8FDE\u63A5\u3002");
    this.process.stdin.write(`${JSON.stringify({ method, params })}
`);
  }
  async listThreads(options = {}) {
    const threads = [];
    let cursor = null;
    const updatedSince = options.updatedSince === void 0 ? null : timestamp(options.updatedSince);
    if (updatedSince !== null && !Number.isFinite(updatedSince))
      throw new Error("Session \u6D3B\u52A8\u626B\u63CF\u5F00\u59CB\u65F6\u95F4\u65E0\u6548\u3002");
    let page = 0;
    do {
      page += 1;
      let result;
      try {
        result = await this.request(
          "thread/list",
          {
            ...cursor ? { cursor } : {},
            limit: 100,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: ["cli", "vscode", "appServer"],
            archived: false,
            useStateDbOnly: true
          },
          CODEX_THREAD_LIST_TIMEOUT_MS
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderr = this.stderr.trim();
        const wrapped = new Error(
          `thread/list \u7B2C ${page} \u9875\u5931\u8D25\uFF1A${message}${stderr ? `\uFF1BCodex app-server: ${stderr}` : ""}`
        );
        Object.assign(wrapped, {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "CODEX_SESSION_LIST_FAILED"
        });
        throw wrapped;
      }
      const data = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
      const activity = data.map((thread) => ({
        thread,
        updatedAt: threadUpdatedAt(thread)
      }));
      const recent = updatedSince === null ? data : activity.filter((item) => item.updatedAt >= updatedSince).map((item) => item.thread);
      threads.push(...recent);
      const reachedCutoff = updatedSince !== null && activity.some(
        (item) => Number.isFinite(item.updatedAt) && item.updatedAt < updatedSince
      );
      cursor = reachedCutoff ? null : result.nextCursor ?? null;
    } while (cursor && threads.length < 2e3);
    return threads;
  }
  async readThread(threadId) {
    let thread;
    try {
      const result = await this.request(
        "thread/read",
        { threadId, includeTurns: false },
        CODEX_THREAD_READ_TIMEOUT_MS
      );
      thread = result.thread;
    } catch (error) {
      throw threadReadError(
        "CODEX_THREAD_READ_FAILED",
        "Codex Session \u6458\u8981\u8BFB\u53D6\u5931\u8D25\u3002",
        error
      );
    }
    if (thread?.historyMode !== "paginated") {
      try {
        const result = await this.request(
          "thread/read",
          { threadId, includeTurns: true },
          CODEX_THREAD_READ_TIMEOUT_MS
        );
        return result.thread;
      } catch (error) {
        throw threadReadError(
          "CODEX_THREAD_READ_FAILED",
          "Codex Session \u5185\u5BB9\u8BFB\u53D6\u5931\u8D25\u3002",
          error
        );
      }
    }
    const turns = [];
    const seenCursors = /* @__PURE__ */ new Set();
    let cursor = null;
    do {
      let result;
      try {
        result = await this.request(
          "thread/turns/list",
          {
            threadId,
            ...cursor ? { cursor } : {},
            limit: CODEX_THREAD_TURNS_PAGE_LIMIT,
            sortDirection: "asc",
            itemsView: "full"
          },
          CODEX_THREAD_READ_TIMEOUT_MS
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("invalid paginated history lineage")) {
          try {
            const fallback = await this.request(
              "thread/read",
              { threadId, includeTurns: true },
              CODEX_THREAD_READ_TIMEOUT_MS
            );
            if (validFullHistoryThread(fallback.thread)) return fallback.thread;
          } catch {
          }
        }
        throw paginatedThreadReadError(error);
      }
      if (!Array.isArray(result.data)) {
        throw threadReadError(
          "CODEX_THREAD_TURNS_LIST_FAILED",
          "Codex Session \u5206\u9875\u5185\u5BB9\u54CD\u5E94\u65E0\u6548\u3002"
        );
      }
      turns.push(...result.data);
      const nextCursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw threadReadError(
          "CODEX_THREAD_TURNS_LIST_FAILED",
          "Codex Session \u5206\u9875\u6E38\u6807\u91CD\u590D\u3002"
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
};

// src/setup-config.ts
var PARTNER_REPORT_MCP_CONFIG_EDITS = [
  {
    keyPath: 'plugins."partner-report".mcp_servers."partner-report".enabled',
    value: true,
    mergeStrategy: "replace"
  },
  {
    keyPath: 'plugins."partner-report".mcp_servers."partner-report".default_tools_approval_mode',
    value: "approve",
    mergeStrategy: "replace"
  }
];
async function configurePartnerReportMcp(client, configFile2) {
  const response = await client.request("config/batchWrite", {
    edits: PARTNER_REPORT_MCP_CONFIG_EDITS,
    ...configFile2 ? { filePath: configFile2 } : {},
    reloadUserConfig: !configFile2
  });
  if (!configFile2) await client.request("config/mcpServer/reload", {});
  return response;
}

// src/setup.ts
function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : void 0;
}
var configFile = option("config-file");
var server = new CodexAppServer();
try {
  await server.connect();
  const config = await configurePartnerReportMcp(
    server,
    configFile ? resolve2(configFile) : void 0
  );
  const credentials = migrateLegacyInstallation();
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "partner_report_ready",
        scope: "partner-report MCP only",
        config,
        credentials
      },
      null,
      2
    )}
`
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "setup_failed",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "PARTNER_REPORT_SETUP_FAILED",
      message: error instanceof Error ? error.message : String(error)
    })}
`
  );
  process.exitCode = 1;
} finally {
  server.close();
}
