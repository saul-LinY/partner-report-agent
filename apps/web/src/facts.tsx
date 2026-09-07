import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  TableProperties,
  FolderKanban,
  FileText,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";
import {
  AdminTableScroll,
  AdminHeader,
  AdminMetrics,
  AdminWorkspace,
  AdminPagination,
} from "./admin-workspace.js";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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
    placeholderData: keepPreviousData,
  });
  const ready = facts.data && !facts.isPlaceholderData;
  const items = ready ? facts.data.items : [];
  const pageCount = factsPageCount(facts.data?.total ?? 0);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const fact = selected?.payload;
  const projectName = (row: FactPage["items"][number]) =>
    row.payload.project?.name ??
    facts.data?.projects?.find((item) => item.id === row.payload.projectId)
      ?.name ??
    row.payload.projectHint ??
    "独立工作";
  useEffect(() => {
    if (ready && page > pageCount) {
      setPage(pageCount);
      setSelectedId(null);
      setDetailOpen(false);
    }
  }, [ready, page, pageCount]);
  const resetPage = (update: () => void) => {
    update();
    setPage(1);
    setSelectedId(null);
    setDetailOpen(false);
  };
  const clear = () =>
    resetPage(() => {
      setPartnerId("");
      setPeriodId("");
      setProjectId("");
      setSessionDate("");
    });
  const busy = facts.isLoading || facts.isPlaceholderData;
  return (
    <div className="page admin-page management-page facts-page">
      <AdminHeader
        title="贡献预览"
        icon={TableProperties}
        context="Session 项目贡献"
        refreshing={facts.isFetching || overview.isFetching}
        onRefresh={() => {
          void facts.refetch();
          void overview.refetch();
        }}
      />
      <ErrorBanner error={overview.error} />
      <ErrorBanner error={facts.error} />
      <AdminMetrics
        items={[
          { label: "匹配贡献", value: ready ? facts.data.total : "--" },
          { label: "本页贡献", value: ready ? items.length : "--" },
          {
            label: "本页项目",
            value: ready
              ? new Set(
                  items.map(
                    (item) => item.payload.projectId ?? projectName(item),
                  ),
                ).size
              : "--",
            tone: "success",
          },
          {
            label: "本页含阻塞",
            value: ready
              ? items.filter(
                  (item) =>
                    contributionValues(item.payload, "blocker").length > 0,
                ).length
              : "--",
            tone: "warning",
          },
        ]}
      />
      <div className="aw-toolbar" aria-label="Session 贡献筛选">
        <label className="aw-filter">
          <span>人员</span>
          <select
            aria-label="贡献人员"
            value={partnerId}
            onChange={(event) =>
              resetPage(() => setPartnerId(event.target.value))
            }
          >
            <option value="">全部人员</option>
            {overview.data?.partners.map((item) => (
              <option key={item.id} value={item.id}>
                {item.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="aw-filter">
          <span>周期</span>
          <select
            aria-label="贡献周期"
            value={periodId}
            onChange={(event) =>
              resetPage(() => setPeriodId(event.target.value))
            }
          >
            <option value="">全部周期</option>
            {overview.data?.periods.map((item) => (
              <option key={item.id} value={item.id}>
                {item.period_key}
              </option>
            ))}
          </select>
        </label>
        <label className="aw-filter">
          <span>项目</span>
          <select
            aria-label="贡献项目"
            value={projectId}
            onChange={(event) =>
              resetPage(() => setProjectId(event.target.value))
            }
          >
            <option value="">全部项目</option>
            {facts.data?.hasUnassigned && (
              <option value="unassigned">独立工作</option>
            )}
            {facts.data?.projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="aw-filter">
          <span>会话日期</span>
          <input
            aria-label="贡献会话日期"
            type="date"
            value={sessionDate}
            onChange={(event) =>
              resetPage(() => setSessionDate(event.target.value))
            }
          />
        </label>
        {(partnerId || periodId || projectId || sessionDate) && (
          <button className="aw-text-button" onClick={clear}>
            <X size={14} />
            重置筛选
          </button>
        )}
      </div>
      <AdminWorkspace
        label="贡献详情"
        selectionKey={selected?.id}
        open={detailOpen}
        onBack={() => setDetailOpen(false)}
        list={
          <>
            <div className="aw-section-heading">
              <h2>
                贡献记录 <span>{ready ? facts.data.total : "--"}</span>
              </h2>
              <span>按会话时间倒序 · Asia/Shanghai</span>
            </div>
            {busy ? (
              <div className="aw-loading" role="status">
                <RefreshCw className="spin" size={18} />
                加载贡献记录
              </div>
            ) : !facts.data ? (
              <EmptyState
                title="贡献记录暂不可用"
                action={
                  <button
                    className="aw-text-button"
                    onClick={() => void facts.refetch()}
                  >
                    重试
                  </button>
                }
              />
            ) : items.length ? (
              <AdminTableScroll resetKey={params.toString()}>
                <table className="aw-table aw-fact-table">
                  <thead>
                    <tr>
                      <th>贡献 / 项目</th>
                      <th>人员 / 会话时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr
                        key={row.id}
                        className={row.id === selected?.id ? "is-selected" : ""}
                      >
                        <td>
                          <button
                            className="aw-record-button"
                            aria-pressed={row.id === selected?.id}
                            onClick={() => {
                              setSelectedId(row.id);
                              setDetailOpen(true);
                            }}
                          >
                            <span className="aw-fact-title">
                              <FileText size={15} />
                              <strong>
                                {row.payload.title || "未命名贡献"}
                              </strong>
                            </span>
                            <small>
                              {projectName(row)} ·{" "}
                              {row.period_key ?? "未归属周期"}
                            </small>
                            <small className="aw-clamp">
                              {factSummary(row.payload)}
                            </small>
                          </button>
                        </td>
                        <td>
                          <strong>{row.partner_name}</strong>
                          <small>
                            <time>{formatTime(row.source_occurred_at)}</time>
                          </small>
                          {contributionValues(row.payload, "blocker").length >
                            0 && <Badge tone="warning">含阻塞</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </AdminTableScroll>
            ) : (
              <EmptyState
                title="当前筛选条件下没有 Session 贡献"
                action={
                  partnerId || periodId || projectId || sessionDate ? (
                    <button className="aw-text-button" onClick={clear}>
                      重置筛选
                    </button>
                  ) : undefined
                }
              />
            )}
            <AdminPagination
              page={page}
              pageCount={pageCount}
              total={ready ? facts.data.total : 0}
              onChange={(value) => {
                setPage(value);
                setSelectedId(null);
                setDetailOpen(false);
              }}
              loading={busy}
            />
          </>
        }
      >
        {selected && fact ? (
          <div className="aw-fact-detail">
            <header className="aw-detail-header">
              <div>
                <span className="aw-kicker">
                  贡献详情 · {selected.period_key ?? "未归属周期"}
                </span>
                <h2>{fact.title || "未命名贡献"}</h2>
                <p>
                  {selected.partner_name} · {projectName(selected)}
                </p>
              </div>
            </header>
            <section className="aw-detail-section">
              <h3>
                <FileText size={16} />
                贡献摘要
              </h3>
              <p>{factSummary(fact)}</p>
            </section>
            <section className="aw-detail-section">
              <h3>
                <FolderKanban size={16} />
                贡献明细
              </h3>
              <div className="aw-contributions">
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
            </section>
            <section className="aw-detail-section">
              <h3>
                <GitBranch size={16} />
                来源记录
              </h3>
              <dl className="aw-meta">
                <div className="aw-meta-full">
                  <dt>会话时间</dt>
                  <dd>{formatTime(selected.source_occurred_at)}</dd>
                </div>
                <div className="aw-meta-full">
                  <dt>Contribution 编号</dt>
                  <dd>
                    <code>{selected.external_fact_id}</code>
                  </dd>
                </div>
                <div className="aw-meta-full">
                  <dt>Session 编号</dt>
                  <dd>
                    <code>{selected.session_id}</code>
                  </dd>
                </div>
                <div className="aw-meta-full">
                  <dt>来源校验值</dt>
                  <dd>
                    <code>{selected.source_hash}</code>
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        ) : (
          <EmptyState title={busy ? "等待贡献记录" : "暂无贡献详情"} />
        )}
      </AdminWorkspace>
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

function formatTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "时间未知";
}
