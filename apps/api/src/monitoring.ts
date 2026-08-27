export type MonitoringSeverity = "normal" | "warning" | "critical" | "unknown";

export type PluginMonitoringStatus = {
  severity: MonitoringSeverity;
  code:
    | "healthy"
    | "scheduled"
    | "running"
    | "waiting"
    | "failed"
    | "interrupted"
    | "missed"
    | "waiting_first_run";
  label: string;
  reason: string;
  action: string;
};

type PluginMonitoringInput = {
  createdAt: Date | string;
  lastCollectionStartedAt: Date | string | null;
  lastCollectionCompletedAt: Date | string | null;
  lastHeartbeatAt: Date | string | null;
  latestEventAt: Date | string | null;
  latestEventCode: string | null;
  latestErrorAt: Date | string | null;
  monitoringRecoveredAt: Date | string | null;
  lastErrorCode: string | null;
  runnerState: string | null;
  retryCount: number;
  pendingLocalJobs: number;
};

export const PLUGIN_SCHEDULE = {
  timezone: "Asia/Shanghai",
  hour: 16,
  graceMinutes: 60,
  staleRunMinutes: 30,
} as const;

const waitingEventCodes = new Set([
  "review_required",
  "project_scope_approval_required",
  "project_scope_approval_waiting",
  "project_scope_no_candidates",
]);

