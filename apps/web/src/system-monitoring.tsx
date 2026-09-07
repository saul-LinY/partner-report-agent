import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Activity,
  ArrowUpRight,
  Search,
  X,
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
import "./system-monitoring.css";

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

function formatTime(value: string, timezone = "Asia/Shanghai") {
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

const PAGE_SIZE = 12;
const analysisPending = (status: string | undefined) =>
  ["PENDING", "LEASED", "RETRY_WAIT"].includes(status ?? "");

function SystemLogBrowser({
  active,
  autoRefresh,
}: {
  active: boolean;
  autoRefresh: boolean;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"recent" | "history">("recent");
  const [historyDate, setHistoryDate] = useState(() =>
    dateKeyInTimezone("Asia/Shanghai"),
  );
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [sort, setSort] = useState("latest");
  const [page, setPage] = useState(1);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recordScrollRef = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams();
  if (view === "history") params.set("date", historyDate);
  if (executionId) params.set("executionId", executionId);
  const logs = useQuery({
    queryKey: ["admin-system-logs", view, historyDate, executionId],
    queryFn: () => api<SystemLogs>(`/v1/admin/system-logs?${params}`),
    enabled: active,
    // Keep the list stable on selection, but never carry records into another date.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === view &&
      previousQuery.queryKey[2] === historyDate
        ? previous
        : undefined,
    refetchInterval: (query) =>
      active &&
      ((autoRefresh && view === "recent") ||
        analysisPending(query.state.data?.modelAnalysis?.status))
        ? 10_000
        : false,
    refetchOnWindowFocus: active && autoRefresh,
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
  const filtered = useMemo(() => {
    const text = search.trim().toLocaleLowerCase();
    const rank = { critical: 0, warning: 1, normal: 2 };
    return (logs.data?.executions ?? [])
      .filter(
        (item) =>
          (source === "all" || item.source === source) &&
          (severity === "all" || item.severity === severity) &&
          (!text ||
            [
              item.title,
              item.subject,
              item.sourceId,
              item.executionId,
              item.summary,
              item.errorCode,
              systemStatusLabel[item.status],
              item.status,
            ]
              .filter(Boolean)
              .join(" ")
              .toLocaleLowerCase()
              .includes(text)),
      )
      .sort(
        (a, b) =>
          (sort === "severity" ? rank[a.severity] - rank[b.severity] : 0) ||
          (sort === "oldest" ? 1 : -1) *
            (Date.parse(a.lastEventAt) - Date.parse(b.lastEventAt)) ||
          a.executionId.localeCompare(b.executionId),
      );
  }, [logs.data?.executions, search, source, severity, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const selected =
    visible.find((item) => item.executionId === executionId) ?? visible[0];
  const detailReady =
    !!selected && logs.data?.selectedExecutionId === selected.executionId;
  const timezone = logs.data?.window.timezone ?? "Asia/Shanghai";
  const today = dateKeyInTimezone(timezone);
  const events = detailReady ? (logs.data?.events ?? []) : [];
  const analysis = detailReady ? logs.data?.modelAnalysis : null;
  const visibleEvents = events.filter(
    (item) => !problemsOnly || item.level !== "info",
  );
  const problems = events.filter((item) => item.level !== "info").length;

  useEffect(() => {
    if (
      !logs.isPlaceholderData &&
      selected &&
      executionId !== selected.executionId
    )
      setExecutionId(selected.executionId);
  }, [executionId, selected?.executionId, logs.isPlaceholderData]);
  useEffect(() => {
    setProblemsOnly(false);
    requestAnalysis.reset();
    detailRef.current?.scrollTo(0, 0);
  }, [selected?.executionId]);
  useEffect(() => {
    recordScrollRef.current?.scrollTo(0, 0);
  }, [currentPage, search, source, severity, sort, view, historyDate]);
  useEffect(() => {
    if (mobileDetail) detailRef.current?.focus();
  }, [mobileDetail]);

  const resetSelection = () => {
    setPage(1);
    setExecutionId(null);
    setMobileDetail(false);
  };
  const clearFilters = () => {
    setSearch("");
    setSource("all");
    setSeverity("all");
    setSort("latest");
    resetSelection();
  };
  const selectDate = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) return;
    setHistoryDate(date);
    resetSelection();
  };

  return (
    <section className="sm-logs" aria-label="中台运行日志">
      <div className="sm-window-toolbar">
        <div className="sm-segment" aria-label="日志时间范围">
          <button
            aria-pressed={view === "recent"}
            onClick={() => {
              setView("recent");
              resetSelection();
            }}
          >
            <Clock3 size={15} />
            最近 24 小时
          </button>
          <button
            aria-pressed={view === "history"}
            onClick={() => {
              setView("history");
              resetSelection();
            }}
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
              onClick={() => selectDate(shiftDateKey(historyDate, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <input
              type="date"
              aria-label="中台历史日志日期"
              value={historyDate}
              max={today}
              onChange={(event) => selectDate(event.target.value)}
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
        <span className="sm-timezone">{timezone}</span>
        <button
          className="icon-button"
          title="刷新中台日志"
          disabled={logs.isFetching}
          onClick={() => void logs.refetch()}
        >
          <RefreshCw size={16} className={logs.isFetching ? "spin" : ""} />
        </button>
      </div>
      <div className="sm-filters">
        <label className="sm-search">
          <Search size={16} />
          <input
            aria-label="搜索运行记录"
            placeholder="搜索任务、成员、记录编号或错误代码"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetSelection();
            }}
          />
          {search && (
            <button
              className="icon-button"
              title="清除搜索"
              onClick={() => {
                setSearch("");
                resetSelection();
              }}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <label className="sm-select">
          <span>来源</span>
          <select
            aria-label="日志来源"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              resetSelection();
            }}
          >
            <option value="all">全部来源</option>
            {Object.entries(systemSourceLabel).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="sm-select">
          <span>状态</span>
          <select
            aria-label="日志状态"
            value={severity}
            onChange={(event) => {
              setSeverity(event.target.value);
              resetSelection();
            }}
          >
            <option value="all">全部状态</option>
            <option value="critical">异常</option>
            <option value="warning">需关注</option>
            <option value="normal">正常</option>
          </select>
        </label>
        <label className="sm-select">
          <span>排序</span>
          <select
            aria-label="日志排序"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              resetSelection();
            }}
          >
            <option value="latest">最近更新</option>
            <option value="oldest">最早更新</option>
            <option value="severity">异常优先</option>
          </select>
        </label>
      </div>
      <ErrorBanner error={logs.error} />
      <div
        className={`sm-log-workspace ${mobileDetail ? "sm-show-detail" : ""}`}
      >
        <div
          className="sm-records"
          ref={listRef}
          tabIndex={-1}
          aria-label="运行记录列表"
        >
          <div className="sm-section-heading">
            <h2>
              运行记录 <span>{filtered.length}</span>
            </h2>
            {(search || source !== "all" || severity !== "all") && (
              <button className="sm-text-button" onClick={clearFilters}>
                <X size={13} />
                重置筛选
              </button>
            )}
          </div>
          <div className="sm-record-scroll" ref={recordScrollRef}>
            <table className="sm-record-table">
              <thead>
                <tr>
                  <th scope="col">任务 / 对象</th>
                  <th scope="col">状态</th>
                  <th scope="col">最近更新</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((execution) => (
                  <tr
                    key={execution.executionId}
                    className={
                      selected?.executionId === execution.executionId
                        ? "is-selected"
                        : ""
                    }
                  >
                    <td>
                      <button
                        className="sm-record-button"
                        aria-pressed={
                          selected?.executionId === execution.executionId
                        }
                        onClick={() => {
                          setExecutionId(execution.executionId);
                          setMobileDetail(true);
                        }}
                      >
                        <span className="sm-record-title">
                          <span className="sm-source-tag">
                            {systemSourceLabel[execution.source]}
                          </span>
                          <strong>{execution.title}</strong>
                        </span>
                        <span className="sm-record-subject">
                          {execution.subject}
                        </span>
                        <span className="sm-record-summary">
                          {execution.summary}
                        </span>
                      </button>
                    </td>
                    <td>
                      <Badge tone={severityTone[execution.severity]}>
                        {systemStatusLabel[execution.status] ??
                          execution.status}
                      </Badge>
                    </td>
                    <td>
                      <time dateTime={execution.lastEventAt}>
                        {formatTime(execution.lastEventAt, timezone)}
                      </time>
                      <small>{execution.eventCount} 个事件</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {logs.isLoading ? (
              <div className="plugin-log-loading" role="status">
                <LoaderCircle size={18} className="spin" />
                加载中台日志
              </div>
            ) : (
              !visible.length && (
                <EmptyState
                  title={
                    logs.isError
                      ? "日志暂时无法加载"
                      : logs.data?.executions.length
                        ? "没有符合条件的运行记录"
                        : view === "recent"
                          ? "最近 24 小时没有中台日志"
                          : "这一天没有中台日志"
                  }
                  action={
                    logs.isError ? (
                      <button
                        className="sm-text-button"
                        onClick={() => void logs.refetch()}
                      >
                        <RefreshCw size={14} />
                        重试
                      </button>
                    ) : search || source !== "all" || severity !== "all" ? (
                      <button className="sm-text-button" onClick={clearFilters}>
                        重置筛选
                      </button>
                    ) : undefined
                  }
                />
              )
            )}
          </div>
          <footer className="sm-pagination">
            <span>
              已加载 {logs.data?.executions.length ?? 0} 条 · 每类上限 500 条
            </span>
            <div>
              <button
                className="icon-button"
                title="上一页"
                disabled={currentPage <= 1}
                onClick={() => {
                  setPage(currentPage - 1);
                  setExecutionId(null);
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <span aria-live="polite">
                {currentPage} / {pageCount}
              </span>
              <button
                className="icon-button"
                title="下一页"
                disabled={currentPage >= pageCount}
                onClick={() => {
                  setPage(currentPage + 1);
                  setExecutionId(null);
                }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </footer>
        </div>
        <section
          className="sm-detail"
          aria-label="运行详情"
          ref={detailRef}
          tabIndex={-1}
        >
          <button
            className="sm-text-button sm-back"
            onClick={() => {
              setMobileDetail(false);
              listRef.current?.focus();
            }}
          >
            <ArrowLeft size={15} />
            返回运行记录
          </button>
          {selected ? (
            <>
              <header className="sm-detail-header">
                <div>
                  <span className="sm-kicker">
                    {systemSourceLabel[selected.source]} · 运行详情
                  </span>
                  <h2>{selected.title}</h2>
                </div>
                <Badge tone={severityTone[selected.severity]}>
                  {systemStatusLabel[selected.status] ?? selected.status}
                </Badge>
              </header>
              <div
                className={`execution-diagnosis execution-diagnosis-${selected.severity}`}
              >
                <span className="execution-diagnosis-icon">
                  {selected.severity === "normal" ? (
                    <CheckCircle2 size={18} />
                  ) : (
                    <AlertTriangle size={18} />
                  )}
                </span>
                <div>
                  <span className="execution-conclusion-label">运行结论</span>
                  <strong>{selected.summary}</strong>
                  <p>{selected.subject}</p>
                  {selected.errorCode && <code>{selected.errorCode}</code>}
                </div>
              </div>
              <dl className="sm-meta">
                <div>
                  <dt>开始时间</dt>
                  <dd>{formatTime(selected.startedAt, timezone)}</dd>
                </div>
                <div>
                  <dt>运行耗时</dt>
                  <dd>{formatDuration(selected.durationMs)}</dd>
                </div>
                <div>
                  <dt>最近更新</dt>
                  <dd>{formatTime(selected.lastEventAt, timezone)}</dd>
                </div>
                <div>
                  <dt>事件数量</dt>
                  <dd>{selected.eventCount}</dd>
                </div>
                <div className="sm-meta-id">
                  <dt>记录编号</dt>
                  <dd>
                    <code>{selected.sourceId}</code>
                  </dd>
                </div>
              </dl>
              {!detailReady ? (
                <div className="plugin-log-loading" role="status">
                  {logs.isError ? (
                    "详情加载失败，请刷新重试"
                  ) : (
                    <>
                      <LoaderCircle size={18} className="spin" />
                      加载运行详情
                    </>
                  )}
                </div>
              ) : (
                <>
                  {(selected.severity !== "normal" || analysis) && (
                    <section className="sm-analysis" aria-label="模型分析">
                      <div className="sm-section-heading">
                        <h3>
                          <Sparkles size={16} />
                          模型分析
                        </h3>
                        {selected.severity !== "normal" && (
                          <button
                            className="plugin-analysis-button"
                            onClick={() =>
                              requestAnalysis.mutate(selected.executionId)
                            }
                            disabled={
                              requestAnalysis.isPending ||
                              analysisPending(analysis?.status)
                            }
                          >
                            {requestAnalysis.isPending ||
                            analysisPending(analysis?.status) ? (
                              <LoaderCircle size={14} className="spin" />
                            ) : (
                              <Sparkles size={14} />
                            )}
                            {analysisPending(analysis?.status)
                              ? "分析中"
                              : analysis?.status === "COMPLETED"
                                ? "重新分析"
                                : "开始分析"}
                          </button>
                        )}
                      </div>
                      <ErrorBanner error={requestAnalysis.error} />
                      {analysis?.status === "COMPLETED" &&
                      analysis.output_payload ? (
                        <div className="sm-analysis-body">
                          <strong>{analysis.output_payload.summary}</strong>
                          <dl>
                            <div>
                              <dt>失败步骤</dt>
                              <dd>{analysis.output_payload.failedStep}</dd>
                            </div>
                            <div>
                              <dt>可能原因</dt>
                              <dd>{analysis.output_payload.rootCause}</dd>
                            </div>
                          </dl>
                          <details>
                            <summary>
                              分析证据 ·{" "}
                              {analysis.output_payload.evidence.length}
                            </summary>
                            <ul>
                              {analysis.output_payload.evidence.map(
                                (item, index) => (
                                  <li key={index}>{item}</li>
                                ),
                              )}
                            </ul>
                          </details>
                          <h4>建议处理</h4>
                          <ol>
                            {analysis.output_payload.recommendedActions.map(
                              (item, index) => (
                                <li key={index}>{item}</li>
                              ),
                            )}
                          </ol>
                          <small>
                            可信度：
                            {
                              { high: "高", medium: "中", low: "低" }[
                                analysis.output_payload.confidence
                              ]
                            }
                          </small>
                        </div>
                      ) : analysis?.status === "FAILED" ? (
                        <p className="sm-analysis-body" role="alert">
                          {analysis.error_message ??
                            analysis.error_code ??
                            "模型分析失败，请重试。"}
                        </p>
                      ) : (
                        analysis && (
                          <p className="sm-analysis-body" role="status">
                            {analysis.status === "RETRY_WAIT"
                              ? "分析任务等待重试"
                              : "分析任务处理中"}
                          </p>
                        )
                      )}
                    </section>
                  )}
                  <div className="sm-section-heading sm-timeline-heading">
                    <h3>
                      <TerminalSquare size={16} />
                      执行时间线 <span>{visibleEvents.length}</span>
                    </h3>
                    <label className="sm-check">
                      <input
                        type="checkbox"
                        checked={problemsOnly}
                        onChange={(event) =>
                          setProblemsOnly(event.target.checked)
                        }
                      />
                      仅看问题 ({problems})
                    </label>
                  </div>
                  <div className="sm-events">
                    {visibleEvents.length ? (
                      visibleEvents.map((event) => (
                        <details
                          className={`sm-event sm-event-${event.level}`}
                          key={`${selected.executionId}:${event.id}`}
                          open={event.level === "error"}
                        >
                          <summary>
                            <span className="sm-event-icon">
                              {event.level === "info" ? (
                                <CheckCircle2 size={16} />
                              ) : (
                                <AlertTriangle size={16} />
                              )}
                            </span>
                            <span className="sm-event-title">
                              <strong>{event.title}</strong>
                              <small>
                                {event.stage} · {event.eventCode}
                              </small>
                            </span>
                            <span className="sm-event-time">
                              <Badge
                                tone={
                                  event.level === "error"
                                    ? "danger"
                                    : event.level === "warning"
                                      ? "warning"
                                      : "neutral"
                                }
                              >
                                {
                                  {
                                    info: "信息",
                                    warning: "警告",
                                    error: "错误",
                                  }[event.level]
                                }
                              </Badge>
                              <time dateTime={event.occurredAt}>
                                {formatTime(event.occurredAt, timezone)}
                              </time>
                            </span>
                            <ChevronRight size={14} />
                          </summary>
                          <div className="sm-event-body">
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
              )}
            </>
          ) : (
            <EmptyState
              title={logs.isLoading ? "等待运行记录" : "暂无可审查的运行详情"}
            />
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
        <small>{component.detail}</small>
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

type MonitorTab = "logs" | "incidents" | "components";

function IncidentReview({ incidents }: { incidents: Incident[] }) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const filtered = incidents
    .filter(
      (item) =>
        (source === "all" || item.source === source) &&
        (severity === "all" || item.severity === severity) &&
        [
          item.title,
          item.partnerName,
          item.sourceId,
          item.errorCode,
          item.message,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.severity === "critical") - Number(a.severity === "critical") ||
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
    );
  return (
    <section className="sm-incidents" aria-label="当前异常">
      <div className="sm-filters">
        <label className="sm-search">
          <Search size={16} />
          <input
            aria-label="搜索异常"
            placeholder="搜索异常、成员、记录编号或错误代码"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button
              className="icon-button"
              title="清除异常搜索"
              onClick={() => setSearch("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <label className="sm-select">
          <span>来源</span>
          <select
            aria-label="异常来源"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="all">全部来源</option>
            {Object.entries(sourceLabel).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="sm-select">
          <span>级别</span>
          <select
            aria-label="异常级别"
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
          >
            <option value="all">全部级别</option>
            <option value="critical">异常</option>
            <option value="warning">需关注</option>
          </select>
        </label>
      </div>
      <div className="sm-section-heading">
        <h2>
          待处理异常 <span>{filtered.length}</span>
        </h2>
        <span>异常优先 · 最近发生</span>
      </div>
      <div className="sm-incident-list">
        {filtered.map((incident) => (
          <article
            key={incident.id}
            className={`sm-incident sm-incident-${incident.severity}`}
          >
            <button
              className="sm-incident-toggle"
              aria-expanded={expandedId === incident.id}
              aria-controls={`incident-${incident.id}`}
              onClick={() =>
                setExpandedId(expandedId === incident.id ? null : incident.id)
              }
            >
              <AlertTriangle size={17} />
              <span className="sm-incident-title">
                <strong>{incident.title}</strong>
                <small>
                  {sourceLabel[incident.source]} ·{" "}
                  {incident.partnerName ?? "团队级任务"}
                </small>
              </span>
              <Badge tone={severityTone[incident.severity]}>
                {severityLabel[incident.severity]}
              </Badge>
              <time dateTime={incident.occurredAt}>
                {formatTime(incident.occurredAt)}
              </time>
              <ChevronRight size={16} />
            </button>
            {expandedId === incident.id && (
              <div className="sm-incident-body" id={`incident-${incident.id}`}>
                <p>{incident.message}</p>
                <dl>
                  <div>
                    <dt>建议处理</dt>
                    <dd>{incident.action}</dd>
                  </div>
                  <div>
                    <dt>错误代码</dt>
                    <dd>
                      <code>{incident.errorCode ?? "无"}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>记录编号</dt>
                    <dd>
                      <code>{incident.sourceId}</code>
                    </dd>
                  </div>
                </dl>
                {incident.href && (
                  <Link className="sm-text-button" href={incident.href}>
                    查看异常任务
                    <ArrowUpRight size={15} />
                  </Link>
                )}
              </div>
            )}
          </article>
        ))}
        {!filtered.length && (
          <EmptyState
            title={
              incidents.length ? "没有符合条件的异常" : "当前没有待处理异常"
            }
            action={
              incidents.length ? (
                <button
                  className="sm-text-button"
                  onClick={() => {
                    setSearch("");
                    setSource("all");
                    setSeverity("all");
                  }}
                >
                  重置筛选
                </button>
              ) : undefined
            }
          />
        )}
      </div>
    </section>
  );
}

export function SystemMonitoringPage() {
  const [tab, setTab] = useState<MonitorTab>("logs");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-system-monitoring"],
    queryFn: () => api<SystemMonitoring>("/v1/admin/system-monitoring"),
    refetchInterval: autoRefresh ? 10_000 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const data = query.data;
  const tabs = [
    { key: "logs" as const, label: "运行日志", icon: TerminalSquare },
    { key: "incidents" as const, label: "异常审查", icon: ListFilter },
    { key: "components" as const, label: "模块健康", icon: ServerCog },
  ];
  const refresh = () => {
    void query.refetch();
    void queryClient.invalidateQueries({ queryKey: ["admin-system-logs"] });
  };

  return (
    <div className="page admin-page system-monitoring-page">
      <header className="sm-page-header">
        <div>
          <span className="sm-breadcrumb">管理台 / 系统运维</span>
          <h1>
            <Activity size={25} />
            系统监控
          </h1>
        </div>
        <div className="sm-header-actions">
          <div className="sm-refresh-time">
            <span className={`sm-live-dot ${autoRefresh ? "" : "is-paused"}`} />
            <span>
              {query.isError
                ? "状态更新失败"
                : data
                  ? `更新于 ${formatTime(data.checkedAt)}`
                  : "等待系统状态"}
            </span>
          </div>
          <label className="sm-check">
            <input
              type="checkbox"
              role="switch"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            自动刷新
          </label>
          <button
            className="icon-button"
            title="刷新系统状态"
            disabled={query.isFetching}
            onClick={refresh}
          >
            <RefreshCw size={17} className={query.isFetching ? "spin" : ""} />
          </button>
        </div>
      </header>
      <ErrorBanner error={query.error} />
      <section
        className="sm-overview"
        aria-label="系统状态汇总"
        aria-busy={query.isLoading}
      >
        <div
          className={`sm-overall sm-tone-${data?.overallSeverity ?? "unknown"}`}
        >
          <span className="sm-kicker">整体状态</span>
          <strong>
            {data?.overallSeverity === "normal" ? (
              <CheckCircle2 size={19} />
            ) : data?.overallSeverity === "unknown" || !data ? (
              <Activity size={19} />
            ) : (
              <AlertTriangle size={19} />
            )}
            {query.isLoading
              ? "检查中"
              : !data
                ? "暂不可用"
                : {
                    normal: "运行正常",
                    warning: "需要关注",
                    critical: "存在异常",
                    unknown: "状态未知",
                  }[data.overallSeverity]}
          </strong>
          <small>
            {data
              ? `共 ${data.summary.componentCount} 个监控模块`
              : "等待状态数据"}
          </small>
        </div>
        <div className="sm-stat sm-tone-normal">
          <span>正常模块</span>
          <strong>{data?.summary.normal ?? "—"}</strong>
        </div>
        <div className="sm-stat sm-tone-warning">
          <span>需关注模块</span>
          <strong>{data?.summary.warning ?? "—"}</strong>
        </div>
        <div className="sm-stat sm-tone-critical">
          <span>异常模块</span>
          <strong>{data?.summary.critical ?? "—"}</strong>
        </div>
        <div className="sm-stat sm-tone-critical">
          <span>待处理异常</span>
          <strong>{data?.summary.openIncidents ?? "—"}</strong>
        </div>
      </section>
      <div className="sm-navigation">
        <div role="tablist" aria-label="系统监控视图" className="sm-tabs">
          {tabs.map(({ key, label, icon: Icon }, index) => (
            <button
              key={key}
              id={`sm-tab-${key}`}
              role="tab"
              aria-selected={tab === key}
              aria-controls={`sm-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(event) => {
                let next = index;
                if (event.key === "ArrowRight")
                  next = (index + 1) % tabs.length;
                else if (event.key === "ArrowLeft")
                  next = (index + tabs.length - 1) % tabs.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = tabs.length - 1;
                else return;
                event.preventDefault();
                const target = tabs[next]!;
                setTab(target.key);
                document.getElementById(`sm-tab-${target.key}`)?.focus();
              }}
            >
              <Icon size={17} />
              {label}
              {key === "incidents" && (
                <span
                  className={
                    data?.summary.openIncidents
                      ? "sm-tab-count has-incidents"
                      : "sm-tab-count"
                  }
                >
                  {data?.summary.openIncidents ?? "—"}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="sm-refresh-label">
          {autoRefresh ? "每 10 秒更新" : "自动刷新已暂停"}
        </span>
      </div>
      <div
        id="sm-panel-logs"
        role="tabpanel"
        aria-labelledby="sm-tab-logs"
        hidden={tab !== "logs"}
      >
        <SystemLogBrowser active={tab === "logs"} autoRefresh={autoRefresh} />
      </div>
      <div
        id="sm-panel-incidents"
        role="tabpanel"
        aria-labelledby="sm-tab-incidents"
        hidden={tab !== "incidents"}
      >
        {data ? (
          <IncidentReview incidents={data.incidents} />
        ) : (
          <EmptyState
            title={query.isLoading ? "加载异常记录" : "异常记录暂不可用"}
          />
        )}
      </div>
      <div
        id="sm-panel-components"
        role="tabpanel"
        aria-labelledby="sm-tab-components"
        hidden={tab !== "components"}
      >
        <section className="sm-components" aria-label="系统模块状态">
          <div className="sm-section-heading">
            <h2>
              系统模块 <span>{data?.components.length ?? 0}</span>
            </h2>
            <span>最近状态 · 独立测试</span>
          </div>
          {data ? (
            data.components.map((component) => (
              <SystemComponentRow key={component.key} component={component} />
            ))
          ) : (
            <EmptyState
              title={query.isLoading ? "加载模块状态" : "模块状态暂不可用"}
            />
          )}
        </section>
      </div>
    </div>
  );
}
