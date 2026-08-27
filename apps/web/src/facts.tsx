import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Filter, RefreshCw } from "lucide-react";
import { api } from "./api.js";
import { Button, EmptyState, ErrorBanner, Field } from "./components.js";

type FactPage = {
  items: Array<{
    id: string;
    partner_id: string;
    partner_name: string;
    period_id: string;
    period_key: string;
    session_id: string;
    external_fact_id: string;
    source_hash: string;
    source_occurred_at: string | null;
    payload: Record<string, any>;
  }>;
  page: number;
  pageSize: number;
  total: number;
  projects: Array<{ id: string; name: string }>;
  hasUnassigned: boolean;
};

type Overview = {
  partners: Array<{ id: string; display_name: string }>;
  periods: Array<{ id: string; period_key: string }>;
};

export const FACTS_PAGE_SIZE = 10;

export function factsPageCount(total: number) {
  return Math.max(1, Math.ceil(total / FACTS_PAGE_SIZE));
}

export function FactPreviewPage() {
  const [partnerId, setPartnerId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sessionDate, setSessionDate] = useState("");
  const [page, setPage] = useState(1);
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<Overview>("/v1/admin/overview"),
  });
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(FACTS_PAGE_SIZE),
  });
  if (partnerId) params.set("partnerId", partnerId);
  if (periodId) params.set("periodId", periodId);
  if (projectId) params.set("projectId", projectId);
  if (sessionDate) params.set("sessionDate", sessionDate);
  const facts = useQuery({
    queryKey: [
      "admin-facts",
      partnerId,
      periodId,
      projectId,
      sessionDate,
      page,
    ],
    queryFn: () => api<FactPage>(`/v1/admin/session-facts?${params}`),
  });
  const data = overview.data;
  const pageCount = factsPageCount(facts.data?.total ?? 0);
  const resetPage = (update: () => void) => {
    update();
    setPage(1);
  };

  return (
    <div className="page admin-page facts-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">STRUCTURED INGESTION</span>
          <h1>Session 贡献预览</h1>
          <p>仅展示中台当前保留的结构化项目贡献</p>
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

      <section className="fact-filter-band" aria-label="Session 贡献筛选">
        <Filter size={18} />
        <Field label="用户">
          <select
            value={partnerId}
            onChange={(event) =>
              resetPage(() => setPartnerId(event.target.value))
            }
          >
            <option value="">全部用户</option>
            {data?.partners?.map((partner) => (
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
            {data?.periods?.map((period) => (
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
            {facts.data?.hasUnassigned && (
              <option value="unassigned">独立工作</option>
            )}
            {facts.data?.projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="会话日期">
          <input
            type="date"
            value={sessionDate}
            onChange={(event) =>
              resetPage(() => setSessionDate(event.target.value))
            }
          />
        </Field>
      </section>
      <ErrorBanner error={overview.error ?? facts.error} />

      {facts.isLoading ? (
        <div className="page-loading">
          <RefreshCw className="spin" />
          加载 Session 贡献
        </div>
      ) : facts.data?.items.length === 0 ? (
        <EmptyState title="当前筛选条件下没有 Session 贡献" />
      ) : (
        <section className="fact-list" aria-label="Fact 列表">
          {facts.data?.items.map((row) => {
            const fact = row.payload;
            const project = facts.data.projects?.find(
              (item) => item.id === fact.projectId,
            );
            const projectName =
              fact.project?.name ??
              project?.name ??
              fact.projectHint ??
              "独立工作";
            return (
              <article className="fact-row" key={row.id}>
                <div className="fact-row-head">
                  <div>
                    <strong>{fact.title}</strong>
                    <span>
                      {row.partner_name} · {row.period_key} · {projectName}
                    </span>
                  </div>
                </div>
                <p className="fact-summary">{factSummary(fact)}</p>
                <div className="fact-columns">
                  <FactList
                    title="成果"
                    values={contributionValues(fact, "outcome")}
                  />
                  <FactList
                    title="进展"
                    values={contributionValues(fact, "progress")}
                  />
                  <FactList
                    title="决策"
                    values={contributionValues(fact, "decision")}
                  />
                  <FactList
                    title="阻塞"
                    values={contributionValues(fact, "blocker")}
                  />
                  <FactList
                    title="下一步"
                    values={contributionValues(fact, "next_step")}
                  />
                </div>
                <div className="fact-lineage">
                  <span>会话发生于 {formatTime(row.source_occurred_at)}</span>
                  <span>
                    Contribution <code>{shortId(row.external_fact_id)}</code>
                  </span>
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

function contributionValues(fact: Record<string, any>, kind: string) {
  if (Array.isArray(fact.contributions)) {
    return fact.contributions
      .filter((item: Record<string, unknown>) => item.kind === kind)
      .map((item: Record<string, unknown>) => String(item.text));
  }
  const legacyFields: Record<string, string> = {
    outcome: "outcomes",
    progress: "actions",
    decision: "decisions",
    blocker: "blockers",
    next_step: "nextSteps",
  };
  const field = legacyFields[kind];
  const values = field ? fact[field] : undefined;
  return Array.isArray(values) ? values.map(String) : [];
}

function factSummary(fact: Record<string, any>) {
  if (typeof fact.summary === "string" && fact.summary.trim())
    return fact.summary;
  if (Array.isArray(fact.timeline)) {
    const summary = fact.timeline
      .map((item: Record<string, unknown>) => item.summary)
      .filter((value: unknown): value is string =>
        Boolean(typeof value === "string" && value.trim()),
      )
      .at(-1);
    if (summary) return summary;
  }
  if (Array.isArray(fact.impact) && fact.impact.length)
    return fact.impact.map(String).join("；");
  return "未提供摘要";
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
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "时间未知";
}
