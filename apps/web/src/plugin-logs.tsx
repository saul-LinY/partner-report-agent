import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  RefreshCw,
  Server,
  TerminalSquare,
} from "lucide-react";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";

type Severity = "normal" | "warning" | "critical" | "unknown";

type Plugin = {
  id: string;
  partnerId: string;
  partnerName: string;
  deviceName: string;
  version: string;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
  lastCollectionStartedAt: string | null;
  lastCollectionCompletedAt: string | null;
  latestEventAt: string | null;
  latestStage: string | null;
  latestEventCode: string | null;
  latestMessage: string | null;
  pendingLocalJobs: number;
  runnerState: string;
  status: {
    severity: Severity;
    code: string;
    label: string;
    reason: string;
    action: string;
  };
};

type PluginMonitoring = {
  checkedAt: string;
  schedule: {
    timezone: string;
    time: string;
    graceMinutes: number;
    staleRunMinutes: number;
  };
  summary: {
    total: number;
    normal: number;
    warning: number;
    critical: number;
    unknown: number;
  };
  plugins: Plugin[];
};

type LogEvent = {
  id: string;
  run_id: string | null;
  level: "debug" | "info" | "warning" | "error";
  stage: string;
  event_code: string;
  message: string;
  stack: string | null;
  retryable: boolean;
  attempt: number | null;
  duration_ms: number | null;
  request_id: string | null;
  details: Record<string, unknown>;
  occurred_at: string;
};

type LogRun = {
  run_id: string;
  started_at: string;
  last_event_at: string;
  event_count: number;
  error_count: number;
  warning_count: number;
};

type GenerationJob = {
  id: string;
  type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
  completed_at: string | null;
};

type PluginLogs = {
  pluginInstanceId: string;
  events: LogEvent[];
  runs: LogRun[];
  generationJobs: GenerationJob[];
};

const levelTone = {
  debug: "neutral",
  info: "info",
  warning: "warning",
  error: "danger",
} as const;

const levelLabel = {
  debug: "调试",
  info: "正常",
  warning: "警告",
  error: "错误",
};

const severityTone = {
  normal: "success",
  warning: "warning",
  critical: "danger",
  unknown: "neutral",
} as const;

function formatTime(value: string | null) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}

