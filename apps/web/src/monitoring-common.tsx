import type { ReactNode } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  RefreshCw,
} from "lucide-react";

export type Severity = "normal" | "warning" | "critical" | "unknown";

export const severityTone = {
  normal: "success",
  warning: "warning",
  critical: "danger",
  unknown: "neutral",
} as const;

export const severityLabel = {
  normal: "正常",
  warning: "需关注",
  critical: "异常",
  unknown: "未知",
};

export const levelLabel: Record<string, string> = {
  info: "信息",
  warning: "警告",
  error: "错误",
};

export function levelTone(level: string) {
  return level === "error"
    ? "danger"
    : level === "warning"
      ? "warning"
      : "neutral";
}

export function formatTime(
  value: string | null | undefined,
  timezone = "Asia/Shanghai",
  empty = "—",
) {
  if (!value) return empty;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} 秒`;
  return `${(durationMs / 60_000).toFixed(1)} 分钟`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function dateKeyInTimezone(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

export function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const collectorStageLabels: Record<string, string> = {
  app: "App 运行",
  binding: "绑定",
  permissions: "项目授权",
  discovery: "项目发现",
  scan: "会话扫描",
  upload: "会话上传",
  heartbeat: "心跳",
  notification: "系统通知",
  review: "工作卡审核",
};

export const collectorCodeLabels: Record<string, string> = {
  BOUND: "绑定成功",
  POLICY_SYNCED: "项目权限已同步",
  POLICY_SYNC_FAILED: "项目权限同步失败",
  APP_LAUNCHED: "App 已启动",
  DISCOVERY_STARTED: "开始发现项目",
  DISCOVERY_COMPLETED: "项目发现完成",
  DISCOVERY_FAILED: "项目发现失败",
  SCAN_STARTED: "开始扫描",
  SCAN_COMPLETED: "扫描完成",
  SCAN_FAILED: "扫描失败",
  SESSION_READ_FAILED: "会话读取失败",
  UPLOAD_QUEUED: "会话包已加入上传队列",
  UPLOAD_STARTED: "开始上传会话包",
  UPLOAD_PART_SENT: "分包已发送",
  UPLOAD_PART_FAILED: "分包发送失败",
  UPLOAD_COMPLETED: "会话包上传完成",
  UPLOAD_FAILED: "会话包上传失败",
  UPLOAD_NETWORK_FAILED: "上传网络中断",
  UPLOAD_AUTH_FAILED: "上传绑定失效",
  UPLOAD_POLICY_CHANGED: "上传前置条件或权限已变更",
  UPLOAD_SERVER_FAILED: "上传接收端异常",
  UPLOAD_STORAGE_FAILED: "本机待传队列读写失败",
  UPLOAD_TOO_LARGE: "单个会话超过上传上限",
  ALIVE: "App 在线",
  NOTIFICATIONS_ALLOWED: "macOS 通知已允许",
  NOTIFICATIONS_DENIED: "macOS 通知权限未开启",
  NOTIFICATIONS_NOT_CONFIGURED: "macOS 通知尚未授权",
  NOTIFICATION_RECEIPT_FAILED: "通知回执上报失败",
  REVIEW_ACTION_FAILED: "审核操作失败",
};

const errorKindLabels: Record<string, string> = {
  network: "网络",
  auth: "绑定或认证",
  policy: "项目权限",
  server: "接收端",
  storage: "本机存储",
  size: "超出大小限制",
  read: "会话读取",
  unknown: "未知",
};

const agentLabels: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  hermes: "Hermes",
  omp: "OMP",
  grokbuild: "Grok Build",
  agy: "AGY",
};

export const jobTypeMeta: Record<string, { label: string; stage: string }> = {
  EXTRACT_COLLECTOR_SESSION: {
    label: "App 会话贡献分析",
    stage: "分析 App 上传的真实会话并提取有来源依据的贡献",
  },
  AGGREGATE_WORK_ITEMS: {
    label: "工作卡聚合",
    stage: "中台模型正在把 Session Fact 聚合为项目工作卡",
  },
  GENERATE_TEAM_REPORT: {
    label: "团队报告生成",
    stage: "中台模型正在汇总已确认的项目素材",
  },
  REGENERATE_TEAM_REPORT: {
    label: "团队报告重新生成",
    stage: "中台模型正在重新汇总团队报告",
  },
  ANALYZE_INSPECTION_FINDING: {
    label: "异常巡检研判",
    stage: "中台模型正在研判巡检发现的异常",
  },
};

export const jobStatusLabel: Record<string, string> = {
  PENDING: "等待处理",
  LEASED: "处理中",
  RETRY_WAIT: "等待重试",
  COMPLETED: "已完成",
  FAILED: "已失败",
  CANCELLED: "已取消",
};

export const errorCodeLabel: Record<string, string> = {
  MODEL_NOT_CONFIGURED: "中台模型尚未配置",
  MODEL_REQUEST_TIMEOUT: "中台模型响应超时",
  CENTRAL_GENERATION_FAILED: "中台模型生成失败",
  LEASE_EXHAUSTED: "任务租约多次过期",
};

const detailLabels: Record<string, string> = {
  appVersion: "App 版本",
  osVersion: "系统版本",
  durationMs: "耗时",
  httpStatus: "HTTP 状态",
  apiErrorCode: "接口错误码",
  errorDomain: "错误域",
  errorCode: "错误码",
  errorKind: "错误类型",
  message: "错误信息",
  projectCount: "项目数",
  sessionCount: "会话数",
  failedSessionCount: "读取失败会话数",
  partIndex: "分包序号",
  partCount: "分包总数",
  bytes: "数据大小",
  windowStart: "窗口开始",
  windowEnd: "窗口结束",
  periodKey: "采集周期",
  policyVersion: "权限版本",
  agent: "采集来源",
  retryAttempt: "重试次数",
  type: "任务类型",
  status: "状态",
  attempt: "当前尝试",
  maxAttempts: "最大尝试",
  idempotencyKey: "幂等键",
  uploadId: "关联上传",
  leaseUntil: "租约到期",
  nextRetryAt: "下次重试",
  kind: "通知类型",
  aggregateType: "聚合类型",
  eventType: "事件类型",
  version: "版本",
};

function formatDetailValue(key: string, value: unknown, timezone: string) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (key === "durationMs") return formatDuration(value);
    if (key === "bytes") return formatBytes(value);
    return String(value);
  }
  if (typeof value === "string") {
    if (/(At|Until|Start|End)$/.test(key) && !Number.isNaN(Date.parse(value)))
      return formatTime(value, timezone);
    if (key === "errorKind") return errorKindLabels[value] ?? value;
    if (key === "agent") return agentLabels[value] ?? value;
    if (key === "type") return jobTypeMeta[value]?.label ?? value;
    if (key === "status") return jobStatusLabel[value] ?? value;
    return value;
  }
  return JSON.stringify(value);
}

export function detailEntries(
  details: Record<string, unknown> | null | undefined,
  timezone: string,
): Array<[string, string]> {
  return Object.entries(details ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [
      detailLabels[key] ?? key,
      formatDetailValue(key, value, timezone),
    ]);
}

export function DetailList({
  entries,
}: {
  entries: Array<[string, ReactNode]>;
}) {
  return (
    <dl className="sm-detail-list">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LogWindowToolbar({
  view,
  onView,
  date,
  onDate,
  today,
  timezone,
  fetching,
  onRefresh,
  dateLabel,
  refreshTitle,
}: {
  view: "recent" | "history";
  onView: (view: "recent" | "history") => void;
  date: string;
  onDate: (date: string) => void;
  today: string;
  timezone: string;
  fetching: boolean;
  onRefresh: () => void;
  dateLabel: string;
  refreshTitle: string;
}) {
  const selectDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today) return;
    onDate(value);
  };
  return (
    <div className="sm-window-toolbar">
      <div className="sm-segment" aria-label="日志时间范围">
        <button
          aria-pressed={view === "recent"}
          onClick={() => onView("recent")}
        >
          <Clock3 size={15} />
          最近 24 小时
        </button>
        <button
          aria-pressed={view === "history"}
          onClick={() => onView("history")}
        >
          <CalendarDays size={15} />
          历史日志
        </button>
      </div>
      {view === "history" && (
        <div className="sm-date-controls">
          <button
            className="icon-button"
            title="前一天"
            onClick={() => selectDate(shiftDateKey(date, -1))}
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            aria-label={dateLabel}
            value={date}
            max={today}
            onChange={(event) => selectDate(event.target.value)}
          />
          <button
            className="icon-button"
            title="后一天"
            disabled={date >= today}
            onClick={() => selectDate(shiftDateKey(date, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      <span className="sm-timezone">{timezone}</span>
      <button
        className="icon-button"
        title={refreshTitle}
        disabled={fetching}
        onClick={onRefresh}
      >
        <RefreshCw size={16} className={fetching ? "spin" : ""} />
      </button>
    </div>
  );
}
