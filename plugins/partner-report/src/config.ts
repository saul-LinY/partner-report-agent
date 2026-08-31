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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const PLUGIN_VERSION = "2.1.0";

export type PluginConfig = {
  serverUrl: string;
  pluginInstanceId: string;
  deviceName: string;
  connectedAt?: string;
  accessExpiresAt: string;
  connectivityStatus?: "pending" | "verified" | "failed" | "expired";
  connectivityVerifiedAt?: string;
  pendingConnectivityChallenge?: {
    value: string;
    expiresAt: string;
  };
  pendingAuthRecovery?: {
    requestedAt: string;
    expiresAt: string;
  };
  excludedSessionIds: string[];
  excludedPaths: string[];
};

const DATA_DIRECTORY_SERVICE = "partner-report:data-directory";
const BOOTSTRAP_CONFIG_SERVICE = "partner-report:bootstrap-config";
const LEGACY_PARTNER_REPORT_APP_GROUP = "9RN69TVL38.partnerreport.shared";
const LEGACY_PARTNER_REPORT_DATA_DIRECTORY = "PartnerReportPluginData";

export function normalizeServerUrl(value: string, allowInsecureHttp = false) {
  const raw = value.trim();
  if (!raw) throw new Error("数据中台地址不能为空。");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("数据中台地址不是有效 URL。");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("数据中台地址只支持 http:// 或 https://。");
  }
  if (url.username || url.password) {
    throw new Error("数据中台地址不能包含用户名或密码。");
  }
  if (url.search || url.hash) {
    throw new Error("数据中台地址不能包含查询参数或锚点。");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (
    url.protocol === "http:" &&
    !loopbackHosts.has(url.hostname) &&
    !allowInsecureHttp
  ) {
    throw new Error(
      "远程数据中台必须使用 HTTPS。仅本机地址可直接使用 HTTP；测试内网 HTTP 时显式添加 --allow-insecure-http。",
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function readKeychainValue(service: string) {
  if (process.platform !== "darwin") return null;
  try {
    return (
      execFileSync(
        "security",
        ["find-generic-password", "-a", "partner-report", "-s", service, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null
    );
  } catch {
    return null;
  }
}

export function legacyMacOSAppGroupDirectory(home = homedir()) {
  return resolve(
    home,
    "Library",
    "Group Containers",
    LEGACY_PARTNER_REPORT_APP_GROUP,
    LEGACY_PARTNER_REPORT_DATA_DIRECTORY,
  );
}

export function defaultDataDirectory(
  home = homedir(),
  _platform = process.platform,
) {
  return resolve(home, ".partner-report-data");
}

export function migratePersistentDataDirectory(
  source: string,
  target: string,
  removeSource = false,
) {
  const sourceDirectory = resolve(source);
  const targetDirectory = resolve(target);
  if (sourceDirectory === targetDirectory || !existsSync(sourceDirectory))
    return;

  mkdirSync(dirname(targetDirectory), { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(sourceDirectory)) {
    if (
      entry === "collection.lock" ||
      entry.startsWith(".write-probe-") ||
      entry.endsWith(".tmp")
    )
      rmSync(resolve(sourceDirectory, entry), { recursive: true, force: true });
  }
  if (removeSource && !existsSync(targetDirectory)) {
    try {
      renameSync(sourceDirectory, targetDirectory);
      return;
    } catch {
      // Cross-volume moves fall back to a verified recursive copy below.
    }
  }

  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(sourceDirectory)) {
    const sourcePath = resolve(sourceDirectory, entry);
    const targetPath = resolve(targetDirectory, entry);
    if (!existsSync(targetPath))
      cpSync(sourcePath, targetPath, {
        recursive: true,
        preserveTimestamps: true,
      });
  }
  if (removeSource) rmSync(sourceDirectory, { recursive: true, force: true });
}

function prepareWritableDataDirectory(directory: string) {
  const location = resolve(directory);
  mkdirSync(location, { recursive: true, mode: 0o700 });
  const probePath = resolve(location, `.write-probe-${randomUUID()}`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(probePath, "wx", 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(probePath)) unlinkSync(probePath);
  }
  return location;
}

export function selectWritableDataDirectory(
  candidates: Array<string | null | undefined>,
  prepare = prepareWritableDataDirectory,
) {
  const uniqueCandidates = [
    ...new Set(candidates.filter((value): value is string => Boolean(value))),
  ];
  let lastError: unknown;
  for (const candidate of uniqueCandidates) {
    try {
      return prepare(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(
    new Error(
      "Partner Report 本地数据目录不可写。请允许本次任务写入插件数据目录后重试。",
      { cause: lastError },
    ),
    { code: "LOCAL_DATA_WRITE_PERMISSION_REQUIRED" },
  );
}

export function dataDirectory() {
  const runtimeDirectory =
    process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  const explicitDirectory = process.env.PARTNER_REPORT_DATA;
  const stableDirectory = defaultDataDirectory();
  if (!explicitDirectory && process.platform === "darwin")
    migratePersistentDataDirectory(
      legacyMacOSAppGroupDirectory(),
      stableDirectory,
      true,
    );
  const location = selectWritableDataDirectory(
    explicitDirectory
      ? [explicitDirectory]
      : [stableDirectory, runtimeDirectory],
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

export function loadConfig(required = true): PluginConfig | null {
  const path = configPath();
  if (!existsSync(path)) {
    if (required)
      throw new Error("Plugin 尚未连接。请先运行 partner-report connect。");
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as PluginConfig;
}

export function saveConfig(config: PluginConfig) {
  const directory = dataDirectory();
  const path = resolve(directory, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

type SecretKind = "access" | "refresh" | "recovery";

function keychainService(instanceId: string, kind: SecretKind) {
  return `partner-report:${instanceId}:${kind}`;
}

function saveFileSecret(instanceId: string, kind: SecretKind, value: string) {
  const path = fallbackSecretsPath();
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)
    : {};
  existing[`${instanceId}:${kind}`] = value;
  writeFileSync(path, `${JSON.stringify(existing)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function saveSecret(
  instanceId: string,
  kind: SecretKind,
  value: string,
) {
  saveFileSecret(instanceId, kind, value);
}

export function loadSecret(instanceId: string, kind: SecretKind) {
  const path = fallbackSecretsPath();
  if (existsSync(path)) {
    const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      string
    >;
    const value = secrets[`${instanceId}:${kind}`];
    if (value) return value;
  }

  throw Object.assign(new Error(`Plugin ${kind} Token 不存在，请重新连接。`), {
    code: "PLUGIN_TOKEN_MISSING",
  });
}

export function migrateLegacyInstallation() {
  const target = dataDirectory();
  const rememberedDirectory = readKeychainValue(DATA_DIRECTORY_SERVICE);
  if (rememberedDirectory)
    migratePersistentDataDirectory(rememberedDirectory, target);

  let config = loadConfig(false);
  if (!config) {
    const bootstrap = readKeychainValue(BOOTSTRAP_CONFIG_SERVICE);
    if (bootstrap) {
      config = JSON.parse(bootstrap) as PluginConfig;
      saveConfig(config);
    }
  }
  if (!config) return { status: "not_connected", migratedSecrets: 0 };

  let migratedSecrets = 0;
  for (const kind of ["access", "refresh", "recovery"] as const) {
    const path = fallbackSecretsPath();
    const existing = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)[
          `${config.pluginInstanceId}:${kind}`
        ]
      : null;
    if (existing) continue;
    const value = readKeychainValue(
      keychainService(config.pluginInstanceId, kind),
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
      new Error("旧版 macOS 凭据迁移失败，请重新连接。", { cause: error }),
      { code: "CREDENTIAL_MIGRATION_REQUIRED" },
    );
  }
  return { status: "credentials_ready", migratedSecrets };
}

export function removeSecrets(instanceId: string) {
  const path = fallbackSecretsPath();
  if (!existsSync(path)) return;
  const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    string
  >;
  delete secrets[`${instanceId}:access`];
  delete secrets[`${instanceId}:refresh`];
  delete secrets[`${instanceId}:recovery`];
  writeFileSync(path, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
}

export function removeSecret(instanceId: string, kind: SecretKind) {
  const path = fallbackSecretsPath();
  if (!existsSync(path)) return;
  const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    string
  >;
  delete secrets[`${instanceId}:${kind}`];
  writeFileSync(path, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
}