export function PluginMonitoringPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState("all");
  const [level, setLevel] = useState("all");
  const monitoring = useQuery({
    queryKey: ["admin-plugin-monitoring"],
    queryFn: () => api<PluginMonitoring>("/v1/admin/plugin-monitoring"),
    refetchInterval: 10_000,
  });
  const plugins = monitoring.data?.plugins ?? [];

  useEffect(() => {
    if (!selectedId && plugins[0]) setSelectedId(plugins[0].id);
    if (selectedId && !plugins.some((plugin) => plugin.id === selectedId))
      setSelectedId(plugins[0]?.id ?? null);
  }, [plugins, selectedId]);

  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedId);
  const params = useMemo(() => {
    if (!selectedId) return "";
    const value = new URLSearchParams({ pluginInstanceId: selectedId });
    if (runId !== "all") value.set("runId", runId);
    if (level !== "all") value.set("level", level);
    return value.toString();
  }, [level, runId, selectedId]);
  const logs = useQuery({
    queryKey: ["admin-plugin-logs", selectedId, runId, level],
    queryFn: () => api<PluginLogs>(`/v1/admin/plugin-logs?${params}`),
    enabled: Boolean(selectedId),
    refetchInterval: 10_000,
  });

  if (monitoring.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载插件状态
      </div>
    );

  const summary = monitoring.data?.summary;
  return (
    <div className="page admin-page plugin-logs-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PLUGIN HEALTH</span>
          <h1>插件监控</h1>
          <p>
            每日 {monitoring.data?.schedule.time ?? "16:00"}{" "}
            运行，超过宽限期未启动或运行中长时间无进度会自动标记异常。
          </p>
        </div>
        <button
          className="icon-button"
          title="刷新插件状态"
          onClick={() => {
            void monitoring.refetch();
            void logs.refetch();
          }}
        >
          <RefreshCw
            size={17}
            className={monitoring.isFetching || logs.isFetching ? "spin" : ""}
          />
        </button>
      </header>
      <ErrorBanner error={monitoring.error ?? logs.error} />

      <div className="monitor-summary" aria-label="插件状态汇总">
        <div>
          <span>插件总数</span>
          <strong>{summary?.total ?? 0}</strong>
        </div>
        <div className="monitor-summary-normal">
          <span>正常运行</span>
          <strong>{summary?.normal ?? 0}</strong>
        </div>
        <div className="monitor-summary-warning">
          <span>需要关注</span>
          <strong>{summary?.warning ?? 0}</strong>
        </div>
        <div className="monitor-summary-critical">
          <span>当前异常</span>
          <strong>{summary?.critical ?? 0}</strong>
        </div>
      </div>

      {plugins.length === 0 ? (
        <EmptyState title="还没有已连接的插件" />
      ) : (
        <div className="plugin-log-workspace">
          <aside className="plugin-log-instances" aria-label="插件实例">
            <div className="plugin-log-panel-title">
              <Server size={16} />
              <strong>使用人员</strong>
              <span>{plugins.length}</span>
            </div>
            {plugins.map((plugin) => (
              <button
                key={plugin.id}
                className={`plugin-instance-row ${selectedId === plugin.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedId(plugin.id);
                  setRunId("all");
                  setLevel("all");
                }}
              >
                <span
                  className={`plugin-instance-state ${plugin.status.severity}`}
                >
                  <CircleDot size={15} />
                </span>
                <span className="plugin-instance-copy">
                  <strong>{plugin.partnerName}</strong>
                  <span>{plugin.deviceName}</span>
                  <small>
                    {plugin.status.label} · v{plugin.version}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </aside>

          <section className="plugin-log-detail">
            {selectedPlugin && (
              <>
                <div className="plugin-log-summary">
                  <div>
                    <span>当前插件</span>
                    <strong>
                      {selectedPlugin.partnerName} · {selectedPlugin.deviceName}
                    </strong>
                  </div>
                  <div>
                    <span>最近一次活动</span>
                    <strong>
                      {formatTime(
                        selectedPlugin.latestEventAt ??
                          selectedPlugin.lastHeartbeatAt,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>当前状态</span>
                    <Badge tone={severityTone[selectedPlugin.status.severity]}>
                      {selectedPlugin.status.label}
                    </Badge>
                  </div>
                </div>
                <div
                  className={`monitor-diagnosis monitor-diagnosis-${selectedPlugin.status.severity}`}
                >
                  <span className="monitor-diagnosis-icon">
                    {selectedPlugin.status.severity === "critical" ? (
                      <AlertTriangle size={18} />
                    ) : (
                      <CheckCircle2 size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{selectedPlugin.status.reason}</strong>
                    <p>{selectedPlugin.status.action}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>最近完成</dt>
                      <dd>
                        {formatTime(selectedPlugin.lastCollectionCompletedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>最后位置</dt>
                      <dd>{selectedPlugin.latestStage ?? "暂无运行记录"}</dd>
                    </div>
                  </dl>
                </div>
              </>
            )}

            <div className="plugin-log-controls">
              <label>
                <span>运行批次</span>
                <select
                  value={runId}
                  onChange={(event) => setRunId(event.target.value)}
                >
                  <option value="all">全部批次</option>
                  {(logs.data?.runs ?? []).map((run) => (
                    <option key={run.run_id} value={run.run_id}>
                      {formatTime(run.started_at)} · {shortId(run.run_id)} ·{" "}
                      {run.error_count} 个错误
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>日志级别</span>
                <select
                  value={level}
                  onChange={(event) => setLevel(event.target.value)}
                >
                  <option value="all">全部级别</option>
                  <option value="error">错误</option>
                  <option value="warning">警告</option>
                  <option value="info">正常</option>
                  <option value="debug">调试</option>
                </select>
              </label>
            </div>

            <div className="plugin-log-section-title">
              <TerminalSquare size={17} />
              <strong>关联日志</strong>
              <span>{logs.data?.events.length ?? 0}</span>
            </div>
            <div className="plugin-event-list">
              {logs.isLoading ? (
                <div className="plugin-log-loading">
                  <RefreshCw size={16} className="spin" /> 加载日志
                </div>
              ) : logs.data?.events.length ? (
                logs.data.events.map((event) => (
                  <details
                    className={`plugin-event plugin-event-${event.level}`}
                    key={event.id}
                  >
                    <summary>
                      <span className="plugin-event-icon">
                        {event.level === "error" ||
                        event.level === "warning" ? (
                          <AlertTriangle size={16} />
                        ) : (
                          <CheckCircle2 size={16} />
                        )}
                      </span>
                      <span className="plugin-event-main">
                        <span>
                          <Badge tone={levelTone[event.level]}>
                            {levelLabel[event.level]}
                          </Badge>
                          <strong>{event.message}</strong>
                        </span>
                        <small>
                          {event.stage} · {event.event_code}
                          {event.duration_ms !== null
                            ? ` · ${event.duration_ms} ms`
                            : ""}
                        </small>
                      </span>
                      <time>{formatTime(event.occurred_at)}</time>
                    </summary>
                    <div className="plugin-event-expanded">
                      <dl>
                        <div>
                          <dt>事件编号</dt>
                          <dd>{event.id}</dd>
                        </div>
                        <div>
                          <dt>请求编号</dt>
                          <dd>{event.request_id ?? "无"}</dd>
                        </div>
                        <div>
                          <dt>运行批次</dt>
                          <dd>{event.run_id ?? "非采集事件"}</dd>
                        </div>
                        <div>
                          <dt>可重试</dt>
                          <dd>{event.retryable ? "是" : "否"}</dd>
                        </div>
                      </dl>
                      {Object.keys(event.details ?? {}).length > 0 && (
                        <pre>{JSON.stringify(event.details, null, 2)}</pre>
                      )}
                      {event.stack && (
                        <pre className="plugin-event-stack">{event.stack}</pre>
                      )}
                    </div>
                  </details>
                ))
              ) : (
                <EmptyState title="当前筛选条件下没有关联日志" />
              )}
            </div>

            <div className="plugin-log-section-title generation-title">
              <Clock3 size={17} />
              <strong>内容生成任务</strong>
              <span>{logs.data?.generationJobs.length ?? 0}</span>
            </div>
            <div className="generation-log-table">
              {(logs.data?.generationJobs ?? []).map((job) => (
                <div className="generation-log-row" key={job.id}>
                  <span>
                    <strong>{job.type}</strong>
                    <small>
                      {shortId(job.id)} · {formatTime(job.updated_at)}
                    </small>
                  </span>
                  <span>{job.error_message ?? "任务正常完成或仍在运行"}</span>
                  <Badge
                    tone={
                      job.status === "FAILED"
                        ? "danger"
                        : job.status === "RETRY_WAIT"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {job.status}
                  </Badge>
                </div>
              ))}
              {!logs.isLoading && !logs.data?.generationJobs.length && (
                <EmptyState title="该用户还没有内容生成任务" />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
