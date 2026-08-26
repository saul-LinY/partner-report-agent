import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  Server,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";
import {
  pluginExecutionKindLabel,
  pluginExecutionLabel,
  type PluginExecutionGrouping,
} from "./plugin-log-labels.js";

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
  invocation_id: string | null;
  run_id: string | null;
  sequence: number | null;
  command: string | null;
  event_type: "lifecycle" | "progress" | "result" | "error" | null;
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

type ExecutionDiagnosis = {
  severity: Severity;
  state: "completed" | "failed" | "running" | "interrupted" | "warning";
  title: string;
  cause: string;
  action: string;
  failedStage: string | null;
  evidenceCode: string | null;
  retryable: boolean;
};

type PluginExecution = {
  executionId: string;
  grouping: PluginExecutionGrouping;
  invocationId: string | null;
  runId: string | null;
  command: string;
  startedAt: string;
  lastEventAt: string;
  durationMs: number;
  eventCount: number;
  errorCount: number;
  warningCount: number;
  finalSummary: string | null;
  diagnosis: ExecutionDiagnosis;
};

type PluginLogs = {
  pluginInstanceId: string;
  window: {
    mode: "recent" | "day";
    date: string | null;
    timezone: string;
    startedAt: string;
    endedAt: string;
  };
  selectedExecutionId: string | null;
  events: LogEvent[];
  executions: PluginExecution[];
  modelAnalysis: {
    id: string;
    status: "PENDING" | "LEASED" | "RETRY_WAIT" | "COMPLETED" | "FAILED";
    output_payload: {
      summary: string;
      failedStep: string;
      rootCause: string;
      evidence: string[];
      recommendedActions: string[];
      confidence: "high" | "medium" | "low";
    } | null;
    error_code: string | null;
    error_message: string | null;
    updated_at: string;
  } | null;
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
const stateLabel = {
  completed: "已完成",
  failed: "失败",
  running: "运行中",
  interrupted: "已中断",
  warning: "需关注",
};
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

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} 秒`;
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round((durationMs % 60_000) / 1000)} 秒`;
}

