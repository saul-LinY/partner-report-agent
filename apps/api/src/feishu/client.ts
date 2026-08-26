import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.js";

export type FeishuReceiveIdType = "email" | "open_id";
export type FeishuApiOperation =
  "send_interactive_message" | "update_interactive_message";
export type FeishuApiFailureReason =
  "invalid_request" | "transport_failure" | "api_rejected" | "invalid_response";

export class FeishuApiError extends Error {
  readonly operation: FeishuApiOperation;
  readonly reason: FeishuApiFailureReason;
  readonly code: number | null;

  constructor(input: {
    operation: FeishuApiOperation;
    reason: FeishuApiFailureReason;
    code?: number | null;
  }) {
    const code = input.code ?? null;
    const codeSuffix = code === null ? "" : ` (code ${code})`;
    super(`Feishu API ${input.reason} during ${input.operation}${codeSuffix}`);
    this.name = "FeishuApiError";
    this.operation = input.operation;
    this.reason = input.reason;
    this.code = code;
  }
}

type CreatePayload = Exclude<
  Parameters<Lark.Client["im"]["message"]["create"]>[0],
  undefined
>;
type PatchPayload = Exclude<
  Parameters<Lark.Client["im"]["message"]["patch"]>[0],
  undefined
>;

export interface FeishuMessageTransport {
  create(payload: CreatePayload): Promise<unknown>;
  patch(payload: PatchPayload): Promise<unknown>;
}

export type FeishuClientSdkConfig = ConstructorParameters<
  typeof Lark.Client
>[0];
export type FeishuWsSdkConfig = ConstructorParameters<typeof Lark.WSClient>[0];
export type FeishuEventDispatcherSdkConfig = ConstructorParameters<
  typeof Lark.EventDispatcher
>[0];

export type FeishuSdkLogLevel = "error" | "warn" | "info";

export type FeishuSdkLogArgument =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "error"; name: string; message: string }>
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "nullish"; value: "null" | "undefined" }>
  | Readonly<{
      kind: "object" | "array";
      keyCount: number;
      keys: readonly string[];
      sensitiveFieldCount: number;
      valuesOmitted: true;
    }>
  | Readonly<{ kind: "unsupported"; valueType: string }>;

export type FeishuSdkLogContext = Readonly<{
  component: "feishu_sdk";
  sdkLevel: FeishuSdkLogLevel;
  arguments: readonly FeishuSdkLogArgument[];
  omittedArgumentCount: number;
}>;

export type FeishuSdkLogSink = {
  error: (context: FeishuSdkLogContext, message: string) => void;
  warn: (context: FeishuSdkLogContext, message: string) => void;
  info: (context: FeishuSdkLogContext, message: string) => void;
};

export type FeishuSdkFactoryOptions = Readonly<{
  logSink?: FeishuSdkLogSink;
}>;

type FeishuSdkLogger = NonNullable<FeishuClientSdkConfig["logger"]>;

const REDACTED = "[REDACTED]";
const OMITTED_PAYLOAD = "[structured payload omitted]";
const MAX_LOG_ARGUMENTS = 12;
const MAX_LOG_TEXT_LENGTH = 500;
const MAX_LOG_OBJECT_KEYS = 16;

const sensitiveFieldNamePattern =
  /authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|tenant[_-]?access[_-]?token|app[_-]?secret|client[_-]?secret|token|secret|password|passwd|credential|cookie|session|api[_-]?key/i;

const quietSdkLogger = Object.freeze({
  error: (..._arguments: unknown[]) => undefined,
  warn: (..._arguments: unknown[]) => undefined,
  info: (..._arguments: unknown[]) => undefined,
  debug: (..._arguments: unknown[]) => undefined,
  trace: (..._arguments: unknown[]) => undefined,
});

function replaceLiteral(value: string, target: string): string {
  if (!target) return value;
  return value.split(target).join(REDACTED);
}

function looksLikeStructuredPayload(value: string): boolean {
  const normalized = value.trim();
  if (!(
    (normalized.startsWith("{") && normalized.endsWith("}")) ||
    (normalized.startsWith("[") && normalized.endsWith("]"))
  )) {
    return false;
  }

  try {
    JSON.parse(normalized);
    return true;
  } catch {
    return false;
  }
}

