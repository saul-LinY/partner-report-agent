export type MonitoringSeverity = "normal" | "warning" | "critical" | "unknown";

function timestamp(value: Date | string | null) {
  if (!value) return 0;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

export type SystemComponentProjection = {
  key: "api" | "queue" | "generation" | "notifications" | "reports";
  label: string;
  severity: MonitoringSeverity;
  summary: string;
  detail: string;
  count: number;
};

type SystemMonitoringInput = {
  worker?: {
    heartbeat_at: Date | string;
    status: string;
    capabilities: { modelConfigured?: boolean };
  } | null;
  queue: {
    pending: number;
    leased: number;
    retryWait: number;
    expiredLeases: number;
    oldestActiveAt: Date | string | null;
  };
  generation: { failed: number; retryWait: number; completed24h: number };
  notifications: {
    pending: number;
    stalePending: number;
    delivered24h: number;
  };
  reports: {
    aggregating: number;
    staleAggregating: number;
    drafts: number;
    locked24h: number;
  };
};

export function projectSystemComponents(
  input: SystemMonitoringInput,
  now = new Date(),
): SystemComponentProjection[] {
  const activeJobs =
    input.queue.pending + input.queue.leased + input.queue.retryWait;
  const oldestAgeMinutes = input.queue.oldestActiveAt
    ? (now.getTime() - timestamp(input.queue.oldestActiveAt)) / 60_000
    : 0;
  const queueSeverity: MonitoringSeverity =
    (input.worker !== undefined &&
      (!input.worker ||
        input.worker.status === "stopped" ||
        input.worker.status === "error" ||
        now.getTime() - timestamp(input.worker.heartbeat_at) > 90_000)) ||
    input.queue.expiredLeases > 0 ||
    oldestAgeMinutes > 60
      ? "critical"
      : activeJobs > 0 || oldestAgeMinutes > 15
        ? "warning"
        : "normal";

  const generationSeverity: MonitoringSeverity =
    (input.worker && !input.worker.capabilities.modelConfigured) ||
    input.generation.failed > 0
      ? "critical"
      : input.generation.retryWait > 0
        ? "warning"
        : "normal";
  const notificationSeverity: MonitoringSeverity =
    input.notifications.stalePending > 0 ? "warning" : "normal";
  const reportSeverity: MonitoringSeverity =
    input.reports.staleAggregating > 0
      ? "critical"
      : input.reports.aggregating > 0
        ? "warning"
        : "normal";

  return [
    {
      key: "api",
      label: "API 与数据库",
      severity: "normal",
      summary: "服务响应正常",
      detail: "管理端能够读取状态，数据库查询正常完成。",
      count: 0,
    },
    {
      key: "queue",
      label: "后台任务队列",
      severity: queueSeverity,
      summary:
        input.worker !== undefined &&
        (!input.worker ||
          input.worker.status === "stopped" ||
          now.getTime() - timestamp(input.worker.heartbeat_at) > 90_000)
          ? "后台任务进程离线"
          : input.worker?.status === "error"
            ? "后台任务进程异常"
            : queueSeverity === "critical"
              ? "任务处理出现阻塞"
              : activeJobs > 0
                ? `${activeJobs} 个任务处理中`
                : "当前没有积压",
      detail:
        input.worker !== undefined &&
        (!input.worker ||
          input.worker.status === "stopped" ||
          now.getTime() - timestamp(input.worker.heartbeat_at) > 90_000)
          ? "启动 Worker 服务后，排队任务才能继续处理。"
          : input.queue.expiredLeases > 0
            ? `${input.queue.expiredLeases} 个任务租约已经过期。`
            : oldestAgeMinutes > 0
              ? `最早的活动任务已等待 ${Math.max(1, Math.round(oldestAgeMinutes))} 分钟。`
              : "新任务可以正常进入处理流程。",
      count: activeJobs,
    },
    {
      key: "generation",
      label: "内容生成",
      severity: generationSeverity,
      summary:
        input.worker && !input.worker.capabilities.modelConfigured
          ? "模型未配置"
          : input.generation.failed > 0
            ? `${input.generation.failed} 个任务生成失败`
            : input.generation.retryWait > 0
              ? `${input.generation.retryWait} 个任务等待重试`
              : "内容生成正常",
      detail: `过去 24 小时完成 ${input.generation.completed24h} 个生成任务。`,
      count: input.generation.failed + input.generation.retryWait,
    },
    {
      key: "notifications",
      label: "App 系统通知",
      severity: notificationSeverity,
      summary: input.notifications.pending
        ? input.notifications.pending + " 条通知等待 App 投递"
        : "没有待投递通知",
      detail:
        "过去 24 小时 App 已确认投递 " +
        input.notifications.delivered24h +
        " 条；未开启通知权限的消息会保留在队列中。",
      count: input.notifications.stalePending,
    },
    {
      key: "reports",
      label: "报告生成",
      severity: reportSeverity,
      summary:
        input.reports.staleAggregating > 0
          ? `${input.reports.staleAggregating} 份报告生成超时`
          : input.reports.aggregating > 0
            ? `${input.reports.aggregating} 份报告生成中`
            : "报告流水线正常",
      detail: `${input.reports.drafts} 份报告待确认，过去 24 小时归档 ${input.reports.locked24h} 份。`,
      count: input.reports.staleAggregating,
    },
  ];
}
