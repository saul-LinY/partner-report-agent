#!/usr/bin/env node

// src/setup.ts
import { resolve as resolve3 } from "node:path";

// src/app-server.ts
import {
  spawn,
  spawnSync
} from "node:child_process";
import { homedir as homedir2 } from "node:os";
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
var PLUGIN_VERSION = "2.1.0";
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
  throw Object.assign(new Error(`Plugin ${kind} Token \u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002`), {
    code: "PLUGIN_TOKEN_MISSING"
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
  try {
    loadSecret(config.pluginInstanceId, "access");
    loadSecret(config.pluginInstanceId, "refresh");
  } catch (error) {
    throw Object.assign(
      new Error("\u65E7\u7248 macOS \u51ED\u636E\u8FC1\u79FB\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002", { cause: error }),
      { code: "CREDENTIAL_MIGRATION_REQUIRED" }
    );
  }
  return { status: "credentials_ready", migratedSecrets };
}

// src/telemetry.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  readFileSync as readFileSync2,
  renameSync as renameSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { resolve as resolve2 } from "node:path";
var invocationId = randomUUID2();
var invocationCommand = process.argv[2]?.slice(0, 80) || "plugin";
var invocationSequence = 0;
var activeRunId;
var OUTBOX_FILE = "plugin-log-outbox.json";
var MAX_PENDING_EVENTS = 2e3;
function outboxPath() {
  return resolve2(dataDirectory(), OUTBOX_FILE);
}
function readOutbox() {
  const path = outboxPath();
  if (!existsSync2(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeOutbox(events) {
  const path = outboxPath();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync2(temporary, `${JSON.stringify(events, null, 2)}
`, {
    mode: 384
  });
  chmodSync2(temporary, 384);
  renameSync2(temporary, path);
  chmodSync2(path, 384);
}
function safeDetails(details) {
  if (!details) return void 0;
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key]) => !/path|session|transcript|prompt|token|secret|authorization|credential/i.test(
        key
      )
    )
  );
}
function tryWriteOutbox(events) {
  try {
    writeOutbox(events);
    return true;
  } catch {
    return false;
  }
}
function buildPendingPluginLog(input, defaults) {
  const details = safeDetails(input.details);
  const eventRunId = input.runId ?? defaults.runId;
  return {
    eventId: input.eventId ?? randomUUID2(),
    invocationId: input.invocationId ?? defaults.invocationId,
    sequence: input.sequence ?? defaults.sequence,
    command: (input.command ?? defaults.command).slice(0, 80),
    eventType: input.eventType ?? (input.level === "error" ? "error" : input.eventCode === "command.started" || input.eventCode === "command.completed" ? "lifecycle" : "progress"),
    level: input.level,
    stage: input.stage.slice(0, 80),
    eventCode: input.eventCode.slice(0, 120),
    message: input.message.slice(0, 4e3),
    occurredAt: input.occurredAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    retryable: input.retryable ?? false,
    ...eventRunId ? { runId: eventRunId } : {},
    ...input.stack ? { stack: input.stack.slice(0, 16e3) } : {},
    ...input.attempt !== void 0 ? { attempt: input.attempt } : {},
    ...input.durationMs !== void 0 ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {},
    ...input.requestId ? { requestId: input.requestId } : {},
    ...details ? { details } : {}
  };
}
function enqueuePluginLog(input) {
  try {
    if (!loadConfig(false)) return null;
    const event = buildPendingPluginLog(input, {
      invocationId,
      sequence: input.sequence ?? ++invocationSequence,
      command: invocationCommand,
      runId: activeRunId
    });
    const events = [...readOutbox(), event].slice(-MAX_PENDING_EVENTS);
    return tryWriteOutbox(events) ? event : null;
  } catch {
    return null;
  }
}

// src/timeouts.ts
var CODEX_THREAD_LIST_TIMEOUT_MS = 3e5;
var PARTNER_REPORT_MCP_TOOL_TIMEOUT_SEC = 700;

