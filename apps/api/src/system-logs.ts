export type SystemLogLevel = "info" | "warning" | "error";
export type SystemLogSource =
  "inbox" | "job" | "delivery" | "outbox" | "report";

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
  events: SystemLogEvent[];
};

type InputRows = {
  jobs: any[];
  deliveries: any[];
  inbox: any[];
  outbox: any[];
  reports: any[];
};

const jobLabels: Record<string, string> = {
  AGGREGATE_WORK_ITEMS: "工作卡片生成",
  GENERATE_TEAM_REPORT: "团队报告生成",
  REGENERATE_TEAM_REPORT: "团队报告重新生成",
  RESCAN_SESSIONS: "会话重新扫描",
};
const deliveryLabels: Record<string, string> = {
  binding: "身份绑定卡发送",
  recovery: "连接恢复卡发送",
  scope: "项目权限卡发送",
  review: "工作卡片审核发送",
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
    events: ordered,
  } satisfies SystemLogExecution;
}

function projectJob(row: any) {
  const title = jobLabels[row.type] ?? "后台任务处理";
  const subject = row.partner_name ?? "团队级任务";
  const events = [
    event("job", row.id, "accepted", {
      level: "info",
      stage: "accepted",
      eventCode: "job.accepted",
      title: "任务已接收",
      message: `${title}已进入后台任务队列。`,
      occurredAt: iso(row.created_at),
      details: { type: row.type, status: row.status },
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
        details: { attempt: row.attempt_count },
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
        occurredAt: iso(row.completed_at ?? row.updated_at),
        details: { attempts: row.attempt_count },
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
          row.error_message?.trim() ||
          (failed ? `${title}没有成功完成。` : `${title}正在等待重试。`),
        occurredAt: iso(row.updated_at),
        details: { attempt: row.attempt_count, maxAttempts: row.max_attempts },
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
  );
}

function projectDelivery(row: any) {
  const title = deliveryLabels[row.kind] ?? "飞书消息发送";
  const subject = row.partner_name ?? "未知接收人";
  const events = [
    event("delivery", row.id, "queued", {
      level: "info",
      stage: "accepted",
      eventCode: "feishu.delivery.queued",
      title: "消息已进入发送队列",
      message: `${title}请求已由中台接收。`,
      occurredAt: iso(row.created_at),
      details: { kind: row.kind, status: row.status },
    }),
  ];
  if (row.sent_at)
    events.push(
      event("delivery", row.id, "sent", {
        level: "info",
        stage: "sent",
        eventCode: "feishu.delivery.sent",
        title: "飞书消息发送成功",
        message: `${title}已发送到飞书。`,
        occurredAt: iso(row.sent_at),
        details: { attempts: row.attempt_count },
      }),
    );
  else if (
    ["failed", "retry_wait", "deferred", "cancelled"].includes(row.status)
  )
    events.push(
      event("delivery", row.id, "problem", {
        level: row.status === "failed" ? "error" : "warning",
        stage: row.status === "failed" ? "failed" : "retry",
        eventCode: row.last_error_code ?? `feishu.delivery.${row.status}`,
        title:
          row.status === "failed" ? "飞书消息发送失败" : "飞书消息尚未送达",
        message: row.last_error_message?.trim() || `${title}暂未成功送达。`,
        occurredAt: iso(row.updated_at),
        details: { attempts: row.attempt_count, status: row.status },
      }),
    );
  return execution(
    "delivery",
    row.id,
    title,
    subject,
    row.status,
    events,
    row.last_error_code,
  );
}

function projectInbox(row: any) {
  const events = [
    event("inbox", row.id, "received", {
      level: "info",
      stage: "received",
      eventCode: "feishu.callback.received",
      title: "飞书操作已接收",
      message: "中台已收到用户在飞书卡片上的操作。",
      occurredAt: iso(row.received_at),
      details: { status: row.status },
    }),
  ];
  if (row.processed_at)
    events.push(
      event("inbox", row.id, "processed", {
        level: row.error_code ? "warning" : "info",
        stage: row.error_code ? "completed_with_error" : "completed",
        eventCode: row.error_code ?? "feishu.callback.processed",
        title: row.error_code
          ? "飞书操作处理完成但存在问题"
          : "飞书操作处理完成",
        message: row.error_message?.trim() || "用户操作已经写入中台业务状态。",
        occurredAt: iso(row.processed_at),
        details: { status: row.status },
      }),
    );
  else if (row.status === "failed")
    events.push(
      event("inbox", row.id, "failed", {
        level: "error",
        stage: "failed",
        eventCode: row.error_code ?? "feishu.callback.failed",
        title: "飞书操作处理失败",
        message: row.error_message?.trim() || "飞书操作没有成功写入业务状态。",
        occurredAt: iso(row.updated_at),
        details: { status: row.status },
      }),
    );
  return execution(
    "inbox",
    row.id,
    "飞书操作接收",
    row.partner_name ?? "飞书用户",
    row.status,
    events,
    row.error_code,
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
    ...rows.deliveries.map(projectDelivery),
    ...rows.inbox.map(projectInbox),
    ...rows.outbox.map(projectOutbox),
    ...rows.reports.map(projectReport),
  ].sort(
    (left, right) =>
      new Date(right.lastEventAt).getTime() -
      new Date(left.lastEventAt).getTime(),
  );
}
