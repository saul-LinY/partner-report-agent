import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Filter, RefreshCw, RotateCcw, X } from "lucide-react";
import { api } from "./api.js";
import { EmptyState, ErrorBanner } from "./components.js";
import {
  AdminFilterBar,
  AdminHeader,
  AdminPagination,
  AdminTableScroll,
  AdminWorkspace,
} from "./admin-workspace.js";
import {
  agentLabels,
  formatTime,
  Transcript,
  type Overview,
  type SessionDetail,
} from "./sessions.js";

type Verdict = "keep" | "drop";

type PreprocessPage = {
  items: Array<{
    id: string;
    upload_id: string;
    session_id: string;
    partner_name: string;
    period_key: string;
    agent: string;
    title: string;
    modified_at: string;
    turn_count: number;
    preview: string | null;
    project_name: string;
    verdict: Verdict;
    reason: string | null;
    decided_by: "rule" | "human";
  }>;
  page: number;
  pageSize: number;
  total: number;
  projects: string[];
  agents: string[];
};

const PAGE_SIZE = 10;

const reasonLabels: Record<string, string> = {
  test: "测试",
  chitchat: "闲聊",
  empty: "无实质内容",
  manual: "手动剔除",
};
const verdictLabels: Record<Verdict, string> = { keep: "保留", drop: "剔除" };

