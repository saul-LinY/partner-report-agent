import { useQuery } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  FolderKanban,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner } from "./components.js";

type ProgressItem = {
  id: string;
  title: string;
  status: string;
  fact_ids: string[];
  payload: {
    summary?: string;
    outcomes?: string[];
    blockers?: string[];
    nextSteps?: string[];
  };
  updated_at: string;
};

type ProjectProgress = {
  id: string | null;
  name: string;
  statusCounts: Record<string, number>;
  items: ProgressItem[];
};

type ProgressResponse = {
  period: { period_key: string } | null;
  aggregation: {
    status: string;
    updated_at: string;
    error_code?: string | null;
  } | null;
  summary: {
    projectCount: number;
    itemCount: number;
    completedCount: number;
    blockedCount: number;
  };
  projects: ProjectProgress[];
};

const statusLabels: Record<string, string> = {
  discussion: "讨论中",
  planned: "已规划",
  in_progress: "推进中",
  awaiting_validation: "待验证",
  completed: "已完成",
  blocked: "受阻",
  cancelled: "已取消",
};

function statusTone(status: string) {
  if (status === "completed") return "success";
  if (status === "blocked" || status === "cancelled") return "danger";
  if (status === "in_progress" || status === "awaiting_validation")
    return "info";
  return "neutral";
}

export function ProgressPage() {
  const query = useQuery({
    queryKey: ["partner-progress"],
    queryFn: () => api<ProgressResponse>("/v1/partner/progress"),
    refetchInterval: 10_000,
  });
  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载项目进展
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );
  const data = query.data!;
  const aggregationPending = Boolean(
    data.aggregation &&
    ["PENDING", "LEASED", "RETRY_WAIT"].includes(data.aggregation.status),
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PROJECT PROGRESS</span>
          <h1>项目进展</h1>
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

      <section className="status-strip progress-summary">
        <div>
          <span>项目</span>
          <strong>{data.summary.projectCount}</strong>
          <span>已归类</span>
        </div>
        <div>
          <span>进展事项</span>
          <strong>{data.summary.itemCount}</strong>
          <span>当前周期</span>
        </div>
        <div>
          <span>已完成</span>
          <strong>{data.summary.completedCount}</strong>
          <span>
            {data.summary.itemCount
              ? `${Math.round((data.summary.completedCount / data.summary.itemCount) * 100)}%`
              : "0%"}
          </span>
        </div>
        <div>
          <span>受阻</span>
          <strong>{data.summary.blockedCount}</strong>
          <span>{aggregationPending ? "正在更新" : "聚合已同步"}</span>
        </div>
      </section>

      {aggregationPending && (
        <div className="progress-sync-state">
          <RefreshCw className="spin" size={16} />
          <span>新数据正在按项目聚合，页面会自动更新。</span>
        </div>
      )}
      {data.aggregation?.status === "FAILED" && (
        <div className="progress-sync-state progress-sync-error">
          <ShieldAlert size={16} />
          <span>
            最近一次聚合失败：
            {data.aggregation.error_code ?? "AGGREGATION_FAILED"}
          </span>
        </div>
      )}

      {data.projects.length === 0 ? (
        <EmptyState
          title={
            aggregationPending
              ? "正在整理项目进展"
              : "当前周期还没有可展示的进展"
          }
        />
      ) : (
        <div className="progress-projects">
          {data.projects.map((project) => (
            <ProjectSection
              key={project.id ?? "unassigned"}
              project={project}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectSection({ project }: { project: ProjectProgress }) {
  return (
    <section className="progress-project">
      <header>
        <div className="progress-project-title">
          <FolderKanban size={19} />
          <div>
            <h2>{project.name}</h2>
            <span>{project.items.length} 项进展</span>
          </div>
        </div>
        <div className="progress-project-counts">
          {(project.statusCounts.completed ?? 0) > 0 && (
            <span>
              <CheckCircle2 size={14} />
              {project.statusCounts.completed} 完成
            </span>
          )}
          {(project.statusCounts.in_progress ?? 0) > 0 && (
            <span>
              <CircleDashed size={14} />
              {project.statusCounts.in_progress} 推进中
            </span>
          )}
          {(project.statusCounts.blocked ?? 0) > 0 && (
            <span className="danger-text">
              <Ban size={14} />
              {project.statusCounts.blocked} 受阻
            </span>
          )}
        </div>
      </header>
      <div className="progress-items">
        {project.items.map((item) => (
          <ProgressItemRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function ProgressItemRow({ item }: { item: ProgressItem }) {
  return (
    <article className="progress-item">
      <div className="progress-item-main">
        <div className="progress-item-heading">
          <h3>{item.title}</h3>
          <Badge tone={statusTone(item.status)}>
            {statusLabels[item.status] ?? item.status}
          </Badge>
        </div>
        {item.payload.summary && <p>{item.payload.summary}</p>}
        <span className="progress-item-meta">
          {item.fact_ids.length} 条事实 · 更新于{" "}
          {new Date(item.updated_at).toLocaleString("zh-CN")}
        </span>
      </div>
      <div className="progress-details">
        <ProgressList title="结果" items={item.payload.outcomes} />
        <ProgressList title="阻塞" items={item.payload.blockers} danger />
        <ProgressList title="下一步" items={item.payload.nextSteps} />
      </div>
    </article>
  );
}

function ProgressList({
  title,
  items,
  danger = false,
}: {
  title: string;
  items: string[] | undefined;
  danger?: boolean;
}) {
  if (!items?.length) return null;
  return (
    <div
      className={
        danger ? "progress-list progress-list-danger" : "progress-list"
      }
    >
      <strong>{title}</strong>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
