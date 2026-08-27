import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  FileCheck2,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  ServerCog,
  Sparkles,
  TerminalSquare,
  TestTube2,
} from "lucide-react";
import { Link } from "wouter";
import { api, ApiClientError } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";

type Severity = "normal" | "warning" | "critical" | "unknown";

type SystemComponent = {
  key: "api" | "queue" | "generation" | "feishu" | "reports";
  label: string;
  severity: Severity;
  summary: string;
  detail: string;
  count: number;
};

type Incident = {
  id: string;
  sourceId: string;
  source: "generation" | "feishu" | "reports";
  severity: Severity;
  title: string;
  message: string;
  errorCode: string | null;
  partnerName: string | null;
  occurredAt: string;
  action: string;
  href: string | null;
};

type SystemMonitoring = {
  checkedAt: string;
  overallSeverity: Severity;
  summary: {
    componentCount: number;
    normal: number;
    warning: number;
    critical: number;
    openIncidents: number;
  };
  components: SystemComponent[];
  incidents: Incident[];
};

type SystemProbeResult = {
  component: SystemComponent["key"];
  status: "passed" | "failed";
  summary: string;
  detail: string;
  errorCode: string | null;
  durationMs: number;
  checkedAt: string;
};

type SystemLogSource = "inbox" | "job" | "delivery" | "outbox" | "report";
type SystemLogEvent = {
  id: string;
  executionId: string;
  source: SystemLogSource;
  level: "info" | "warning" | "error";
  stage: string;
  eventCode: string;
  title: string;
  message: string;
  occurredAt: string;
  details: Record<string, unknown>;
};
type SystemLogExecution = {
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
};
type SystemLogs = {
  window: {
    mode: "recent" | "day";
    date: string | null;
    timezone: string;
    startedAt: string;
    endedAt: string;
  };
  selectedExecutionId: string | null;
  executions: SystemLogExecution[];
  events: SystemLogEvent[];
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
  } | null;
};

const severityTone = {
  normal: "success",
  warning: "warning",
  critical: "danger",
  unknown: "neutral",
} as const;

const severityLabel = {
  normal: "正常",
  warning: "需关注",
  critical: "异常",
  unknown: "未知",
};

