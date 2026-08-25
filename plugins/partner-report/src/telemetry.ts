import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { dataDirectory, loadConfig } from "./config.js";
import { authenticatedRequest } from "./http.js";

export type PluginLogLevel = "debug" | "info" | "warning" | "error";
export type PluginLogEventType = "lifecycle" | "progress" | "result" | "error";

const invocationId = randomUUID();
const invocationCommand = process.argv[2]?.slice(0, 80) || "plugin";
let invocationSequence = 0;
let activeRunId: string | undefined;

export type PendingPluginLog = {
  eventId: string;
  invocationId?: string;
  runId?: string;
  sequence?: number;
  command?: string;
  eventType?: PluginLogEventType;
  level: PluginLogLevel;
  stage: string;
  eventCode: string;
  message: string;
  stack?: string;
  occurredAt: string;
  retryable: boolean;
  attempt?: number;
  durationMs?: number;
  requestId?: string;
  details?: Record<string, unknown>;
};

type PluginLogInput = {
  eventId?: string | undefined;
  invocationId?: string | undefined;
  runId?: string | undefined;
  sequence?: number | undefined;
  command?: string | undefined;
  eventType?: PluginLogEventType | undefined;
  level: PluginLogLevel;
  stage: string;
  eventCode: string;
  message: string;
  stack?: string | undefined;
  occurredAt?: string | undefined;
  retryable?: boolean | undefined;
  attempt?: number | undefined;
  durationMs?: number | undefined;
  requestId?: string | undefined;
  details?: Record<string, unknown> | undefined;
};

const OUTBOX_FILE = "plugin-log-outbox.json";
const MAX_PENDING_EVENTS = 2_000;
const BATCH_SIZE = 50;

function outboxPath() {
  return resolve(dataDirectory(), OUTBOX_FILE);
}

function readOutbox() {
  const path = outboxPath();
  if (!existsSync(path)) return [] as PendingPluginLog[];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as PendingPluginLog[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(events: PendingPluginLog[]) {
  const path = outboxPath();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(events, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function safeDetails(details: Record<string, unknown> | undefined) {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key]) =>
        !/path|session|transcript|prompt|token|secret|authorization|credential/i.test(
          key,
        ),
    ),
  );
}

function tryWriteOutbox(events: PendingPluginLog[]) {
  try {
    writeOutbox(events);
    return true;
  } catch {
    return false;
  }
}

export function enqueuePluginLog(input: PluginLogInput) {
  try {
    if (!loadConfig(false)) return null;
    const details = safeDetails(input.details);
    const eventRunId = input.runId ?? activeRunId;
    const event: PendingPluginLog = {
      eventId: input.eventId ?? randomUUID(),
      invocationId: input.invocationId ?? invocationId,
      sequence: input.sequence ?? ++invocationSequence,
      command: (input.command ?? invocationCommand).slice(0, 80),
      eventType:
        input.eventType ??
        (input.level === "error"
          ? "error"
          : input.eventCode === "command.started" ||
              input.eventCode === "command.completed"
            ? "lifecycle"
            : "progress"),
      level: input.level,
      stage: input.stage.slice(0, 80),
      eventCode: input.eventCode.slice(0, 120),
      message: input.message.slice(0, 4000),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      retryable: input.retryable ?? false,
      ...(eventRunId ? { runId: eventRunId } : {}),
      ...(input.stack ? { stack: input.stack.slice(0, 16000) } : {}),
      ...(input.attempt ? { attempt: input.attempt } : {}),
      ...(input.durationMs !== undefined
        ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
        : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(details ? { details } : {}),
    };
    const events = [...readOutbox(), event].slice(-MAX_PENDING_EVENTS);
    return tryWriteOutbox(events) ? event : null;
  } catch {
    return null;
  }
}

export function setPluginLogRunId(runId: string | undefined) {
  activeRunId = runId;
}

export function pluginLogInvocationId() {
  return invocationId;
}

export async function flushPluginLogs() {
  if (!loadConfig(false)) return { sent: 0, pending: 0 };
  let events: PendingPluginLog[];
  try {
    events = readOutbox();
  } catch {
    return { sent: 0, pending: 0 };
  }
  let sent = 0;
  while (events.length > 0) {
    const batch = events.slice(0, BATCH_SIZE);
    try {
      await authenticatedRequest("/v1/plugin-instances/me/log-events", {
        method: "POST",
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      return { sent, pending: events.length };
    }
    const delivered = new Set(batch.map((event) => event.eventId));
    events = readOutbox().filter((event) => !delivered.has(event.eventId));
    if (!tryWriteOutbox(events)) return { sent, pending: events.length };
    sent += batch.length;
  }
  return { sent, pending: 0 };
}

export function pluginErrorDetails(error: unknown) {
  const value = error as {
    code?: unknown;
    status?: unknown;
    requestId?: unknown;
    details?: unknown;
  };
  return {
    code:
      value && value.code !== undefined
        ? String(value.code)
        : "PLUGIN_COMMAND_FAILED",
    status:
      value && typeof value.status === "number" ? value.status : undefined,
    requestId:
      value && typeof value.requestId === "string"
        ? value.requestId
        : undefined,
    details:
      value && value.details && typeof value.details === "object"
        ? (value.details as Record<string, unknown>)
        : undefined,
  };
}