function timestamp(value: Date | string | null) {
  if (!value) return 0;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function localParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function pluginResult(
  severity: MonitoringSeverity,
  code: PluginMonitoringStatus["code"],
  label: string,
  reason: string,
  action: string,
): PluginMonitoringStatus {
  return { severity, code, label, reason, action };
}

export function projectPluginMonitoringStatus(
  input: PluginMonitoringInput,
  now = new Date(),
): PluginMonitoringStatus {
  const startedAt = timestamp(input.lastCollectionStartedAt);
  const completedAt = timestamp(input.lastCollectionCompletedAt);
  const errorAt = timestamp(input.latestErrorAt);
  const recoveredAt = timestamp(input.monitoringRecoveredAt);
  const lastActivityAt = Math.max(
    timestamp(input.lastHeartbeatAt),
    timestamp(input.latestEventAt),
    startedAt,
  );
  const currentFailure =
    Boolean(input.lastErrorCode) ||
    input.runnerState === "error" ||
    input.retryCount > 0 ||
    (errorAt > 0 && errorAt > Math.max(completedAt, recoveredAt));

  if (currentFailure) {
    return pluginResult(
      "critical",
      "failed",
      "执行失败",
      input.lastErrorCode
        ? `插件返回错误 ${input.lastErrorCode}。`
        : "最近一次运行记录了未恢复的错误。",
      "查看下方错误日志，确认错误原因后重新运行。",
    );
  }

  const runOpen = startedAt > Math.max(completedAt, recoveredAt);
  if (runOpen) {
    if (input.latestEventCode && waitingEventCodes.has(input.latestEventCode)) {
      return pluginResult(
        "warning",
        "waiting",
        "等待用户操作",
        "插件正在等待项目授权或内容审核，不属于运行故障。",
        "完成待办操作后，插件会继续本次采集。",
      );
    }
    const inactiveMinutes = (now.getTime() - lastActivityAt) / 60_000;
    if (inactiveMinutes > PLUGIN_SCHEDULE.staleRunMinutes) {
      return pluginResult(
        "critical",
        "interrupted",
        "疑似中断",
        `采集已经开始，但超过 ${PLUGIN_SCHEDULE.staleRunMinutes} 分钟没有新进度。`,
        "确认用户设备和 Codex 是否仍在运行，然后查看最后一条插件日志。",
      );
    }
    return pluginResult(
      "normal",
      "running",
      "运行中",
      "插件正在执行今天的采集任务。",
      "无需处理，等待本次运行完成。",
    );
  }

  const localNow = localParts(now, PLUGIN_SCHEDULE.timezone);
  const startedDay = startedAt
    ? localParts(new Date(startedAt), PLUGIN_SCHEDULE.timezone).day
    : null;
  if (startedDay === localNow.day && completedAt >= startedAt) {
    return pluginResult(
      "normal",
      "healthy",
      "今日已完成",
      "插件今天已经按计划完成采集。",
      "无需处理。",
    );
  }

  const recoveredDay = recoveredAt
    ? localParts(new Date(recoveredAt), PLUGIN_SCHEDULE.timezone).day
    : null;
  if (recoveredDay === localNow.day) {
    return pluginResult(
      "normal",
      "healthy",
      "已恢复",
      "管理员已确认并恢复当前监控状态。",
      "无需处理；后续出现新的故障时会再次提醒。",
    );
  }

  const scheduleMinute = PLUGIN_SCHEDULE.hour * 60;
  if (!startedAt) {
    const createdDay = localParts(
      new Date(input.createdAt),
      PLUGIN_SCHEDULE.timezone,
    ).day;
    if (createdDay === localNow.day || localNow.minuteOfDay < scheduleMinute) {
      return pluginResult(
        "warning",
        "waiting_first_run",
        "等待首次运行",
        "插件已连接，尚未完成第一次计划采集。",
        "等待今天 16:00 的计划任务，或让用户手动运行一次。",
      );
    }
  }

  if (localNow.minuteOfDay < scheduleMinute) {
    return pluginResult(
      "normal",
      "scheduled",
      "等待今日运行",
      "今天的计划运行时间还没有到。",
      "无需处理。",
    );
  }

  if (localNow.minuteOfDay < scheduleMinute + PLUGIN_SCHEDULE.graceMinutes) {
    return pluginResult(
      "warning",
      "scheduled",
      "等待今日运行",
      `计划时间已到，当前仍在 ${PLUGIN_SCHEDULE.graceMinutes} 分钟宽限期内。`,
      "暂时无需处理；宽限期结束后仍未启动会自动标记异常。",
    );
  }

  return pluginResult(
    "critical",
    "missed",
    "今日未运行",
    "今天的计划时间和宽限期已经结束，但插件没有启动采集。",
    "确认用户电脑和 Codex 是否在线，并检查定时任务是否启用。",
  );
}

export type SystemComponentProjection = {
  key: "api" | "queue" | "generation" | "feishu" | "reports";
  label: string;
  severity: MonitoringSeverity;
  summary: string;
  detail: string;
  count: number;
};

type SystemMonitoringInput = {
  queue: {
    pending: number;
    leased: number;
    retryWait: number;
    expiredLeases: number;
    oldestActiveAt: Date | string | null;
  };
  generation: { failed: number; retryWait: number; completed24h: number };
  feishu: {
    failed: number;
    retryWait: number;
    deferred: number;
    stuckSending: number;
    stalePending: number;
    sent24h: number;
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
    input.queue.expiredLeases > 0 || oldestAgeMinutes > 60
      ? "critical"
      : activeJobs > 0 || oldestAgeMinutes > 15
        ? "warning"
        : "normal";

  const generationSeverity: MonitoringSeverity =
    input.generation.failed > 0
      ? "critical"
      : input.generation.retryWait > 0
        ? "warning"
        : "normal";
  const feishuProblems =
    input.feishu.failed +
    input.feishu.retryWait +
    input.feishu.deferred +
    input.feishu.stuckSending +
    input.feishu.stalePending;
  const feishuSeverity: MonitoringSeverity =
    input.feishu.failed > 0 || input.feishu.stuckSending > 0
      ? "critical"
      : feishuProblems > 0
        ? "warning"
        : "normal";
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
        queueSeverity === "critical"
          ? "任务处理出现阻塞"
          : activeJobs > 0
            ? `${activeJobs} 个任务处理中`
            : "当前没有积压",
      detail:
        input.queue.expiredLeases > 0
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
        input.generation.failed > 0
          ? `${input.generation.failed} 个任务生成失败`
          : input.generation.retryWait > 0
            ? `${input.generation.retryWait} 个任务等待重试`
            : "内容生成正常",
      detail: `过去 24 小时完成 ${input.generation.completed24h} 个生成任务。`,
      count: input.generation.failed + input.generation.retryWait,
    },
    {
      key: "feishu",
      label: "飞书消息",
      severity: feishuSeverity,
      summary:
        feishuProblems > 0
          ? `${feishuProblems} 条消息需要关注`
          : "消息发送正常",
      detail: `过去 24 小时成功发送 ${input.feishu.sent24h} 条消息。`,
      count: feishuProblems,
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