const sourceLabel = {
  generation: "内容生成",
  feishu: "飞书消息",
  reports: "报告生成",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function ComponentIcon({
  componentKey,
}: {
  componentKey: SystemComponent["key"];
}) {
  if (componentKey === "api") return <Database size={18} />;
  if (componentKey === "queue") return <ServerCog size={18} />;
  if (componentKey === "generation") return <Bot size={18} />;
  if (componentKey === "feishu") return <MessageSquare size={18} />;
  return <FileCheck2 size={18} />;
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(1)} 秒`;
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

const systemSourceLabel: Record<SystemLogSource, string> = {
  inbox: "接收",
  job: "生成",
  delivery: "发送",
  outbox: "事件",
  report: "报告",
};

const systemStatusLabel: Record<string, string> = {
  PENDING: "等待处理",
  LEASED: "处理中",
  RETRY_WAIT: "等待重试",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  pending: "等待处理",
  sending: "发送中",
  retry_wait: "等待重试",
  deferred: "暂缓发送",
  sent: "已发送",
  failed: "失败",
  cancelled: "已取消",
  received: "已接收",
  processing: "处理中",
  processed: "已处理",
  published: "已分发",
  AGGREGATING: "生成中",
  TEAM_DRAFT: "待确认",
  LOCKED: "已归档",
};

function SystemLogBrowser() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"recent" | "history">("recent");
  const [historyDate, setHistoryDate] = useState(() =>
    dateKeyInTimezone("Asia/Shanghai"),
  );
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const params = useMemo(() => {
    const value = new URLSearchParams();
    if (view === "history") value.set("date", historyDate);
    if (executionId) value.set("executionId", executionId);
    return value.toString();
  }, [executionId, historyDate, view]);
  const logs = useQuery({
    queryKey: ["admin-system-logs", view, historyDate, executionId],
    queryFn: () => api<SystemLogs>(`/v1/admin/system-logs?${params}`),
    refetchInterval: view === "recent" ? 10_000 : false,
  });
  const requestAnalysis = useMutation({
    mutationFn: (selectedExecutionId: string) =>
      api("/v1/admin/system-logs/analyze", {
        method: "POST",
        body: JSON.stringify({ executionId: selectedExecutionId }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-system-logs"] }),
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

  const selected = logs.data?.executions.find(
    (item) => item.executionId === logs.data?.selectedExecutionId,
  );
  const visibleEvents = (logs.data?.events ?? []).filter(
    (item) => !problemsOnly || item.level !== "info",
  );
  const timezone = logs.data?.window.timezone ?? "Asia/Shanghai";
  const today = dateKeyInTimezone(timezone);
  const selectDate = (date: string) => {
    setHistoryDate(date);
    setExecutionId(null);
    setProblemsOnly(false);
  };

  return (
    <section className="system-log-section" aria-label="中台运行日志">
      <div className="system-log-heading">
        <div>
          <TerminalSquare size={18} />
          <strong>中台运行日志</strong>
          <span>接收、生成、发送与报告状态</span>
        </div>
        <button
          className="icon-button"
          title="刷新中台日志"
          onClick={() => void logs.refetch()}
        >
          <RefreshCw size={16} className={logs.isFetching ? "spin" : ""} />
        </button>
      </div>
      <ErrorBanner error={logs.error ?? requestAnalysis.error} />
      <div className="plugin-execution-browser system-execution-browser">
        <aside className="plugin-execution-list" aria-label="中台运行记录">
          <div className="plugin-log-section-title">
            {view === "recent" ? (
              <Clock3 size={17} />
            ) : (
              <CalendarDays size={17} />
            )}
            <strong>{view === "recent" ? "最近 24 小时" : "历史日志"}</strong>
            <span>{logs.data?.executions.length ?? 0}</span>
            <button
              className="plugin-history-link"
              onClick={() => {
                if (view === "recent") {
                  setView("history");
                  selectDate(today);
                } else {
                  setView("recent");
                  setExecutionId(null);
                  setProblemsOnly(false);
                }
              }}
            >
              {view === "recent" ? (
                <CalendarDays size={14} />
              ) : (
                <ArrowLeft size={14} />
              )}
              {view === "recent" ? "历史日志" : "最近日志"}
            </button>
          </div>
          {view === "history" && (
            <div className="plugin-history-toolbar">
              <button
                className="icon-button"
                title="前一天"
                onClick={() => selectDate(shiftDateKey(historyDate, -1))}
              >
                <ChevronLeft size={16} />
              </button>
              <input
                type="date"
                aria-label="中台历史日志日期"
                value={historyDate}
                max={today}
                onChange={(event) =>
                  event.target.value && selectDate(event.target.value)
                }
              />
              <button
                className="icon-button"
                title="后一天"
                disabled={historyDate >= today}
                onClick={() => selectDate(shiftDateKey(historyDate, 1))}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {logs.isLoading ? (
            <div className="plugin-log-loading">
              <RefreshCw size={16} className="spin" />
              加载中台日志
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
                  className={`plugin-execution-state ${execution.severity}`}
                >
                  {execution.severity === "critical" ? (
                    <AlertTriangle size={15} />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                </span>
                <span className="plugin-execution-copy">
                  <strong>{execution.title}</strong>
                  <small>
                    {systemSourceLabel[execution.source]} ·{" "}
                    {formatTime(execution.startedAt)}
                  </small>
                  <small>
                    {execution.subject} · {execution.eventCount} 个事件
                  </small>
                  <small className="plugin-execution-conclusion">
                    {execution.summary}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))
          ) : (
            <EmptyState
              title={
                view === "recent"
                  ? "最近 24 小时没有中台日志"
                  : "这一天没有中台日志"
              }
            />
          )}
        </aside>
        <section className="plugin-execution-detail">
          {selected ? (
            <>
              <header className="plugin-execution-header">
                <div>
                  <span>{systemSourceLabel[selected.source]}</span>
                  <strong>{selected.title}</strong>
                </div>
                <Badge tone={severityTone[selected.severity]}>
                  {systemStatusLabel[selected.status] ?? selected.status}
                </Badge>
                {selected.severity !== "normal" && (
                  <button
                    className="plugin-analysis-button"
                    onClick={() => requestAnalysis.mutate(selected.executionId)}
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
                className={`execution-diagnosis execution-diagnosis-${selected.severity}`}
              >
                <span className="execution-diagnosis-icon">
                  {selected.severity === "critical" ? (
                    <AlertTriangle size={18} />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                </span>
                <div>
                  <span className="execution-conclusion-label">运行结论</span>
                  <strong>{selected.summary}</strong>
                  <p>{selected.subject}</p>
                  <small>{selected.errorCode ?? "未发现错误代码"}</small>
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
                            logs.data.modelAnalysis.output_payload.confidence
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
                      <strong>模型正在分析这次中台运行</strong>
                      <p>完成后会显示最可能原因和处理建议。</p>
                    </div>
                  )}
                </div>
              )}
              <dl className="plugin-execution-meta">
                <div>
                  <dt>开始时间</dt>
                  <dd>{formatTime(selected.startedAt)}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>{formatDuration(selected.durationMs)}</dd>
                </div>
                <div>
                  <dt>记录类型</dt>
                  <dd>{systemSourceLabel[selected.source]}</dd>
                </div>
                <div>
                  <dt>记录编号</dt>
                  <dd>{selected.sourceId.slice(0, 8)}</dd>
                </div>
              </dl>
              <div className="plugin-event-toolbar">
                <div>
                  <TerminalSquare size={17} />
                  <strong>执行时间线</strong>
                  <span>{visibleEvents.length}</span>
                </div>
                <div className="plugin-event-mode" aria-label="中台日志筛选">
                  <button
                    className={!problemsOnly ? "active" : ""}
                    onClick={() => setProblemsOnly(false)}
                  >
                    <TerminalSquare size={14} />
                    全部
                  </button>
                  <button
                    className={problemsOnly ? "active" : ""}
                    onClick={() => setProblemsOnly(true)}
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
                          {event.level === "info" ? (
                            <CheckCircle2 size={16} />
                          ) : (
                            <AlertTriangle size={16} />
                          )}
                        </span>
                        <span className="plugin-event-main">
                          <strong>{event.title}</strong>
                          <small>
                            {event.eventCode} · {event.stage}
                          </small>
                        </span>
                        <time>{formatTime(event.occurredAt)}</time>
                      </summary>
                      <div className="plugin-event-expanded">
                        <p>{event.message}</p>
                        <pre>{JSON.stringify(event.details, null, 2)}</pre>
                      </div>
                    </details>
                  ))
                ) : (
                  <EmptyState
                    title={
                      problemsOnly
                        ? "本次运行没有错误或警告"
                        : "本次运行没有时间线事件"
                    }
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyState title="选择一条中台运行记录查看详情" />
          )}
        </section>
      </div>
    </section>
  );
}

function SystemComponentRow({ component }: { component: SystemComponent }) {
  const [result, setResult] = useState<SystemProbeResult | null>(null);
  const probe = useMutation({
    mutationFn: () =>
      api<SystemProbeResult>(
        `/v1/admin/system-monitoring/${component.key}/test`,
        { method: "POST" },
      ),
    onSuccess: setResult,
    onError: (error) => {
      setResult({
        component: component.key,
        status: "failed",
        summary: "模块测试未完成",
        detail:
          error instanceof ApiClientError
            ? error.message
            : "请求没有正常完成，请稍后重试。",
        errorCode: error instanceof ApiClientError ? error.code : null,
        durationMs: 0,
        checkedAt: new Date().toISOString(),
      });
    },
  });

  return (
    <div
      className={`system-component-row system-component-${component.severity}`}
    >
      <span className="system-component-icon">
        <ComponentIcon componentKey={component.key} />
      </span>
      <div className="system-component-copy">
        <strong>{component.label}</strong>
        <span>{component.summary}</span>
      </div>
      <div className="system-component-actions">
        <button
          type="button"
          className="system-probe-button"
          title={`测试${component.label}`}
          aria-label={`测试${component.label}`}
          disabled={probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? (
            <RefreshCw size={14} className="spin" />
          ) : (
            <TestTube2 size={14} />
          )}
          <span>{probe.isPending ? "测试中" : "测试"}</span>
        </button>
        <Badge tone={severityTone[component.severity]}>
          {severityLabel[component.severity]}
        </Badge>
      </div>
      {result && (
        <div
          className={`system-probe-result system-probe-result-${result.status}`}
          aria-live="polite"
        >
          <span className="system-probe-result-icon">
            {result.status === "passed" ? (
              <CheckCircle2 size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
          </span>
          <div>
            <strong>{result.summary}</strong>
            <p>{result.detail}</p>
            <small>
              {formatTime(result.checkedAt)}
              {result.durationMs > 0
                ? ` · 耗时 ${formatDuration(result.durationMs)}`
                : ""}
              {result.errorCode ? ` · ${result.errorCode}` : ""}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}

export function SystemMonitoringPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["admin-system-monitoring"],
    queryFn: () => api<SystemMonitoring>("/v1/admin/system-monitoring"),
    refetchInterval: 10_000,
  });

  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载系统状态
      </div>
    );

  const data = query.data;
  return (
    <div className="page admin-page system-monitoring-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">SYSTEM HEALTH</span>
          <h1>系统监控</h1>
          <p>
            查看数据进入服务器之后的任务处理、内容生成、消息发送和报告状态。
          </p>
        </div>
        <button
          className="icon-button"
          title="刷新系统状态"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} className={query.isFetching ? "spin" : ""} />
        </button>
      </header>
      <ErrorBanner error={query.error} />

      {data && (
        <>
          <div
            className={`system-health-banner system-health-${data.overallSeverity}`}
          >
            <span>
              {data.overallSeverity === "normal" ? (
                <CheckCircle2 size={21} />
              ) : (
                <AlertTriangle size={21} />
              )}
            </span>
            <div>
              <strong>
                {data.overallSeverity === "normal"
                  ? "系统整体运行正常"
                  : data.overallSeverity === "warning"
                    ? "系统存在需要关注的状态"
                    : "系统当前存在异常"}
              </strong>
              <p>最近检查 {formatTime(data.checkedAt)}</p>
            </div>
            <Badge tone={severityTone[data.overallSeverity]}>
              {severityLabel[data.overallSeverity]}
            </Badge>
          </div>

          <div className="monitor-summary" aria-label="系统状态汇总">
            <div>
              <span>监控模块</span>
              <strong>{data.summary.componentCount}</strong>
            </div>
            <div className="monitor-summary-normal">
              <span>运行正常</span>
              <strong>{data.summary.normal}</strong>
            </div>
            <div className="monitor-summary-warning">
              <span>需要关注</span>
              <strong>{data.summary.warning}</strong>
            </div>
            <div className="monitor-summary-critical">
              <span>当前异常</span>
              <strong>{data.summary.critical}</strong>
            </div>
          </div>

          <div
            className={`system-monitor-workspace ${data.incidents.length ? "has-incidents" : ""}`}
          >
            <section
              className="system-component-panel"
              aria-label="系统模块状态"
            >
              <div className="system-monitor-section-title">
                <ServerCog size={17} />
                <strong>系统模块</strong>
                <span>{data.components.length}</span>
              </div>
              <div className="system-component-list">
                {data.components.map((component) => (
                  <SystemComponentRow
                    component={component}
                    key={component.key}
                  />
                ))}
              </div>
            </section>

            {data.incidents.length > 0 && (
              <section className="system-incident-panel" aria-label="当前异常">
                <div className="system-monitor-section-title">
                  <AlertTriangle size={17} />
                  <strong>当前异常</strong>
                  <span>{data.incidents.length}</span>
                </div>
                <div className="system-incident-list">
                  {data.incidents.map((incident) => (
                    <div
                      className={`system-incident system-incident-${incident.severity} ${expandedId === incident.id ? "open" : ""}`}
                      key={incident.id}
                    >
                      <button
                        type="button"
                        className="system-incident-summary"
                        aria-expanded={expandedId === incident.id}
                        onClick={() =>
                          setExpandedId((current) =>
                            current === incident.id ? null : incident.id,
                          )
                        }
                      >
                        <span className="system-incident-marker" />
                        <span className="system-incident-copy">
                          <span>
                            <Badge tone={severityTone[incident.severity]}>
                              {sourceLabel[incident.source]}
                            </Badge>
                            <strong>{incident.title}</strong>
                          </span>
                          <small>
                            {incident.partnerName ?? "团队级任务"} ·{" "}
                            {formatTime(incident.occurredAt)}
                          </small>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                      {expandedId === incident.id && (
                        <div className="system-incident-detail">
                          <p>{incident.message}</p>
                          <dl>
                            <div>
                              <dt>建议处理</dt>
                              <dd>{incident.action}</dd>
                            </div>
                            <div>
                              <dt>错误代码</dt>
                              <dd>{incident.errorCode ?? "无"}</dd>
                            </div>
                            <div>
                              <dt>记录编号</dt>
                              <dd>{incident.sourceId}</dd>
                            </div>
                          </dl>
                          {incident.href && (
                            <Link
                              className="incident-link"
                              href={incident.href}
                            >
                              查看异常任务
                              <ChevronRight size={15} />
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="system-monitor-footnote">
                  <Clock3 size={14} />
                  状态每 10 秒自动更新
                </div>
              </section>
            )}
          </div>
          <SystemLogBrowser />
        </>
      )}
    </div>
  );
}