function dateKeyInTimezone(timezone: string) {
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

function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function PluginMonitoringPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [logView, setLogView] = useState<"recent" | "history">("recent");
  const [historyDate, setHistoryDate] = useState(() =>
    dateKeyInTimezone("Asia/Shanghai"),
  );
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
  const timezone = monitoring.data?.schedule.timezone ?? "Asia/Shanghai";
  const today = useMemo(
    () => dateKeyInTimezone(timezone),
    [monitoring.data?.checkedAt, timezone],
  );
  const params = useMemo(() => {
    if (!selectedId) return "";
    const value = new URLSearchParams({ pluginInstanceId: selectedId });
    if (logView === "history") value.set("date", historyDate);
    if (executionId) value.set("executionId", executionId);
    return value.toString();
  }, [executionId, historyDate, logView, selectedId]);
  const logs = useQuery({
    queryKey: [
      "admin-plugin-logs",
      selectedId,
      logView,
      historyDate,
      executionId,
    ],
    queryFn: () => api<PluginLogs>(`/v1/admin/plugin-logs?${params}`),
    enabled: Boolean(selectedId),
    refetchInterval: logView === "recent" ? 10_000 : false,
  });
  const requestAnalysis = useMutation({
    mutationFn: (selectedExecutionId: string) =>
      api("/v1/admin/plugin-logs/analyze", {
        method: "POST",
        body: JSON.stringify({
          pluginInstanceId: selectedId,
          executionId: selectedExecutionId,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin-plugin-logs", selectedId],
      });
    },
  });

  useEffect(() => {
    if (!logs.data) return;
    if (!executionId && logs.data.selectedExecutionId)
      setExecutionId(logs.data.selectedExecutionId);
    else if (
      executionId &&
      !logs.data.executions.some((item) => item.executionId === executionId)
    )
      setExecutionId(logs.data.selectedExecutionId);
  }, [executionId, logs.data]);

  const selectedExecution = logs.data?.executions.find(
    (item) => item.executionId === logs.data?.selectedExecutionId,
  );
  const visibleEvents = (logs.data?.events ?? []).filter(
    (event) =>
      !problemsOnly || event.level === "warning" || event.level === "error",
  );
  const selectHistoryDate = (value: string) => {
    setHistoryDate(value);
    setExecutionId(null);
    setProblemsOnly(false);
  };

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
          <p>按插件命令或采集批次查看运行过程、返回结果和故障位置。</p>
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
      <ErrorBanner
        error={monitoring.error ?? logs.error ?? requestAnalysis.error}
      />

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
                  setExecutionId(null);
                  setProblemsOnly(false);
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

            <div className="plugin-execution-browser">
              <aside
                className="plugin-execution-list"
                aria-label={logView === "recent" ? "最近运行" : "历史日志"}
              >
                <div className="plugin-log-section-title">
                  {logView === "recent" ? (
                    <Clock3 size={17} />
                  ) : (
                    <CalendarDays size={17} />
                  )}
                  <strong>
                    {logView === "recent" ? "最近 24 小时" : "历史日志"}
                  </strong>
                  <span>{logs.data?.executions.length ?? 0}</span>
                  {logView === "recent" ? (
                    <button
                      className="plugin-history-link"
                      onClick={() => {
                        setLogView("history");
                        selectHistoryDate(today);
                      }}
                    >
                      <CalendarDays size={14} />
                      历史日志
                    </button>
                  ) : (
                    <button
                      className="plugin-history-link"
                      onClick={() => {
                        setLogView("recent");
                        setExecutionId(null);
                        setProblemsOnly(false);
                      }}
                    >
                      <ArrowLeft size={14} />
                      最近日志
                    </button>
                  )}
                </div>
                {logView === "history" && (
                  <div className="plugin-history-toolbar">
                    <button
                      className="icon-button"
                      title="前一天"
                      onClick={() =>
                        selectHistoryDate(shiftDateKey(historyDate, -1))
                      }
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <input
                      type="date"
                      aria-label="历史日志日期"
                      value={historyDate}
                      max={today}
                      onChange={(event) => {
                        if (event.target.value)
                          selectHistoryDate(event.target.value);
                      }}
                    />
                    <button
                      className="icon-button"
                      title="后一天"
                      disabled={historyDate >= today}
                      onClick={() =>
                        selectHistoryDate(shiftDateKey(historyDate, 1))
                      }
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
                {logs.isLoading ? (
                  <div className="plugin-log-loading">
                    <RefreshCw size={16} className="spin" />
                    加载运行记录
                  </div>
                ) : logs.data?.executions.length ? (
                  logs.data.executions.map((execution) => (
                    <button
                      key={execution.executionId}
                      className={`plugin-execution-row ${logs.data?.selectedExecutionId === execution.executionId ? "active" : ""}`}
                      onClick={() => {
                        setExecutionId(execution.executionId);
                        setProblemsOnly(false);
                      }}
                    >
                      <span
                        className={`plugin-execution-state ${execution.diagnosis.severity}`}
                      >
                        {execution.diagnosis.severity === "critical" ? (
                          <AlertTriangle size={15} />
                        ) : (
                          <CheckCircle2 size={15} />
                        )}
                      </span>
                      <span className="plugin-execution-copy">
                        <strong>{pluginExecutionLabel(execution)}</strong>
                        <small>{formatTime(execution.startedAt)}</small>
                        <small>
                          {stateLabel[execution.diagnosis.state]} ·{" "}
                          {execution.eventCount} 个事件
                        </small>
                        {execution.finalSummary && (
                          <small className="plugin-execution-conclusion">
                            {execution.finalSummary}
                          </small>
                        )}
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))
                ) : (
                  <EmptyState
                    title={
                      logView === "recent"
                        ? "最近 24 小时没有运行日志"
                        : "这一天没有运行日志"
                    }
                  />
                )}
              </aside>

              <section className="plugin-execution-detail">
                {selectedExecution ? (
                  <>
                    <header className="plugin-execution-header">
                      <div>
                        <span>
                          {pluginExecutionKindLabel(selectedExecution.grouping)}
                        </span>
                        <strong>
                          {pluginExecutionLabel(selectedExecution)}
                        </strong>
                      </div>
                      <Badge
                        tone={
                          severityTone[selectedExecution.diagnosis.severity]
                        }
                      >
                        {stateLabel[selectedExecution.diagnosis.state]}
                      </Badge>
                      {selectedExecution.grouping === "invocation" && (
                        <button
                          className="plugin-analysis-button"
                          onClick={() =>
                            requestAnalysis.mutate(
                              selectedExecution.executionId,
                            )
                          }
                          disabled={
                            requestAnalysis.isPending ||
                            ["PENDING", "LEASED"].includes(
                              logs.data?.modelAnalysis?.status ?? "",
                            )
                          }
                        >
                          {requestAnalysis.isPending ||
                          ["PENDING", "LEASED"].includes(
                            logs.data?.modelAnalysis?.status ?? "",
                          ) ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <Sparkles size={14} />
                          )}
                          {logs.data?.modelAnalysis?.status === "COMPLETED"
                            ? "重新分析"
                            : "模型分析"}
                        </button>
                      )}
                    </header>
                    <div
                      className={`execution-diagnosis execution-diagnosis-${selectedExecution.diagnosis.severity}`}
                    >
                      <span className="execution-diagnosis-icon">
                        {selectedExecution.diagnosis.severity === "critical" ? (
                          <AlertTriangle size={18} />
                        ) : (
                          <CheckCircle2 size={18} />
                        )}
                      </span>
                      <div>
                        <span className="execution-conclusion-label">
                          运行结论
                        </span>
                        <strong>{selectedExecution.diagnosis.title}</strong>
                        <p>{selectedExecution.diagnosis.cause}</p>
                        <small>{selectedExecution.diagnosis.action}</small>
                      </div>
                    </div>
                    {logs.data?.modelAnalysis && (
                      <div className="plugin-model-analysis">
                        <span className="plugin-model-analysis-icon">
                          {logs.data.modelAnalysis.status === "COMPLETED" ? (
                            <Sparkles size={17} />
                          ) : logs.data.modelAnalysis.status === "FAILED" ? (
                            <AlertTriangle size={17} />
                          ) : (
                            <LoaderCircle size={17} className="spin" />
                          )}
                        </span>
                        {logs.data.modelAnalysis.status === "COMPLETED" &&
                        logs.data.modelAnalysis.output_payload ? (
                          <div>
                            <strong>
                              模型分析 ·{" "}
                              {logs.data.modelAnalysis.output_payload.summary}
                            </strong>
                            <p>
                              <b>最可能原因：</b>
                              {logs.data.modelAnalysis.output_payload.rootCause}
                            </p>
                            <ul>
                              {logs.data.modelAnalysis.output_payload.recommendedActions.map(
                                (action) => (
                                  <li key={action}>{action}</li>
                                ),
                              )}
                            </ul>
                            <small>
                              可信度：
                              {
                                { high: "高", medium: "中", low: "低" }[
                                  logs.data.modelAnalysis.output_payload
                                    .confidence
                                ]
                              }
                            </small>
                          </div>
                        ) : logs.data.modelAnalysis.status === "FAILED" ? (
                          <div>
                            <strong>模型分析失败</strong>
                            <p>
                              {logs.data.modelAnalysis.error_message ??
                                logs.data.modelAnalysis.error_code ??
                                "模型服务暂时不可用。"}
                            </p>
                          </div>
                        ) : (
                          <div>
                            <strong>模型正在分析这次运行</strong>
                            <p>完成后会自动显示最可能原因和处理建议。</p>
                          </div>
                        )}
                      </div>
                    )}
                    <dl className="plugin-execution-meta">
                      <div>
                        <dt>开始时间</dt>
                        <dd>{formatTime(selectedExecution.startedAt)}</dd>
                      </div>
                      <div>
                        <dt>耗时</dt>
                        <dd>{formatDuration(selectedExecution.durationMs)}</dd>
                      </div>
                      <div>
                        <dt>命令执行 ID</dt>
                        <dd>
                          {selectedExecution.invocationId
                            ? shortId(selectedExecution.invocationId)
                            : "未提供"}
                        </dd>
                      </div>
                      <div>
                        <dt>采集批次</dt>
                        <dd>
                          {selectedExecution.runId
                            ? shortId(selectedExecution.runId)
                            : "非采集命令"}
                        </dd>
                      </div>
                    </dl>
                    <div className="plugin-event-toolbar">
                      <div>
                        <TerminalSquare size={17} />
                        <strong>执行时间线</strong>
                        <span>{visibleEvents.length}</span>
                      </div>
                      <div className="plugin-event-mode" aria-label="日志筛选">
                        <button
                          className={!problemsOnly ? "active" : ""}
                          onClick={() => setProblemsOnly(false)}
                          title="显示全部事件"
                        >
                          <TerminalSquare size={14} />
                          全部
                        </button>
                        <button
                          className={problemsOnly ? "active" : ""}
                          onClick={() => setProblemsOnly(true)}
                          title="只显示错误和警告"
                        >
                          <ListFilter size={14} />
                          仅看问题
                        </button>
                      </div>
                    </div>
                    <div className="plugin-event-list">
                      {visibleEvents.length ? (
                        visibleEvents.map((event) => (
                          <details
                            className={`plugin-event plugin-event-${event.level}`}
                            key={event.id}
                            open={event.level === "error"}
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
                                    ? ` · ${formatDuration(event.duration_ms)}`
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
                                  <dt>事件顺序</dt>
                                  <dd>{event.sequence ?? "未提供"}</dd>
                                </div>
                                <div>
                                  <dt>可重试</dt>
                                  <dd>{event.retryable ? "是" : "否"}</dd>
                                </div>
                              </dl>
                              {Object.keys(event.details ?? {}).length > 0 && (
                                <pre>
                                  {JSON.stringify(event.details, null, 2)}
                                </pre>
                              )}
                              {event.stack && (
                                <pre className="plugin-event-stack">
                                  {event.stack}
                                </pre>
                              )}
                            </div>
                          </details>
                        ))
                      ) : (
                        <EmptyState
                          title={
                            problemsOnly
                              ? "这次运行没有错误或警告"
                              : "这次运行没有事件"
                          }
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <EmptyState title="请选择一次运行" />
                )}
              </section>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
