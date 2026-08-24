import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  FileCheck2,
  MessageSquare,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
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

          <div className="system-monitor-workspace">
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
                  <div
                    className={`system-component-row system-component-${component.severity}`}
                    key={component.key}
                  >
                    <span className="system-component-icon">
                      <ComponentIcon componentKey={component.key} />
                    </span>
                    <div>
                      <strong>{component.label}</strong>
                      <span>{component.summary}</span>
                      <p>{component.detail}</p>
                    </div>
                    <Badge tone={severityTone[component.severity]}>
                      {severityLabel[component.severity]}
                    </Badge>
                  </div>
                ))}
              </div>
            </section>

            <section className="system-incident-panel" aria-label="当前异常">
              <div className="system-monitor-section-title">
                <AlertTriangle size={17} />
                <strong>当前异常</strong>
                <span>{data.incidents.length}</span>
              </div>
              <div className="system-incident-list">
                {data.incidents.length ? (
                  data.incidents.map((incident) => (
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
                  ))
                ) : (
                  <EmptyState title="当前没有系统异常" />
                )}
              </div>
              <div className="system-monitor-footnote">
                <Clock3 size={14} />
                状态每 10 秒自动更新
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
