import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  FileCheck2,
  HardDriveDownload,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Search,
  ServerCog,
  Sparkles,
  TerminalSquare,
  TestTube2,
  X,
} from "lucide-react";
import { Link, useSearchParams } from "wouter";
import { api, ApiClientError } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";
import { AdminTabs, WorkspaceHeader } from "./admin-workspace.js";
import {
  DetailList,
  LogWindowToolbar,
  dateKeyInTimezone,
  detailEntries,
  errorCodeLabel,
  formatDuration,
  formatTime,
  jobStatusLabel,
  jobTypeMeta,
  levelLabel,
  levelTone,
  severityLabel,
  severityTone,
  type Severity,
} from "./monitoring-common.js";
import "./monitoring.css";

type SystemComponent = {
  key: "api" | "queue" | "generation" | "notifications" | "reports";
  label: string;
  severity: Severity;
  summary: string;
  detail: string;
  count: number;
};

type WorkerStatus = {
  heartbeatAt: string;
  lastTickAt: string | null;
  status: string;
  errorCode: string | null;
  capabilities: Record<string, unknown>;
} | null;

type Incident = {
  id: string;
  sourceId: string;
  source: string;
  severity: "warning" | "critical";
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
  worker: WorkerStatus;
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

type SystemLogSource = "notification" | "job" | "outbox" | "report";
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
type SystemLogJob = {
  type: string;
  partnerId: string | null;
  partnerName: string | null;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  durationMs: number;
  leaseUntil: string | null;
  nextRetryAt: string | null;
  idempotencyKey: string;
  uploadId: string | null;
  periodKey: string | null;
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
  job: SystemLogJob | null;
};
type SystemLogs = {
  window: {
    mode: "recent" | "day";
    date: string | null;
    timezone: string;
    startedAt: string;
    endedAt: string;
  };
  worker: WorkerStatus;
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

const systemSourceLabel: Record<SystemLogSource, string> = {
  notification: "App 通知",
  job: "后台任务",
  outbox: "事件",
  report: "报告",
};

const systemStatusLabel: Record<string, string> = {
  ...jobStatusLabel,
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

const capabilityLabel: Record<string, string> = {
  modelConfigured: "中台模型",
  version: "Worker 版本",
};

const PAGE_SIZE = 12;
const analysisPending = (status: string | undefined) =>
  ["PENDING", "LEASED", "RETRY_WAIT"].includes(status ?? "");

function ComponentIcon({
  componentKey,
}: {
  componentKey: SystemComponent["key"];
}) {
  if (componentKey === "api") return <Database size={18} />;
  if (componentKey === "queue") return <ServerCog size={18} />;
  if (componentKey === "generation") return <Bot size={18} />;
  if (componentKey === "notifications") return <MessageSquare size={18} />;
  return <FileCheck2 size={18} />;
}

function workerOnline(worker: WorkerStatus) {
  return (
    !!worker &&
    worker.status !== "stopped" &&
    Date.now() - Date.parse(worker.heartbeatAt) < 90_000
  );
}

function SystemLogBrowser({
  active,
  autoRefresh,
}: {
  active: boolean;
  autoRefresh: boolean;
}) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const requestedExecution = params.get("executionId");
  const [view, setView] = useState<"recent" | "history">("recent");
  const [historyDate, setHistoryDate] = useState(() =>
    dateKeyInTimezone("Asia/Shanghai"),
  );
  const [executionId, setExecutionId] = useState<string | null>(
    requestedExecution,
  );
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [sort, setSort] = useState("latest");
  const [page, setPage] = useState(1);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(
    requestedExecution !== null,
  );
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recordScrollRef = useRef<HTMLDivElement>(null);
  const queryParams = new URLSearchParams();
  if (view === "history") queryParams.set("date", historyDate);
  if (executionId) queryParams.set("executionId", executionId);
  const logs = useQuery({
    queryKey: ["admin-system-logs", view, historyDate, executionId],
    queryFn: () => api<SystemLogs>(`/v1/admin/system-logs?${queryParams}`),
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
  // A deep link may point outside the visible page; follow the loaded record.
  const selected =
    filtered.find((item) => item.executionId === executionId) ?? visible[0];
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
  const job = selected?.job ?? null;

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
    if (params.has("executionId")) setParams({}, { replace: true });
  };
  const clearFilters = () => {
    setSearch("");
    setSource("all");
    setSeverity("all");
    setSort("latest");
    resetSelection();
  };

  return (
    <section className="sm-logs" aria-label="中台运行日志">
      <div className="sm-log-query">
        <LogWindowToolbar
          view={view}
          onView={(next) => {
            setView(next);
            resetSelection();
          }}
          date={historyDate}
          onDate={(date) => {
            setHistoryDate(date);
            resetSelection();
          }}
          today={today}
          timezone={timezone}
          fetching={logs.isFetching}
          onRefresh={() => void logs.refetch()}
          dateLabel="中台历史日志日期"
          refreshTitle="刷新中台日志"
        />
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
              <div className="sm-loading" role="status">
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
              {job && (
                <section className="sm-job" aria-label="任务信息">
                  <div className="sm-section-heading">
                    <h3>
                      <ServerCog size={16} />
                      任务信息
                    </h3>
                  </div>
                  <DetailList
                    entries={[
                      ["任务类型", jobTypeMeta[job.type]?.label ?? job.type],
                      ["成员", job.partnerName ?? "团队级任务"],
                      ["尝试次数", `${job.attemptCount} / ${job.maxAttempts}`],
                      [
                        "错误码",
                        job.errorCode
                          ? `${errorCodeLabel[job.errorCode] ?? job.errorCode}（${job.errorCode}）`
                          : "无",
                      ],
                      ["错误信息", job.errorMessage ?? "无"],
                      ["创建时间", formatTime(job.createdAt, timezone)],
                      [
                        "完成时间",
                        formatTime(job.completedAt, timezone, "尚未完成"),
                      ],
                      ["任务耗时", formatDuration(job.durationMs)],
                      [
                        "租约到期",
                        formatTime(job.leaseUntil, timezone, "无租约"),
                      ],
                      [
                        "下次重试",
                        formatTime(job.nextRetryAt, timezone, "无计划"),
                      ],
                      ["幂等键", <code key="key">{job.idempotencyKey}</code>],
                      ["关联上传", job.uploadId ?? "无"],
                      ["关联周期", job.periodKey ?? "无"],
                    ]}
                  />
                  {selected.status === "FAILED" ||
                  selected.status === "RETRY_WAIT" ? (
                    <p className="sm-job-hint">
                      <Link href="/admin/inspection">
                        前往异常巡检重试或清除该任务
                      </Link>
                    </p>
                  ) : null}
                </section>
              )}
              {!detailReady ? (
                <div className="sm-loading" role="status">
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
                            className="sm-analysis-button"
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
                              <Badge tone={levelTone(event.level)}>
                                {levelLabel[event.level]}
                              </Badge>
                              <time dateTime={event.occurredAt}>
                                {formatTime(event.occurredAt, timezone)}
                              </time>
                            </span>
                            <ChevronRight size={14} />
                          </summary>
                          <div className="sm-event-body">
                            <p>{event.message}</p>
                            <DetailList
                              entries={detailEntries(event.details, timezone)}
                            />
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

function WorkerCard({ worker }: { worker: WorkerStatus }) {
  const online = workerOnline(worker);
  const tone = !worker
    ? "neutral"
    : !online || worker.status === "error"
      ? "danger"
      : worker.capabilities.modelConfigured === false
        ? "warning"
        : "success";
  return (
    <div className={`system-component-row system-component-${tone === "danger" ? "critical" : tone === "warning" ? "warning" : tone === "neutral" ? "unknown" : "normal"}`}>
      <span className="system-component-icon">
        <HardDriveDownload size={18} />
      </span>
      <div className="system-component-copy">
        <strong>任务进程 Worker</strong>
        <span>
          {!worker
            ? "尚未收到心跳"
            : !online
              ? "任务进程离线"
              : worker.status === "error"
                ? "任务进程异常"
                : "任务进程在线"}
        </span>
        <small>
          最近心跳 {formatTime(worker?.heartbeatAt, undefined, "尚未收到")} ·
          最近轮询 {formatTime(worker?.lastTickAt, undefined, "尚未轮询")}
          {worker?.errorCode ? ` · ${worker.errorCode}` : ""}
        </small>
        {worker && (
          <small>
            {Object.entries(worker.capabilities)
              .map(([key, value]) => {
                const text =
                  typeof value === "boolean"
                    ? value
                      ? "已配置"
                      : "未配置"
                    : String(value);
                return `${capabilityLabel[key] ?? key}：${text}`;
              })
              .join(" · ")}
          </small>
        )}
      </div>
      <div className="system-component-actions">
        <Badge tone={tone}>
          {!worker
            ? "无心跳"
            : !online
              ? "离线"
              : worker.capabilities.modelConfigured === false
                ? "模型未配置"
                : "在线"}
        </Badge>
      </div>
    </div>
  );
}

function IncidentList({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) return <EmptyState title="当前没有未处理的事件" />;
  return (
    <ul className="sm-incident-list">
      {incidents.map((incident) => (
        <li
          key={incident.id}
          className={`sm-incident sm-incident-${incident.severity}`}
        >
          <div className="sm-incident-head">
            <Badge tone={incident.severity === "critical" ? "danger" : "warning"}>
              {incident.severity === "critical" ? "异常" : "需关注"}
            </Badge>
            <strong>{incident.title}</strong>
            <time dateTime={incident.occurredAt}>
              {formatTime(incident.occurredAt)}
            </time>
          </div>
          <p>{incident.message}</p>
          <small>
            {incident.partnerName ? `${incident.partnerName} · ` : ""}
            {incident.errorCode ? `${incident.errorCode} · ` : ""}
            {incident.action}
          </small>
          {incident.href && (
            <Link className="sm-incident-link" href={incident.href}>
              <ExternalLink size={13} />
              查看详情
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

type SystemTab = "logs" | "health";

export function SystemLogsPage() {
  const [tab, setTab] = useState<SystemTab>("logs");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-system-monitoring"],
    queryFn: () => api<SystemMonitoring>("/v1/admin/system-monitoring"),
    refetchInterval: autoRefresh ? 10_000 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const data = query.data;
  const refresh = () => {
    void query.refetch();
    void queryClient.invalidateQueries({ queryKey: ["admin-system-logs"] });
  };

  return (
    <div className="page admin-page monitoring-page">
      <WorkspaceHeader
        title="系统日志"
        icon={ServerCog}
        context="查看中台模块健康、Worker 心跳、后台任务运行记录与模型分析"
      >
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
      </WorkspaceHeader>
      <ErrorBanner error={query.error} />
      <section className="aw-view sm-view">
        <AdminTabs
          label="系统日志视图"
          value={tab}
          onChange={setTab}
          items={[
            { value: "logs", label: "运行日志", icon: TerminalSquare },
            {
              value: "health",
              label: "模块健康",
              icon: ServerCog,
              ...(data ? { count: data.summary.openIncidents } : {}),
            },
          ]}
        />
        <div
          id="aw-panel-logs"
          role="tabpanel"
          aria-labelledby="aw-tab-logs"
          hidden={tab !== "logs"}
        >
          <SystemLogBrowser active={tab === "logs"} autoRefresh={autoRefresh} />
        </div>
        <div
          id="aw-panel-health"
          role="tabpanel"
          aria-labelledby="aw-tab-health"
          hidden={tab !== "health"}
        >
          <section className="sm-components" aria-label="系统模块状态">
            <div className="sm-section-heading">
              <h2>
                系统模块 <span>{data?.components.length ?? 0}</span>
              </h2>
              <span>最近状态 · 独立测试</span>
            </div>
            {data ? (
              <div className="sm-component-grid">
                <WorkerCard worker={data.worker} />
                {data.components.map((component) => (
                  <SystemComponentRow
                    key={component.key}
                    component={component}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title={query.isLoading ? "加载模块状态" : "模块状态暂不可用"}
              />
            )}
          </section>
          <section className="sm-incidents" aria-label="系统事件">
            <div className="sm-section-heading">
              <h2>
                未处理事件 <span>{data?.incidents.length ?? 0}</span>
              </h2>
            </div>
            {data && <IncidentList incidents={data.incidents} />}
          </section>
        </div>
      </section>
    </div>
  );
}
