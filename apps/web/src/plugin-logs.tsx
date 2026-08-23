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

type Plugin = {
  id: string;
  partner_id: string;
  partner_name: string;
  device_name: string;
  version: string;
  client_kind: "collector" | "widget";
  status: string;
  runStatus?: string;
  last_sync_at: string | null;
  last_error_code: string | null;
  last_diagnostic_message: string | null;
};

type Overview = { plugins: Plugin[] };

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

export function PluginLogsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState("all");
  const [level, setLevel] = useState("all");
  const overview = useQuery({
    queryKey: ["admin-overview", "plugin-logs"],
    queryFn: () => api<Overview>("/v1/admin/overview"),
    refetchInterval: 15_000,
  });
  const plugins = overview.data?.plugins ?? [];

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

  if (overview.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载插件日志
      </div>
    );

  return (
    <div className="page admin-page plugin-logs-page">
      <header className="page-header">
        <div>
          <h1>插件日志</h1>
          <p>按用户和插件实例查看采集、同步与内容生成状态。</p>
        </div>
        <button
          className="icon-button"
          title="刷新日志"
          onClick={() => {
            void overview.refetch();
            void logs.refetch();
          }}
        >
          <RefreshCw size={17} className={logs.isFetching ? "spin" : ""} />
        </button>
      </header>
      <ErrorBanner error={overview.error ?? logs.error} />

      {plugins.length === 0 ? (
        <EmptyState title="还没有已连接的插件" />
      ) : (
        <div className="plugin-log-workspace">
          <aside className="plugin-log-instances" aria-label="插件实例">
            <div className="plugin-log-panel-title">
              <Server size={16} />
              <strong>用户与插件</strong>
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
                <span className="plugin-instance-state">
                  <CircleDot
                    size={15}
                    className={
                      plugin.status === "active" ? "online" : "offline"
                    }
                  />
                </span>
                <span className="plugin-instance-copy">
                  <strong>{plugin.partner_name}</strong>
                  <span>{plugin.device_name}</span>
                  <small>
                    {plugin.client_kind === "widget"
                      ? "Widget"
                      : `v${plugin.version}`}{" "}
                    · {shortId(plugin.id)}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </aside>

          <section className="plugin-log-detail">
            {selectedPlugin && (
              <div className="plugin-log-summary">
                <div>
                  <span>当前插件</span>
                  <strong>
                    {selectedPlugin.partner_name} · {selectedPlugin.device_name}
                  </strong>
                </div>
                <div>
                  <span>最近同步</span>
                  <strong>{formatTime(selectedPlugin.last_sync_at)}</strong>
                </div>
                <div>
                  <span>运行状态</span>
                  <Badge
                    tone={selectedPlugin.last_error_code ? "danger" : "success"}
                  >
                    {selectedPlugin.last_error_code ?? "正常"}
                  </Badge>
                </div>
              </div>
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
                <span>级别</span>
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
              <strong>插件事件</strong>
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
                <EmptyState title="这个插件在当前筛选条件下没有日志" />
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