export function SessionPreprocessPage() {
  const queryClient = useQueryClient();
  const [partnerId, setPartnerId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [decidedBy, setDecidedBy] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<Overview>("/v1/admin/overview"),
  });
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    verdict: "keep",
  });
  for (const [key, value] of Object.entries({
    partnerId,
    periodId,
    project,
    agent,
    decidedBy,
  }))
    if (value) params.set(key, value);
  const list = useQuery({
    queryKey: ["admin-session-preprocess", params.toString()],
    queryFn: () =>
      api<PreprocessPage>(`/v1/admin/session-preprocess?${params}`),
    placeholderData: keepPreviousData,
  });
  const ready = list.data && !list.isPlaceholderData;
  const items = ready ? list.data.items : [];
  const pageCount = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));
  const selected = items.find((row) => row.id === selectedId) ?? items[0];
  const detail = useQuery({
    queryKey: [
      "admin-collector-session",
      selected?.upload_id,
      selected?.session_id,
    ],
    enabled: Boolean(selected),
    queryFn: () =>
      api<SessionDetail>(
        `/v1/admin/collector-sessions/detail?${new URLSearchParams({
          uploadId: selected!.upload_id,
          sessionId: selected!.session_id,
        })}`,
      ),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-session-preprocess"] });
  const setVerdictFor = useMutation({
    mutationFn: (input: { id: string; verdict: Verdict | "auto" }) =>
      api(`/v1/admin/session-preprocess/${input.id}/verdict`, {
        method: "PUT",
        body: JSON.stringify({ verdict: input.verdict }),
      }),
    onSuccess: invalidate,
  });
  const rerun = useMutation({
    mutationFn: () =>
      api("/v1/admin/session-preprocess/rerun", { method: "POST" }),
    onSuccess: invalidate,
  });
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
  const filtered = Boolean(
    partnerId || periodId || project || agent || decidedBy,
  );
  const clear = () =>
    resetPage(() => {
      setPartnerId("");
      setPeriodId("");
      setProject("");
      setAgent("");
      setDecidedBy("");
    });
  const busy = list.isLoading || list.isPlaceholderData;
  const select = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: Array<[string, string]>,
    all: string,
  ) => (
    <label className="aw-filter">
      <span>{label}</span>
      <select
        aria-label={`会话${label}`}
        value={value}
        onChange={(event) => resetPage(() => onChange(event.target.value))}
      >
        <option value="">{all}</option>
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="page admin-page management-page sessions-page">
      <AdminHeader
        title="会话预处理"
        icon={Filter}
        refreshing={list.isFetching || overview.isFetching || rerun.isPending}
        onRefresh={() => {
          void list.refetch();
          void overview.refetch();
          if (selected) void detail.refetch();
        }}
      >
        <button
          type="button"
          className="button"
          disabled={rerun.isPending}
          onClick={() => rerun.mutate()}
        >
          <RotateCcw size={14} />
          重新判定
        </button>
      </AdminHeader>
      <ErrorBanner error={overview.error} />
      <ErrorBanner error={list.error} />
      <ErrorBanner error={rerun.error} />
      <ErrorBanner error={setVerdictFor.error} />
      <section className="aw-view">
        <AdminFilterBar label="会话筛选">
          {select(
            "人员",
            partnerId,
            setPartnerId,
            (overview.data?.partners ?? []).map((p) => [p.id, p.display_name]),
            "全部人员",
          )}
          {select(
            "周期",
            periodId,
            setPeriodId,
            (overview.data?.periods ?? []).map((p) => [p.id, p.period_key]),
            "全部周期",
          )}
          {select(
            "项目",
            project,
            setProject,
            (list.data?.projects ?? []).map((name) => [name, name]),
            "全部项目",
          )}
          {select(
            "工具",
            agent,
            setAgent,
            (list.data?.agents ?? []).map((name) => [
              name,
              agentLabels[name] ?? name,
            ]),
            "全部工具",
          )}
          {select(
            "判定方",
            decidedBy,
            setDecidedBy,
            [
              ["rule", "规则"],
              ["human", "人工"],
            ],
            "全部判定方",
          )}
          {filtered && (
            <button className="aw-text-button" onClick={clear}>
              <X size={14} />
              重置筛选
            </button>
          )}
        </AdminFilterBar>
        <AdminWorkspace
          label="会话详情"
          selectionKey={selected?.id}
          open={detailOpen}
          onBack={() => setDetailOpen(false)}
          list={
            <>
              <div className="aw-section-heading">
                <h2>
                  会话 <span>{ready ? list.data.total : "--"}</span>
                </h2>
                <span>按最后活动倒序 · Asia/Shanghai</span>
              </div>
              {busy ? (
                <div className="aw-loading" role="status">
                  <RefreshCw className="spin" size={18} />
                  加载会话
                </div>
              ) : !list.data ? (
                <EmptyState
                  title="会话暂不可用"
                  action={
                    <button
                      className="aw-text-button"
                      onClick={() => void list.refetch()}
                    >
                      重试
                    </button>
                  }
                />
              ) : items.length ? (
                <AdminTableScroll resetKey={params.toString()}>
                  <table className="aw-table aw-session-table">
                    <thead>
                      <tr>
                        <th>会话 / 项目</th>
                        <th>判定 / 人员</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((row) => {
                        const active = row.id === selected?.id;
                        return (
                          <tr
                            key={row.id}
                            className={active ? "is-selected" : ""}
                            onClick={() => {
                              setSelectedId(row.id);
                              setDetailOpen(true);
                            }}
                          >
                            <td>
                              <button
                                type="button"
                                className="aw-record-button"
                                aria-pressed={active}
                              >
                                <strong>{row.title || "未命名会话"}</strong>
                                <small>
                                  {row.project_name} ·{" "}
                                  {agentLabels[row.agent] ?? row.agent}
                                </small>
                                {row.preview && (
                                  <small className="aw-clamp">
                                    {row.preview}
                                  </small>
                                )}
                              </button>
                            </td>
                            <td>
                              <span className={`pp-verdict is-${row.verdict}`}>
                                {verdictLabels[row.verdict]}
                                {row.reason &&
                                  ` · ${reasonLabels[row.reason] ?? row.reason}`}
                              </span>
                              <small>
                                {row.decided_by === "human" ? "人工" : "规则"} ·{" "}
                                {row.partner_name}
                              </small>
                              <small>
                                <time>{formatTime(row.modified_at)}</time> ·{" "}
                                {row.turn_count} 轮
                              </small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </AdminTableScroll>
              ) : (
                <EmptyState
                  title="当前筛选条件下没有会话"
                  action={
                    filtered ? (
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
                total={ready ? list.data.total : 0}
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
          <ErrorBanner error={detail.error} />
          {!selected ? (
            <EmptyState title={busy ? "等待会话" : "暂无会话"} />
          ) : (
            <>
              <div className="pp-actions" role="group" aria-label="会话判定">
                <span className={`pp-verdict is-${selected.verdict}`}>
                  {verdictLabels[selected.verdict]}
                  {selected.reason &&
                    ` · ${reasonLabels[selected.reason] ?? selected.reason}`}
                </span>
                <small>
                  {selected.decided_by === "human" ? "人工判定" : "规则判定"}
                </small>
                <div className="pp-buttons">
                  <button
                    type="button"
                    className="button"
                    disabled={setVerdictFor.isPending}
                    onClick={() =>
                      setVerdictFor.mutate({
                        id: selected.id,
                        verdict: "drop",
                      })
                    }
                  >
                    改为剔除
                  </button>
                  {selected.decided_by === "human" && (
                    <button
                      type="button"
                      className="aw-text-button"
                      disabled={setVerdictFor.isPending}
                      onClick={() =>
                        setVerdictFor.mutate({
                          id: selected.id,
                          verdict: "auto",
                        })
                      }
                    >
                      恢复规则判定
                    </button>
                  )}
                </div>
              </div>
              {detail.isLoading ? (
                <div className="aw-loading" role="status">
                  <RefreshCw className="spin" size={18} />
                  加载会话内容
                </div>
              ) : detail.data ? (
                <Transcript key={selected.id} session={detail.data} />
              ) : null}
            </>
          )}
        </AdminWorkspace>
      </section>
    </div>
  );
}
