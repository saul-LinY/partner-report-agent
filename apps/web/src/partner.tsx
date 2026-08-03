import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Blocks,
  CalendarClock,
  ClipboardCheck,
  Clock3,
  FileText,
  RefreshCw,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner } from "./components.js";
import type { Me } from "./App.js";

type Dashboard = {
  period: any;
  plugin: any;
  jobs: any[];
  review: any;
  report: any;
  coverage: any;
  collection: {
    factCount: number;
    cutoffAt: string;
    state: "COLLECTING" | "CLOSED";
  } | null;
};

const jobLabels: Record<string, string> = {
  AGGREGATE_WORK_ITEMS: "聚合 Work Item",
  GENERATE_INDIVIDUAL_REPORT: "生成个人 Report",
  REGENERATE_INDIVIDUAL_REPORT: "重新生成 Report",
  REANALYZE_SESSIONS: "重新分析 Session",
  RESCAN_SESSIONS: "重新扫描 Session",
};

const reviewLabels: Record<string, string> = {
  PENDING: "正在聚合",
  IN_PROGRESS: "待一审",
  ITEMS_APPROVED: "一审通过",
};

const reportLabels: Record<string, string> = {
  REPORT_DRAFT: "正在生成",
  REPORT_REVIEW: "待二审",
  RETURNED_TO_ITEMS: "退回项目卡片",
  SUBMITTED: "二审完成",
  LOCKED: "二审完成",
};

export function PartnerDashboard({ me }: { me: Me }) {
  const query = useQuery({
    queryKey: ["partner-dashboard"],
    queryFn: () => api<Dashboard>("/v1/partner/dashboard"),
    refetchInterval: 10_000,
  });
  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载周期状态
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );
  const data = query.data!;
  const coverage = data.coverage;
  const cutoffLabel = data.collection?.cutoffAt
    ? new Date(data.collection.cutoffAt).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "--";
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PARTNER WORKSPACE</span>
          <h1>{me.partnerName ?? me.displayName}</h1>
          <p>{data.period?.period_key ?? "尚未创建周期"}</p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} />}
          onClick={() => query.refetch()}
        >
          刷新
        </Button>
      </header>
      <section className="status-strip">
        <div>
          <span>Plugin</span>
          <strong>
            {data.plugin?.status === "active" ? "已连接" : "未连接"}
          </strong>
          <Badge
            tone={data.plugin?.status === "active" ? "success" : "warning"}
          >
            {data.plugin?.version ?? "--"}
          </Badge>
        </div>
        <div>
          <span>本周收集</span>
          <strong>{data.collection?.factCount ?? 0} 条进展</strong>
          <span>{cutoffLabel} 截止</span>
        </div>
        <div>
          <span>项目卡片</span>
          <strong>{reviewLabels[data.review?.state] ?? "等待周截止"}</strong>
          <span>{data.review?.period_key ?? "本周结束后生成"}</span>
        </div>
        <div>
          <span>周报</span>
          <strong>{reportLabels[data.report?.status] ?? "尚未生成"}</strong>
          <span>{data.report?.period_key ?? "一审通过后生成"}</span>
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="section-block coverage-block">
          <div className="section-heading">
            <div>
              <h2>Session Coverage</h2>
              <p>当前周期的数据边界</p>
            </div>
            <Activity size={19} />
          </div>
          {coverage ? (
            <div className="metric-grid">
              <Metric label="发现" value={coverage.discovered} />
              <Metric label="可读取" value={coverage.readable} />
              <Metric label="已提取" value={coverage.extracted} tone="good" />
              <Metric
                label="失败"
                value={
                  (coverage.failedRead ?? 0) + (coverage.failedExtract ?? 0)
                }
                tone="bad"
              />
              <Metric label="排除" value={coverage.excluded} />
              <Metric label="待同步" value={coverage.pendingSync} />
            </div>
          ) : (
            <EmptyState
              title="等待首次 Session 同步"
              action={
                <Link href="/connect-plugin">
                  <Button variant="secondary" icon={<Blocks size={16} />}>
                    连接 Plugin
                  </Button>
                </Link>
              }
            />
          )}
        </section>
        <section className="section-block action-block">
          <div className="section-heading">
            <div>
              <h2>当前状态</h2>
              <p>本周收集与两轮审核</p>
            </div>
            <Clock3 size={19} />
          </div>
          {!data.plugin && (
            <ActionRow
              icon={<Blocks />}
              title="连接 Plugin"
              meta="建立本地 Session 读取边界"
              to="/connect-plugin"
            />
          )}
          {data.plugin && data.collection?.state === "COLLECTING" && (
            <ActionRow
              icon={<CalendarClock />}
              title="一周内持续收集进展"
              meta={`${cutoffLabel} 后统一按项目聚合`}
            />
          )}
          {data.review?.state === "PENDING" && (
            <ActionRow
              icon={<RefreshCw className="spin" />}
              title="正在生成项目卡片"
              meta="Runner 正在处理本周聚合任务"
            />
          )}
          {data.review?.state === "IN_PROGRESS" && (
            <ActionRow
              icon={<ClipboardCheck />}
              title="审核项目卡片"
              meta="一审通过后才会生成周报"
              to="/partner/review"
            />
          )}
          {data.review?.state === "ITEMS_APPROVED" && (
            <ActionRow
              icon={<ClipboardCheck />}
              title="项目卡片一审已通过"
              meta={data.review.period_key}
            />
          )}
          {data.report?.status === "REPORT_DRAFT" && (
            <ActionRow
              icon={<RefreshCw className="spin" />}
              title="正在生成周报"
              meta="Runner 使用已审核的项目卡片生成"
            />
          )}
          {data.report?.status === "REPORT_REVIEW" && (
            <ActionRow
              icon={<FileText />}
              title="二次审核周报"
              meta="确认后锁定本周报告"
              to="/partner/report"
            />
          )}
          {["LOCKED", "SUBMITTED"].includes(data.report?.status) && (
            <ActionRow
              icon={<FileText />}
              title="本周周报已确认"
              meta={data.report.period_key}
              to="/partner/report"
            />
          )}
        </section>
      </div>

      <section className="section-block jobs-block">
        <div className="section-heading">
          <div>
            <h2>Agent Jobs</h2>
            <p>最近的本地 AI 任务</p>
          </div>
        </div>
        {data.jobs.length === 0 ? (
          <EmptyState title="暂无任务" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{jobLabels[job.type] ?? job.type}</td>
                    <td>
                      <Badge
                        tone={
                          job.status === "COMPLETED"
                            ? "success"
                            : job.status === "FAILED"
                              ? "danger"
                              : "info"
                        }
                      >
                        {job.status}
                      </Badge>
                    </td>
                    <td>{job.attempt_count}</td>
                    <td>{new Date(job.updated_at).toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className={`metric metric-${tone ?? "default"}`}>
      <span>{label}</span>
      <strong>{value ?? 0}</strong>
    </div>
  );
}

function ActionRow({
  icon,
  title,
  meta,
  to,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  to?: string;
}) {
  const content = (
    <>
      <span className="action-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <span>{meta}</span>
      </div>
      {to && <ArrowRight size={18} />}
    </>
  );
  return to ? (
    <Link className="action-row" href={to}>
      {content}
    </Link>
  ) : (
    <div className="action-row">{content}</div>
  );
}