// src/app-server.ts
var CODEX_THREAD_READ_TIMEOUT_MS = 6e4;
var CODEX_THREAD_LIST_PAGE_LIMIT = 50;
var CODEX_THREAD_LIST_MAX_RESULTS = 2e3;
var CODEX_THREAD_TURNS_PAGE_LIMIT = 100;
var MINIMUM_CODEX_APP_SERVER_VERSION = "0.149.0";
var DEFAULT_CODEX_BINARY_CANDIDATES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "codex"
];
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
function versionCore(value) {
  const match = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/i.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
}
function versionIsCompatible(value) {
  const actual = versionCore(value);
  const minimum = versionCore(`codex-cli ${MINIMUM_CODEX_APP_SERVER_VERSION}`);
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index])
      return actual[index] > minimum[index];
  }
  return true;
}
function probeCodexBinary(candidate) {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5e3
  });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || null;
}
function codexBinarySource(candidate) {
  if (candidate === "/Applications/Codex.app/Contents/Resources/codex")
    return "codex_app_bundle";
  if (candidate === "/Applications/ChatGPT.app/Contents/Resources/codex")
    return "chatgpt_app_bundle";
  return "command";
}
function selectCodexBinary(options = {}) {
  const explicit = options.explicit ?? process.env.CODEX_BIN;
  const candidates = explicit ? [explicit] : options.candidates ?? DEFAULT_CODEX_BINARY_CANDIDATES;
  const probe = options.probe ?? probeCodexBinary;
  const inspected = [];
  for (const candidate of [...new Set(candidates)]) {
    const version = probe(candidate);
    if (!version) continue;
    inspected.push(`${candidate} (${version})`);
    if (versionIsCompatible(version)) return candidate;
  }
  const error = new Error(
    `\u672A\u627E\u5230\u517C\u5BB9\u7684 Codex app-server\uFF0C\u9700\u8981 codex-cli >= ${MINIMUM_CODEX_APP_SERVER_VERSION}${inspected.length ? `\uFF1B\u5DF2\u68C0\u67E5\uFF1A${inspected.join("\u3001")}` : ""}\u3002`
  );
  error.code = "CODEX_APP_SERVER_INCOMPATIBLE";
  throw error;
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
  process = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  stderr = "";
  codexBin;
  binarySource;
  codexVersion = null;
  workingDirectory;
  constructor(codexBin, workingDirectory = homedir2()) {
    this.codexBin = codexBin ?? selectCodexBinary();
    this.binarySource = codexBinarySource(this.codexBin);
    this.workingDirectory = workingDirectory;
  }
  async connect() {
    const startedAt = Date.now();
    this.codexVersion = probeCodexBinary(this.codexBin);
    enqueuePluginLog({
      level: "info",
      stage: "codex_app_server",
      eventCode: "app_server.starting",
      eventType: "lifecycle",
      message: "\u6B63\u5728\u542F\u52A8 Codex app-server\u3002",
      details: {
        binarySource: this.binarySource,
        codexVersion: this.codexVersion,
        transport: "stdio"
      }
    });
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
      {
        cwd: this.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"]
      }
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
    enqueuePluginLog({
      level: "info",
      stage: "codex_app_server",
      eventCode: "app_server.initialized",
      eventType: "lifecycle",
      message: "Codex app-server \u521D\u59CB\u5316\u5B8C\u6210\u3002",
      durationMs: Date.now() - startedAt,
      details: {
        binarySource: this.binarySource,
        codexVersion: this.codexVersion,
        transport: "stdio"
      }
    });
  }
  request(method, params, timeoutMs = 3e4) {
    if (!this.process) throw new Error("Codex app-server \u5C1A\u672A\u8FDE\u63A5\u3002");
    const id = this.nextId++;
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve4, reject, timer });
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
      const pageStartedAt = Date.now();
      const requestDetails = {
        binarySource: this.binarySource,
        codexVersion: this.codexVersion,
        transport: "stdio",
        page,
        pageSize: CODEX_THREAD_LIST_PAGE_LIMIT,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKindCount: 3,
        archived: false,
        useStateDbOnly: true,
        timeoutSeconds: CODEX_THREAD_LIST_TIMEOUT_MS / 1e3
      };
      enqueuePluginLog({
        level: "info",
        stage: "codex_thread_list",
        eventCode: "thread_list.page.started",
        eventType: "progress",
        message: `\u5F00\u59CB\u8BFB\u53D6 Codex \u4EFB\u52A1\u5217\u8868\u7B2C ${page} \u9875\u3002`,
        details: requestDetails
      });
      try {
        result = await this.request(
          "thread/list",
          {
            ...cursor ? { cursor } : {},
            limit: CODEX_THREAD_LIST_PAGE_LIMIT,
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
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "CODEX_SESSION_LIST_FAILED",
          details: {
            ...requestDetails,
            durationMs: Date.now() - pageStartedAt,
            appServerStderrPresent: Boolean(stderr)
          }
        });
        throw wrapped;
      }
      const data = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
      enqueuePluginLog({
        level: "info",
        stage: "codex_thread_list",
        eventCode: "thread_list.page.completed",
        eventType: "progress",
        message: `Codex \u4EFB\u52A1\u5217\u8868\u7B2C ${page} \u9875\u8BFB\u53D6\u5B8C\u6210\u3002`,
        durationMs: Date.now() - pageStartedAt,
        details: {
          ...requestDetails,
          resultCount: data.length,
          hasNextPage: Boolean(result.nextCursor)
        }
      });
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
    } while (cursor && threads.length < CODEX_THREAD_LIST_MAX_RESULTS);
    if (cursor)
      throw Object.assign(
        new Error("Session \u6D3B\u52A8\u626B\u63CF\u8D85\u8FC7\u5B89\u5168\u4E0A\u9650\uFF0C\u672A\u521B\u5EFA\u4E0D\u5B8C\u6574\u91C7\u96C6\u5FEB\u7167\u3002"),
        { code: "CODEX_SESSION_LIST_LIMIT_EXCEEDED" }
      );
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
  },
  {
    keyPath: 'plugins."partner-report".mcp_servers."partner-report".tool_timeout_sec',
    value: PARTNER_REPORT_MCP_TOOL_TIMEOUT_SEC,
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
    configFile ? resolve3(configFile) : void 0
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
