import { sanitizePluginLogText } from "./sanitize.js";

export type SystemLogLevel = "info" | "warning" | "error";
export type SystemLogSource = "notification" | "job" | "outbox" | "report";

export type SystemLogEvent = {
  id: string;
  executionId: string;
  source: SystemLogSource;
  level: SystemLogLevel;
  stage: string;
  eventCode: string;
  title: string;
  message: string;
  occurredAt: string;
  details: Record<string, unknown>;
};

export type SystemLogExecution = {
  executionId: string;
  source: SystemLogSource;
  sourceId: string;
  title: string;
  subject: string;
  status: string;
  severity: "normal" | "warning" | "critical";
  startedAt: string;
  lastEventAt: string;
  durationMs: number;
  eventCount: number;
  summary: string;
  errorCode: string | null;
  /** Job-only context; null for other sources. */
  job: SystemLogJobMeta | null;
  events: SystemLogEvent[];
};

export type SystemLogJobMeta = {
  type: string;
  partnerId: string | null;
  partnerName: string | null;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  /** created -> completed, or created -> now-independent last update for unfinished jobs. */
  durationMs: number;
  leaseUntil: string | null;
  nextRetryAt: string | null;
  idempotencyKey: string;
  uploadId: string | null;
  periodKey: string | null;
};

type InputRows = {
  jobs: any[];
  notifications: any[];
  outbox: any[];
  reports: any[];
};

const jobLabels: Record<string, string> = {
  EXTRACT_COLLECTOR_SESSION: "App 会话贡献分析",
  AGGREGATE_WORK_ITEMS: "工作卡片生成",
  GENERATE_TEAM_REPORT: "团队报告生成",
  REGENERATE_TEAM_REPORT: "团队报告重新生成",
  REANALYZE_SESSIONS: "会话重新分析",
  RESCAN_SESSIONS: "会话重新扫描",
  ANALYZE_INSPECTION_FINDING: "异常巡检分析",
};
function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function duration(startedAt: string, endedAt: string) {
  return Math.max(
    0,
    new Date(endedAt).getTime() - new Date(startedAt).getTime(),
  );
}

function event(
  source: SystemLogSource,
  sourceId: string,
  suffix: string,
  input: Omit<SystemLogEvent, "id" | "executionId" | "source">,
): SystemLogEvent {
  return {
    id: `${source}:${sourceId}:${suffix}`,
    executionId: `${source}:${sourceId}`,
    source,
    ...input,
  };
}

function execution(
  source: SystemLogSource,
  sourceId: string,
  title: string,
  subject: string,
  status: string,
  events: SystemLogEvent[],
  errorCode: string | null = null,
  job: SystemLogJobMeta | null = null,
) {
  const ordered = [...events].sort(
    (left, right) =>
      new Date(left.occurredAt).getTime() -
      new Date(right.occurredAt).getTime(),
  );
  const startedAt = ordered[0]!.occurredAt;
  const lastEventAt = ordered.at(-1)!.occurredAt;
  const severity = ordered.some((item) => item.level === "error")
    ? "critical"
    : ordered.some((item) => item.level === "warning")
      ? "warning"
      : "normal";
  const last = ordered.at(-1)!;
  return {
    executionId: `${source}:${sourceId}`,
    source,
    sourceId,
    title,
    subject,
    status,
    severity,
    startedAt,
    lastEventAt,
    durationMs: duration(startedAt, lastEventAt),
    eventCount: ordered.length,
    summary: last.message,
    errorCode,
    job,
    events: ordered,
  } satisfies SystemLogExecution;
}

function nullableIso(value: Date | string | null | undefined) {
  return value ? iso(value) : null;
}

