import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Filter, RefreshCw } from "lucide-react";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field } from "./components.js";

type FactPage = {
  items: Array<{
    id: string;
    partner_id: string;
    partner_name: string;
    period_id: string;
    period_key: string;
    session_id: string;
    external_fact_id: string;
    source_revision: number;
    source_hash: string;
    source_occurred_at: string | null;
    late_from_period_key: string | null;
    payload: Record<string, any>;
  }>;
  page: number;
  pageSize: number;
  total: number;
};

type Overview = {
  partners: Array<{ id: string; display_name: string }>;
  periods: Array<{ id: string; period_key: string }>;
  projects: Array<{ id: string; name: string }>;
};

const statusLabels: Record<string, string> = {
  discussion: "讨论中",
  planned: "已计划",
  in_progress: "进行中",
  awaiting_validation: "待验证",
  completed: "已完成",
  blocked: "阻塞",
  cancelled: "已取消",
};

export function FactPreviewPage() {
  const [partnerId, setPartnerId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [page, setPage] = useState(1);
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<Overview>("/v1/admin/overview"),
  });
  const params = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (partnerId) params.set("partnerId", partnerId);
  if (periodId) params.set("periodId", periodId);
  if (projectId) params.set("projectId", projectId);
  if (sessionId.trim()) params.set("sessionId", sessionId.trim());
  const facts = useQuery({
    queryKey: ["admin-facts", partnerId, periodId, projectId, sessionId, page],
    queryFn: () => api<FactPage>(`/v1/admin/session-facts?${params}`),
  });
  const data = overview.data;
  const pageCount = Math.max(1, Math.ceil((facts.data?.total ?? 0) / 25));
  const resetPage = (update: () => void) => {
    update();
    setPage(1);
  };

  return (
    <div className="page admin-page facts-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">STRUCTURED INGESTION</span>
          <h1>Fact 预览</h1>
          <p>仅展示中台确认的结构化 Fact、版本和安全 lineage</p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} />}
          onClick={() => facts.refetch()}
          loading={facts.isFetching}
        >
          刷新
        </Button>
      </header>

      <section className="fact-filter-band" aria-label="Fact 筛选">
        <Filter size={18} />
        <Field label="用户">
          <select
            value={partnerId}
            onChange={(event) =>
              resetPage(() => setPartnerId(event.target.value))
            }
          >
            <option value="">全部用户</option>
            {data?.partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.display_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="周期">
          <select
            value={periodId}
            onChange={(event) =>
              resetPage(() => setPeriodId(event.target.value))
            }
          >
            <option value="">全部周期</option>
            {data?.periods.map((period) => (
              <option key={period.id} value={period.id}>
                {period.period_key}
              </option>
            ))}
          </select>
        </Field>
        <Field label="项目">
          <select
            value={projectId}
            onChange={(event) =>
              resetPage(() => setProjectId(event.target.value))
            }
          >
            <option value="">全部项目</option>
            <option value="unassigned">独立工作</option>
            {data?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Session ID">
          <input
            value={sessionId}
            onChange={(event) =>
              resetPage(() => setSessionId(event.target.value))
            }
            placeholder="精确匹配"
          />
        </Field>
      </section>
      <ErrorBanner error={overview.error ?? facts.error} />

      {facts.isLoading ? (
        <div className="page-loading">
          <RefreshCw className="spin" />
          加载 Fact
        </div>
      ) : facts.data?.items.length === 0 ? (
        <EmptyState title="当前筛选条件下没有 Fact" />
      ) : (
        <section className="fact-list" aria-label="Fact 列表">
          {facts.data?.items.map((row) => {
            const fact = row.payload;
            const project = data?.projects.find(
              (item) => item.id === fact.projectId,
            );
            return (
              <article className="fact-row" key={row.id}>
                <div className="fact-row-head">
                  <div>
                    <strong>{fact.title}</strong>
                    <span>
                      {row.partner_name} · {row.period_key} ·{" "}
                      {project?.name ?? "独立工作"}
                    </span>
                  </div>
                  <div className="fact-badges">
                    <Badge
                      tone={
                        fact.status === "blocked"
                          ? "danger"
                          : fact.status === "completed"
                            ? "success"
                            : "info"
                      }
                    >
                      {statusLabels[fact.status] ?? fact.status}
                    </Badge>
                    {row.late_from_period_key && (
                      <Badge tone="warning">
                        迟到自 {row.late_from_period_key}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="fact-columns">
                  <FactList title="行动" values={fact.actions} />
                  <FactList title="结果" values={fact.outcomes} />
                  <FactList title="下一步" values={fact.nextSteps} />
                  <FactList title="阻塞" values={fact.blockers} />
                </div>
                <div className="fact-lineage">
                  <span>
                    Session <code>{shortId(row.session_id)}</code>
                  </span>
                  <span>
                    Turn{" "}
                    <code>
                      {shortId(fact.fromTurnId)} → {shortId(fact.toTurnId)}
                    </code>
                  </span>
                  <span>
                    Revision <code>{row.source_revision}</code>
                  </span>
                  <span>
                    Fact <code>{shortId(row.external_fact_id)}</code>
                  </span>
                  <span>{formatTime(row.source_occurred_at)}</span>
                </div>
              </article>
            );
          })}
        </section>
      )}
      <div className="pagination">
        <span>
          共 {facts.data?.total ?? 0} 条 · 第 {page}/{pageCount} 页
        </span>
        <button
          className="icon-button"
          title="上一页"
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="icon-button"
          title="下一页"
          disabled={page >= pageCount}
          onClick={() => setPage((value) => value + 1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

function FactList({ title, values }: { title: string; values?: string[] }) {
  return (
    <div>
      <span>{title}</span>
      {values?.length ? (
        <ul>
          {values.map((value, index) => (
            <li key={`${index}:${value}`}>{value}</li>
          ))}
        </ul>
      ) : (
        <small>无</small>
      )}
    </div>
  );
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "时间未知";
}
