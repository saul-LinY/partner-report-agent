import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PLUGIN_VERSION = "1.0.0";

export type PluginConfig = {
  serverUrl: string;
  pluginInstanceId: string;
  deviceName: string;
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
const PERSISTENT_DATA_FILES = [
  "config.json",
  "collection-state.json",
  "project-scope.json",
  "secrets.json",
] as const;

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

function useKeychain() {
  return (
    process.platform === "darwin" &&
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1"
  );
}

function readKeychainValue(service: string) {
  if (!useKeychain()) return null;
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

function saveKeychainValue(service: string, value: string) {
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-a",
      "partner-report",
      "-s",
      service,
      "-w",
      value,
      "-U",
    ],
    { stdio: "ignore" },
  );
}

export function migratePersistentDataDirectory(source: string, target: string) {
  const sourceDirectory = resolve(source);
  const targetDirectory = resolve(target);
  if (sourceDirectory === targetDirectory || !existsSync(sourceDirectory))
    return;
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  for (const filename of PERSISTENT_DATA_FILES) {
    const sourcePath = resolve(sourceDirectory, filename);
    const targetPath = resolve(targetDirectory, filename);
    if (!existsSync(sourcePath) || existsSync(targetPath)) continue;
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o600);
  }
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
  const stableDirectory = resolve(homedir(), ".partner-report-data");
  const rememberedDirectory = useKeychain()
    ? readKeychainValue(DATA_DIRECTORY_SERVICE)
    : null;
  const existingRememberedDirectory =
    rememberedDirectory && existsSync(rememberedDirectory)
      ? rememberedDirectory
      : null;
  const location = selectWritableDataDirectory(
    explicitDirectory
      ? [explicitDirectory]
      : [existingRememberedDirectory, stableDirectory, runtimeDirectory],
  );
  if (!explicitDirectory) {
    for (const legacyDirectory of [
      rememberedDirectory,
      stableDirectory,
      runtimeDirectory,
    ]) {
      if (legacyDirectory)
        migratePersistentDataDirectory(legacyDirectory, location);
    }
    if (
      useKeychain() &&
      (!rememberedDirectory || resolve(rememberedDirectory) !== location)
    ) {
      try {
        saveKeychainValue(DATA_DIRECTORY_SERVICE, location);
      } catch {
        // The selected directory remains valid for this run; saveConfig retries later.
      }
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
    const bootstrap = readKeychainValue(BOOTSTRAP_CONFIG_SERVICE);
    if (bootstrap) {
      const config = JSON.parse(bootstrap) as PluginConfig;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });
      chmodSync(path, 0o600);
      return config;
    }
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
  if (useKeychain()) {
    saveKeychainValue(DATA_DIRECTORY_SERVICE, directory);
    saveKeychainValue(BOOTSTRAP_CONFIG_SERVICE, JSON.stringify(config));
  }
}

type SecretKind = "access" | "refresh" | "recovery";

function keychainService(instanceId: string, kind: SecretKind) {
  return `partner-report:${instanceId}:${kind}`;
}

function mayUseFileSecrets() {
  return (
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS === "1" ||
    process.platform !== "darwin"
  );
}

function saveFileSecret(instanceId: string, kind: SecretKind, value: string) {
  if (!mayUseFileSecrets())
    throw new Error("macOS Keychain 不可用，且未允许文件 Token fallback。");
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
  if (
    process.platform === "darwin" &&
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1"
  ) {
    try {
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-a",
          "partner-report",
          "-s",
          keychainService(instanceId, kind),
          "-w",
          value,
          "-U",
        ],
        { stdio: "ignore" },
      );
      return;
    } catch {
      // An explicit file fallback is required so credentials never silently land in plaintext.
    }
  }
  saveFileSecret(instanceId, kind, value);
}

export function loadSecret(instanceId: string, kind: SecretKind) {
  if (
    process.platform === "darwin" &&
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1"
  ) {
    try {
      return execFileSync(
        "security",
        [
          "find-generic-password",
          "-a",
          "partner-report",
          "-s",
          keychainService(instanceId, kind),
          "-w",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      throw Object.assign(
        new Error(`无法从 macOS Keychain 读取 ${kind} Token。`),
        { code: "KEYCHAIN_ACCESS_REQUIRED" },
      );
    }
  }
  const path = fallbackSecretsPath();
  if (!existsSync(path)) throw new Error("Plugin Token 不存在，请重新连接。");
  const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    string
  >;
  const value = secrets[`${instanceId}:${kind}`];
  if (!value) throw new Error(`Plugin ${kind} Token 不存在，请重新连接。`);
  return value;
}

export function removeSecrets(instanceId: string) {
  if (
    process.platform === "darwin" &&
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1"
  ) {
    for (const kind of ["access", "refresh", "recovery"] as const) {
      try {
        execFileSync(
          "security",
          [
            "delete-generic-password",
            "-a",
            "partner-report",
            "-s",
            keychainService(instanceId, kind),
          ],
          { stdio: "ignore" },
        );
      } catch {
        /* already absent */
      }
    }
    return;
  }
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
  if (
    process.platform === "darwin" &&
    process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1"
  ) {
    try {
      execFileSync(
        "security",
        [
          "delete-generic-password",
          "-a",
          "partner-report",
          "-s",
          keychainService(instanceId, kind),
        ],
        { stdio: "ignore" },
      );
    } catch {
      /* already absent */
    }
    return;
  }
  const path = fallbackSecretsPath();
  if (!existsSync(path)) return;
  const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    string
  >;
  delete secrets[`${instanceId}:${kind}`];
  writeFileSync(path, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
}
