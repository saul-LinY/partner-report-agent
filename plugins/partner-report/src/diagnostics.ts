import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { authenticatedRequest, HttpError } from "./http.js";

export type DiagnosticStage =
  "binding" | "connectivity" | "task_setup" | "scan" | "extract" | "sync";

export type DiagnosticErrorCode =
  | "DNS_FAILED"
  | "TLS_FAILED"
  | "CONNECTION_REFUSED"
  | "CONNECTIVITY_TIMEOUT"
  | "AUTH_FAILED"
  | "VERSION_BLOCKED"
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "CLIENT_CLOCK_SKEW"
  | "REQUEST_INVALID"
  | "TASK_SETUP_FAILED"
  | "SCAN_FAILED"
  | "EXTRACT_FAILED"
  | "SYNC_FAILED"
  | "LOCAL_STORAGE_FAILED"
  | "LOCAL_AGENT_FAILED"
  | "SENSITIVE_EGRESS_REJECTED";

const safeMessages: Record<DiagnosticErrorCode, string> = {
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
  SENSITIVE_EGRESS_REJECTED: "本地内容触发敏感出站拦截，未上传该内容。",
};

export function diagnosticMessage(code: DiagnosticErrorCode) {
  return safeMessages[code];
}

export function isTerminalExtractionError(errorCode: string) {
  return ["SENSITIVE_EGRESS_REJECTED", "SYSTEM_SESSION_EXCLUDED"].includes(
    errorCode,
  );
}

export function classifyDiagnosticError(
  error: unknown,
  fallback: DiagnosticErrorCode,
): { code: DiagnosticErrorCode; requestId?: string } {
  if (error instanceof HttpError) {
    const mapped: Record<string, DiagnosticErrorCode> = {
      UNAUTHENTICATED: "AUTH_FAILED",
      PLUGIN_BINDING_INVALID: "AUTH_FAILED",
      REFRESH_TOKEN_INVALID: "AUTH_FAILED",
      VERSION_BLOCKED: "VERSION_BLOCKED",
      CHALLENGE_INVALID: "CHALLENGE_INVALID",
      CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
      CLIENT_CLOCK_SKEW: "CLIENT_CLOCK_SKEW",
      REQUEST_INVALID: "REQUEST_INVALID",
      VALIDATION_ERROR: "REQUEST_INVALID",
    };
    return {
      code: mapped[error.code] ?? fallback,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code) as DiagnosticErrorCode;
    if (code in safeMessages) return { code };
  }
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error.cause as { code?: string } | undefined)
      : undefined;
  const causeCode = cause?.code ?? "";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(causeCode))
    return { code: "DNS_FAILED" };
  if (causeCode === "ECONNREFUSED") return { code: "CONNECTION_REFUSED" };
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(causeCode))
    return { code: "CONNECTIVITY_TIMEOUT" };
  if (/CERT|TLS|SSL/.test(causeCode)) return { code: "TLS_FAILED" };
  return { code: fallback };
}

export function queueDiagnostic(
  db: DatabaseSync,
  stage: DiagnosticStage,
  errorCode: DiagnosticErrorCode,
  retryable = true,
  requestId?: string,
) {
  const now = new Date().toISOString();
  db.prepare(
    `insert into diagnostic_outbox (
      id, stage, error_code, occurred_at, retryable, request_id,
      safe_message, status, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
  ).run(
    randomUUID(),
    stage,
    errorCode,
    now,
    retryable ? 1 : 0,
    requestId ?? null,
    diagnosticMessage(errorCode),
    now,
    now,
  );
}

export function queueDiagnosticSafely(
  stage: DiagnosticStage,
  errorCode: DiagnosticErrorCode,
  retryable = true,
  requestId?: string,
) {
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase();
    queueDiagnostic(db, stage, errorCode, retryable, requestId);
  } catch {
    // Diagnostics must never replace the primary failure.
  } finally {
    db?.close();
  }
}

export async function flushDiagnostics(db: DatabaseSync) {
  const events = db
    .prepare(
      `select id, stage, error_code, occurred_at, retryable, request_id, safe_message
       from diagnostic_outbox where status = 'PENDING'
       order by occurred_at asc limit 20`,
    )
    .all() as Array<{
    id: string;
    stage: DiagnosticStage;
    error_code: DiagnosticErrorCode;
    occurred_at: string;
    retryable: number;
    request_id: string | null;
    safe_message: string;
  }>;
  if (events.length === 0) return { submitted: 0, accepted: 0 };
  const response = await authenticatedRequest<{
    submitted: number;
    accepted: number;
  }>("/v1/plugin-instances/me/diagnostics", {
    method: "POST",
    body: JSON.stringify({
      events: events.map((event) => ({
        eventId: event.id,
        stage: event.stage,
        errorCode: event.error_code,
        occurredAt: event.occurred_at,
        retryable: Boolean(event.retryable),
        ...(event.request_id ? { requestId: event.request_id } : {}),
      })),
    }),
  });
  const now = new Date().toISOString();
  const mark = db.prepare(
    "update diagnostic_outbox set status = 'UPLOADED', updated_at = ? where id = ?",
  );
  for (const event of events) mark.run(now, event.id);
  return response;
}