function sanitizeLogText(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let sanitized = value;
  for (const sensitiveValue of sensitiveValues) {
    sanitized = replaceLiteral(sanitized, sensitiveValue);
    try {
      sanitized = replaceLiteral(sanitized, encodeURIComponent(sensitiveValue));
    } catch {
      // The literal value was already redacted above.
    }
  }

  sanitized = sanitized
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
    .replace(
      /\b(authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|tenant[_-]?access[_-]?token|app[_-]?secret|client[_-]?secret|token|secret|password|passwd|credential|cookie|session|api[_-]?key)\b(\s*[:=]\s*)[^\s,;&}\]]+/gi,
      `$1$2${REDACTED}`,
    )
    .replace(
      /\b(authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|tenant[_-]?access[_-]?token|app[_-]?secret|client[_-]?secret|token|secret|password|passwd|credential|cookie|session|api[_-]?key)\b(\s+(?:is\s+)?)[^\s,;&}\]]+/gi,
      `$1$2${REDACTED}`,
    );

  if (looksLikeStructuredPayload(sanitized)) return OMITTED_PAYLOAD;
  if (sanitized.length <= MAX_LOG_TEXT_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_LOG_TEXT_LENGTH)}...[truncated]`;
}

function summarizeObject(
  value: object,
  sensitiveValues: readonly string[],
): FeishuSdkLogArgument {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return {
      kind: Array.isArray(value) ? "array" : "object",
      keyCount: 0,
      keys: [],
      sensitiveFieldCount: 0,
      valuesOmitted: true,
    };
  }

  const safeKeys: string[] = [];
  let sensitiveFieldCount = 0;
  for (const key of keys) {
    if (sensitiveFieldNamePattern.test(key)) {
      sensitiveFieldCount += 1;
    } else if (safeKeys.length < MAX_LOG_OBJECT_KEYS) {
      safeKeys.push(sanitizeLogText(key, sensitiveValues));
    }
  }

  return {
    kind: Array.isArray(value) ? "array" : "object",
    keyCount: keys.length,
    keys: safeKeys,
    sensitiveFieldCount,
    valuesOmitted: true,
  };
}

function summarizeArgument(
  value: unknown,
  sensitiveValues: readonly string[],
): FeishuSdkLogArgument {
  if (typeof value === "string") {
    return { kind: "text", value: sanitizeLogText(value, sensitiveValues) };
  }
  if (value instanceof Error) {
    return {
      kind: "error",
      name: sanitizeLogText(value.name, sensitiveValues),
      message: sanitizeLogText(value.message, sensitiveValues),
    };
  }
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (value === null) return { kind: "nullish", value: "null" };
  if (value === undefined) return { kind: "nullish", value: "undefined" };
  if (typeof value === "object") {
    return summarizeObject(value, sensitiveValues);
  }
  return { kind: "unsupported", valueType: typeof value };
}

function summarizeArguments(
  values: readonly unknown[],
  sensitiveValues: readonly string[],
): Pick<FeishuSdkLogContext, "arguments" | "omittedArgumentCount"> {
  const flattened: unknown[] = [];
  let omittedArgumentCount = 0;

  const collect = (value: unknown, depth: number) => {
    if (flattened.length >= MAX_LOG_ARGUMENTS) {
      omittedArgumentCount += 1;
      return;
    }
    if (Array.isArray(value) && depth < 3) {
      for (const entry of value) collect(entry, depth + 1);
      return;
    }
    flattened.push(value);
  };

  for (const value of values) collect(value, 0);
  return {
    arguments: flattened.map((value) =>
      summarizeArgument(value, sensitiveValues),
    ),
    omittedArgumentCount,
  };
}

export function createFeishuSdkLogger(
  sink: FeishuSdkLogSink,
  sensitiveValues: readonly string[] = [],
): FeishuSdkLogger {
  const forward = (level: FeishuSdkLogLevel, values: readonly unknown[]) => {
    try {
      sink[level](
        {
          component: "feishu_sdk",
          sdkLevel: level,
          ...summarizeArguments(values, sensitiveValues),
        },
        `Feishu SDK ${level}`,
      );
    } catch {
      // Application logging must never interrupt SDK operations.
    }
  };

  return Object.freeze({
    error: (...values: unknown[]) => forward("error", values),
    warn: (...values: unknown[]) => forward("warn", values),
    info: (...values: unknown[]) => forward("info", values),
    debug: (..._values: unknown[]) => undefined,
    trace: (..._values: unknown[]) => undefined,
  });
}

function sdkLoggingConfig(
  config: Pick<FeishuConfig, "appSecret"> | undefined,
  options: FeishuSdkFactoryOptions,
): Pick<FeishuClientSdkConfig, "logger" | "loggerLevel"> {
  if (!options.logSink) {
    return {
      loggerLevel: Lark.LoggerLevel.error,
      logger: quietSdkLogger,
    };
  }
  return {
    loggerLevel: Lark.LoggerLevel.info,
    logger: createFeishuSdkLogger(
      options.logSink,
      config ? [config.appSecret] : [],
    ),
  };
}

export function buildFeishuClientSdkConfig(
  config: FeishuConfig,
  options: FeishuSdkFactoryOptions = {},
): FeishuClientSdkConfig {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    ...sdkLoggingConfig(config, options),
  };
}

export function buildFeishuWsSdkConfig(
  config: FeishuConfig,
  options: FeishuSdkFactoryOptions = {},
): FeishuWsSdkConfig {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Lark.Domain.Feishu,
    ...sdkLoggingConfig(config, options),
    autoReconnect: true,
  };
}

export function buildFeishuEventDispatcherSdkConfig(
  config?: Pick<FeishuConfig, "appSecret">,
  options: FeishuSdkFactoryOptions = {},
): FeishuEventDispatcherSdkConfig {
  return {
    ...sdkLoggingConfig(config, options),
  };
}

export function createFeishuClient(
  config: FeishuConfig,
  options: FeishuSdkFactoryOptions = {},
): Lark.Client {
  return new Lark.Client(buildFeishuClientSdkConfig(config, options));
}

export function createFeishuWsClient(
  config: FeishuConfig,
  options: FeishuSdkFactoryOptions = {},
): Lark.WSClient {
  return new Lark.WSClient(buildFeishuWsSdkConfig(config, options));
}

export function createFeishuEventDispatcher(
  config?: Pick<FeishuConfig, "appSecret">,
  options: FeishuSdkFactoryOptions = {},
): Lark.EventDispatcher {
  return new Lark.EventDispatcher(
    buildFeishuEventDispatcherSdkConfig(config, options),
  );
}

export type SendInteractiveCardInput = {
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
  card: unknown;
  idempotencyKey?: string;
};

export type UpdateInteractiveCardInput = {
  messageId: string;
  card: unknown;
};

export type SentInteractiveMessage = {
  messageId: string;
};

function invalidRequest(operation: FeishuApiOperation): FeishuApiError {
  return new FeishuApiError({ operation, reason: "invalid_request" });
}

function requireNonEmpty(value: string, operation: FeishuApiOperation): string {
  const normalized = value.trim();
  if (!normalized) throw invalidRequest(operation);
  return normalized;
}

function serializeCard(card: unknown, operation: FeishuApiOperation): string {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw invalidRequest(operation);
  }

  try {
    const content = JSON.stringify(card);
    if (!content) throw invalidRequest(operation);
    return content;
  } catch (error) {
    if (error instanceof FeishuApiError) throw error;
    throw invalidRequest(operation);
  }
}

function responseRecord(
  response: unknown,
  operation: FeishuApiOperation,
): Record<string, unknown> {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new FeishuApiError({ operation, reason: "invalid_response" });
  }
  return response as Record<string, unknown>;
}

function assertSuccessfulResponse(
  response: unknown,
  operation: FeishuApiOperation,
): Record<string, unknown> {
  const record = responseRecord(response, operation);
  if (record.code === 0) return record;
  if (typeof record.code === "number") {
    throw new FeishuApiError({
      operation,
      reason: "api_rejected",
      code: record.code,
    });
  }
  throw new FeishuApiError({ operation, reason: "invalid_response" });
}

function safeTransportError(
  operation: FeishuApiOperation,
  error: unknown,
): FeishuApiError {
  if (error instanceof FeishuApiError) return error;
  if (error && typeof error === "object") {
    const response = (error as Record<string, unknown>).response;
    if (response && typeof response === "object") {
      const data = (response as Record<string, unknown>).data;
      if (data && typeof data === "object") {
        const code = (data as Record<string, unknown>).code;
        if (typeof code === "number") {
          return new FeishuApiError({
            operation,
            reason: "api_rejected",
            code,
          });
        }
      }
    }
  }
  return new FeishuApiError({ operation, reason: "transport_failure" });
}

export class FeishuMessageClient {
  constructor(private readonly transport: FeishuMessageTransport) {}

  async sendInteractiveCard(
    input: SendInteractiveCardInput,
  ): Promise<SentInteractiveMessage> {
    const operation = "send_interactive_message";
    const receiveId = requireNonEmpty(input.receiveId, operation);
    const content = serializeCard(input.card, operation);

    try {
      const response = await this.transport.create({
        params: { receive_id_type: input.receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content,
          ...(input.idempotencyKey !== undefined
            ? { uuid: requireNonEmpty(input.idempotencyKey, operation) }
            : {}),
        },
      });
      const record = assertSuccessfulResponse(response, operation);
      const data = record.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new FeishuApiError({ operation, reason: "invalid_response" });
      }
      const messageId = (data as Record<string, unknown>).message_id;
      if (typeof messageId !== "string" || !messageId.trim()) {
        throw new FeishuApiError({ operation, reason: "invalid_response" });
      }
      return { messageId: messageId.trim() };
    } catch (error) {
      throw safeTransportError(operation, error);
    }
  }

  async updateInteractiveCard(
    input: UpdateInteractiveCardInput,
  ): Promise<void> {
    const operation = "update_interactive_message";
    const messageId = requireNonEmpty(input.messageId, operation);
    const content = serializeCard(input.card, operation);

    try {
      const response = await this.transport.patch({
        path: { message_id: messageId },
        data: { content },
      });
      assertSuccessfulResponse(response, operation);
    } catch (error) {
      throw safeTransportError(operation, error);
    }
  }
}

export function createFeishuMessageClient(
  config: FeishuConfig,
  options: FeishuSdkFactoryOptions = {},
): FeishuMessageClient {
  const client = createFeishuClient(config, options);
  return new FeishuMessageClient(client.im.message);
}
