import semver from "semver";
import { sha256 } from "./common.js";

export const CONNECTIVITY_CAPABILITY_VERSION = "1.0";
export const CONNECTIVITY_CHALLENGE_TTL_MS = 5 * 60_000;
export const CONNECTIVITY_CLOCK_TOLERANCE_MS = 10 * 60_000;

export type ConnectivityFailureCode =
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "CLIENT_CLOCK_SKEW"
  | "VERSION_BLOCKED";

export function validateConnectivityAttempt(
  row: {
    connectivityChallengeHash: string | null;
    connectivityChallengeExpiresAt: Date | string | null;
    connectivityChallengeConsumedAt: Date | string | null;
    connectivityStatus: string;
    version: string;
    minimumPluginVersion: string;
  },
  input: {
    challenge: string;
    pluginVersion: string;
    clientTime: string;
    capabilityVersion: string;
  },
  now = Date.now(),
): ConnectivityFailureCode | null {
  const challengeMatches = Boolean(
    row.connectivityChallengeHash &&
    sha256(input.challenge) === row.connectivityChallengeHash,
  );
  if (!challengeMatches) return "CHALLENGE_INVALID";
  if (
    row.connectivityChallengeConsumedAt &&
    row.connectivityStatus !== "verified"
  )
    return "CHALLENGE_INVALID";
  const expiresAt = row.connectivityChallengeExpiresAt
    ? new Date(row.connectivityChallengeExpiresAt).getTime()
    : 0;
  if (!expiresAt || expiresAt <= now) return "CHALLENGE_EXPIRED";
  if (
    input.capabilityVersion !== CONNECTIVITY_CAPABILITY_VERSION ||
    !semver.valid(input.pluginVersion) ||
    !semver.valid(row.minimumPluginVersion) ||
    !semver.gte(input.pluginVersion, row.minimumPluginVersion)
  )
    return "VERSION_BLOCKED";
  const clientTime = new Date(input.clientTime).getTime();
  if (
    !Number.isFinite(clientTime) ||
    Math.abs(clientTime - now) > CONNECTIVITY_CLOCK_TOLERANCE_MS
  )
    return "CLIENT_CLOCK_SKEW";
  return null;
}

export function connectivityErrorMessage(code: string) {
  const messages: Record<string, string> = {
    REQUEST_INVALID: "连接测试请求不符合协议。",
    CHALLENGE_INVALID: "连接验证挑战无效，请重新获取后重试。",
    CHALLENGE_EXPIRED: "连接验证挑战已过期，请重新获取后重试。",
    CLIENT_CLOCK_SKEW: "客户端时间与服务器时间偏差过大。",
    VERSION_BLOCKED: "插件版本或连接能力版本不受支持。",
  };
  return messages[code] ?? "连接验证失败。";
}

export function diagnosticErrorMessage(code: string) {
  const messages: Record<string, string> = {
    DNS_FAILED: "无法解析数据中台地址。",
    TLS_FAILED: "无法建立受信任的 TLS 连接。",
    CONNECTION_REFUSED: "数据中台拒绝连接。",
    CONNECTIVITY_TIMEOUT: "连接数据中台超时。",
    AUTH_FAILED: "插件凭证未通过认证。",
    VERSION_BLOCKED: "插件版本或能力版本不受支持。",
    CHALLENGE_INVALID: "连接验证挑战无效。",
    CHALLENGE_EXPIRED: "连接验证挑战已过期。",
    CLIENT_CLOCK_SKEW: "客户端时间与服务器时间偏差过大。",
    REQUEST_INVALID: "请求不符合连接协议。",
    TASK_SETUP_FAILED: "Codex 定时任务配置失败。",
    SCAN_FAILED: "本地会话扫描失败。",
    EXTRACT_FAILED: "本地结构化提取失败。",
    SYNC_FAILED: "结构化 Fact 同步失败。",
    LOCAL_STORAGE_FAILED: "插件本地状态不可用。",
    LOCAL_AGENT_FAILED: "Codex 本地提取任务失败。",
    SENSITIVE_EGRESS_REJECTED: "敏感内容已在客户端拦截，未上传该内容。",
  };
  return messages[code] ?? "插件运行失败。";
}