function projectJob(row: any) {
  const title = jobLabels[row.type] ?? "后台任务处理";
  const subject = row.partner_name ?? "团队级任务";
  const errorMessage = row.error_message?.trim()
    ? sanitizePluginLogText(row.error_message.trim())
    : null;
  const createdAt = iso(row.created_at);
  const completedAt = nullableIso(row.completed_at);
  const meta: SystemLogJobMeta = {
    type: row.type,
    partnerId: row.partner_id ?? null,
    partnerName: row.partner_name ?? null,
    attemptCount: row.attempt_count ?? 0,
    maxAttempts: row.max_attempts ?? 0,
    errorCode: row.error_code ?? null,
    errorMessage,
    createdAt,
    completedAt,
    durationMs: duration(createdAt, completedAt ?? iso(row.updated_at)),
    leaseUntil: nullableIso(row.lease_until),
    nextRetryAt: nullableIso(row.next_retry_at),
    idempotencyKey: row.idempotency_key ?? "",
    uploadId: row.upload_id ?? null,
    periodKey: row.period_key ?? null,
  };
  const context = {
    type: meta.type,
    status: row.status,
    attempt: meta.attemptCount,
    maxAttempts: meta.maxAttempts,
    idempotencyKey: meta.idempotencyKey,
    ...(meta.uploadId ? { uploadId: meta.uploadId } : {}),
    ...(meta.periodKey ? { periodKey: meta.periodKey } : {}),
  };
  const events = [
    event("job", row.id, "accepted", {
      level: "info",
      stage: "accepted",
      eventCode: "job.accepted",
      title: "任务已接收",
      message: `${title}已进入后台任务队列。`,
      occurredAt: createdAt,
      details: context,
    }),
  ];
  if (row.status === "LEASED")
    events.push(
      event("job", row.id, "processing", {
        level: "info",
        stage: "processing",
        eventCode: "job.processing",
        title: "任务正在处理",
        message: `${title}已由中台 Worker 开始执行。`,
        occurredAt: iso(row.updated_at),
        details: { ...context, leaseUntil: meta.leaseUntil },
      }),
    );
  if (row.status === "COMPLETED")
    events.push(
      event("job", row.id, "completed", {
        level: "info",
        stage: "generated",
        eventCode: "job.completed",
        title: "生成处理完成",
        message: `${title}已完成。`,
        occurredAt: completedAt ?? iso(row.updated_at),
        details: { ...context, durationMs: meta.durationMs },
      }),
    );
  if (["RETRY_WAIT", "FAILED", "CANCELLED"].includes(row.status)) {
    const failed = row.status === "FAILED";
    events.push(
      event("job", row.id, "problem", {
        level: failed ? "error" : "warning",
        stage: failed ? "failed" : "retry",
        eventCode: row.error_code ?? `job.${row.status.toLowerCase()}`,
        title: failed ? "任务处理失败" : "任务等待后续处理",
        message:
          errorMessage ||
          (failed ? `${title}没有成功完成。` : `${title}正在等待重试。`),
        occurredAt: iso(row.updated_at),
        details: {
          ...context,
          errorCode: meta.errorCode,
          nextRetryAt: meta.nextRetryAt,
        },
      }),
    );
  }
  return execution(
    "job",
    row.id,
    title,
    subject,
    row.status,
    events,
    row.error_code,
    meta,
  );
}

function projectNotification(row: any) {
  const events = [
    event("notification", row.id, "queued", {
      level: "info",
      stage: "accepted",
      eventCode: "app.notification.queued",
      title: "App 通知已排队",
      message: "消息已进入 App 通知队列，尚不代表系统通知已送达。",
      occurredAt: iso(row.created_at),
      details: { kind: row.kind },
    }),
  ];
  if (row.delivered_at)
    events.push(
      event("notification", row.id, "delivered", {
        level: "info",
        stage: "delivered",
        eventCode: "app.notification.delivered",
        title: "App 已确认系统通知投递",
        message: "App 已调用 macOS 通知并返回投递回执，不代表用户已阅读。",
        occurredAt: iso(row.delivered_at),
        details: {},
      }),
    );
  return execution(
    "notification",
    row.id,
    "App 系统通知",
    row.partner_name ?? "成员",
    row.delivered_at ? "delivered" : "pending",
    events,
  );
}

function projectOutbox(row: any) {
  const events = [
    event("outbox", row.id, "accepted", {
      level: "info",
      stage: "accepted",
      eventCode: row.event_type,
      title: "业务事件已接收",
      message: `中台已接收 ${row.event_type} 事件。`,
      occurredAt: iso(row.created_at),
      details: { aggregateType: row.aggregate_type },
    }),
  ];
  if (row.published_at)
    events.push(
      event("outbox", row.id, "published", {
        level: "info",
        stage: "dispatched",
        eventCode: "outbox.published",
        title: "业务事件已分发",
        message: "事件已交给后续生成或发送链路处理。",
        occurredAt: iso(row.published_at),
        details: { eventType: row.event_type },
      }),
    );
  return execution(
    "outbox",
    row.id,
    "中台业务事件",
    row.event_type,
    row.published_at ? "published" : "pending",
    events,
  );
}

function projectReport(row: any) {
  const events = [
    event("report", row.id, "created", {
      level: "info",
      stage: "accepted",
      eventCode: "report.created",
      title: "报告流程已创建",
      message: `报告已进入 ${row.status} 状态。`,
      occurredAt: iso(row.created_at),
      details: { periodKey: row.period_key, status: row.status },
    }),
  ];
  if (row.generated_at)
    events.push(
      event("report", row.id, "generated", {
        level: "info",
        stage: "generated",
        eventCode: "report.generated",
        title: "团队报告已生成",
        message: "团队报告内容已生成并保存。",
        occurredAt: iso(row.generated_at),
        details: { version: row.current_version },
      }),
    );
  if (row.locked_at)
    events.push(
      event("report", row.id, "locked", {
        level: "info",
        stage: "archived",
        eventCode: "report.locked",
        title: "团队报告已归档",
        message: "报告已锁定并进入归档状态。",
        occurredAt: iso(row.locked_at),
        details: { version: row.current_version },
      }),
    );
  return execution(
    "report",
    row.id,
    "团队报告流程",
    row.period_key ?? "当前周期",
    row.status,
    events,
  );
}

export function projectSystemLogExecutions(rows: InputRows) {
  return [
    ...rows.jobs.map(projectJob),
    ...rows.notifications.map(projectNotification),
    ...rows.outbox.map(projectOutbox),
    ...rows.reports.map(projectReport),
  ].sort(
    (left, right) =>
      new Date(right.lastEventAt).getTime() -
      new Date(left.lastEventAt).getTime(),
  );
}
