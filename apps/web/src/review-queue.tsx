import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ClipboardCheck, RefreshCw, X, Clock3 } from "lucide-react";
import { useLocation, Link } from "wouter";
import { api } from "./api.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  SuccessBanner,
} from "./components.js";
import {
  AdminTableScroll,
  AdminFilterBar,
  AdminHeader,
  AdminMetrics,
  AdminSearch,
  AdminTabs,
  AdminPagination,
} from "./admin-workspace.js";

type QueueItem = {
  review_id: string;
  review_state: string;
  partner_id: string;
  partner_name: string;
  partner_email: string;
  period_key: string;
  pending_count: number;
  approved_count: number;
  excluded_count: number;
  updated_at: string;
  last_reminded_at?: string | null;
  report_id?: string;
};
type QueueData = {
  partners: Array<{ id: string; display_name: string }>;
  reviewQueue: QueueItem[];
};

type ReminderResponse = {
  accepted: boolean;
  scopeReminderCount?: number;
};

function formatReminderAge(value: string | null | undefined, now: number) {
  if (!value) return "尚未提醒";
  const elapsed = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "时间未知";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚提醒";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟前`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时前`;
}

export function ReviewQueuePage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [partnerId, setPartnerId] = useState("");
  const [period, setPeriod] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<"all" | "IN_PROGRESS" | "PENDING">("all");
  const [sort, setSort] = useState("priority");
  const [page, setPage] = useState(1);
  const [remindingReviewId, setRemindingReviewId] = useState<string | null>(
    null,
  );
  const [reminderFeedback, setReminderFeedback] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<QueueData>("/v1/admin/overview"),
    refetchInterval: 15_000,
  });
  const queue = query.data?.reviewQueue ?? [];
  const reminder = useMutation({
    mutationFn: (reviewId: string) =>
      api<ReminderResponse>(`/v1/admin/reviews/${reviewId}/remind`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      const scopeCount = result.scopeReminderCount ?? 0;
      setReminderFeedback(
        scopeCount > 0
          ? `提醒已发送，同时重新发送了 ${scopeCount} 个项目权限卡片。`
          : "提醒已发送，新的审核卡片正在发送给用户。",
      );
      void queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onSettled: () => setRemindingReviewId(null),
  });
  const pending = queue.filter((item) => item.review_state === "IN_PROGRESS");
  const generating = queue.filter((item) => item.review_state === "PENDING");
  const filtered = queue
    .filter(
      (item) =>
        (!partnerId || item.partner_id === partnerId) &&
        (!period || item.period_key === period) &&
        (state === "all" || item.review_state === state) &&
        [item.partner_name, item.partner_email, item.period_key]
          .join(" ")
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        (sort === "priority"
          ? Number(b.review_state === "IN_PROGRESS") -
            Number(a.review_state === "IN_PROGRESS")
          : 0) ||
        (sort === "oldest" ? 1 : -1) *
          (Date.parse(a.updated_at) - Date.parse(b.updated_at)) ||
        a.review_id.localeCompare(b.review_id),
    );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const clear = () => {
    setPartnerId("");
    setPeriod("");
    setSearch("");
    setState("all");
    setSort("priority");
    setPage(1);
  };
  const open = (item: QueueItem) => {
    window.localStorage.setItem(
      "partner-report-simulated-partner",
      item.partner_id,
    );
    navigate(`/partner/review/${item.review_id}`);
  };
  const ready = Boolean(query.data);
  return (
    <div className="page admin-page management-page review-queue-page">
      <AdminHeader
        title="审核队列"
        icon={ClipboardCheck}
        context="项目工作卡片"
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />
      <ErrorBanner error={query.error} />
      <ErrorBanner error={reminder.error} />
      {reminderFeedback ? (
        <SuccessBanner>{reminderFeedback}</SuccessBanner>
      ) : null}
      <AdminMetrics
        items={[
          {
            label: "待审核记录",
            value: ready ? pending.length : "--",
            tone: "warning",
          },
          {
            label: "待审核卡片",
            value: ready
              ? pending.reduce((sum, item) => sum + item.pending_count, 0)
              : "--",
            tone: "warning",
          },
          { label: "生成中记录", value: ready ? generating.length : "--" },
          {
            label: "涉及人员",
            value: ready
              ? new Set(queue.map((item) => item.partner_id)).size
              : "--",
          },
        ]}
      />
      <section className="aw-view">
        <AdminTabs
          label="审核状态"
          value={state}
          onChange={(value) => {
            setState(value);
            setPage(1);
          }}
          items={[
            { value: "all", label: "全部记录", count: queue.length },
            { value: "IN_PROGRESS", label: "待审核", count: pending.length },
            { value: "PENDING", label: "生成中", count: generating.length },
          ]}
        />
        <div
          id={`aw-panel-${state}`}
          role="tabpanel"
          aria-labelledby={`aw-tab-${state}`}
        >
          <AdminFilterBar>
            <AdminSearch
              label="搜索审核记录"
              placeholder="搜索姓名、邮箱或周期"
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
            <label className="aw-filter">
              <span>人员</span>
              <select
                aria-label="审核人员"
                value={partnerId}
                onChange={(event) => {
                  setPartnerId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部人员</option>
                {query.data?.partners.map((partner) => (
                  <option key={partner.id} value={partner.id}>
                    {partner.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="aw-filter">
              <span>周期</span>
              <select
                aria-label="审核周期"
                value={period}
                onChange={(event) => {
                  setPeriod(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部周期</option>
                {[...new Set(queue.map((item) => item.period_key))]
                  .sort()
                  .reverse()
                  .map((value) => (
                    <option key={value}>{value}</option>
                  ))}
              </select>
            </label>
            <label className="aw-filter">
              <span>排序</span>
              <select
                aria-label="审核排序"
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setPage(1);
                }}
              >
                <option value="priority">待审优先</option>
                <option value="latest">最近更新</option>
                <option value="oldest">最早更新</option>
              </select>
            </label>
            {(search ||
              partnerId ||
              period ||
              state !== "all" ||
              sort !== "priority") && (
              <button className="aw-text-button" onClick={clear}>
                <X size={14} />
                重置筛选
              </button>
            )}
          </AdminFilterBar>
          <section className="aw-section" aria-label="审核记录">
            <div className="aw-section-heading">
              <h2>
                审核记录 <span>{filtered.length}</span>
              </h2>
              <span>最近 100 条 · 每 15 秒更新</span>
            </div>
            {query.isLoading ? (
              <div className="aw-loading" role="status">
                <RefreshCw className="spin" size={18} />
                加载审核队列
              </div>
            ) : !query.data ? (
              <EmptyState
                title="审核队列暂不可用"
                action={
                  <button
                    className="aw-text-button"
                    onClick={() => void query.refetch()}
                  >
                    重试
                  </button>
                }
              />
            ) : visible.length ? (
              <AdminTableScroll
                resetKey={JSON.stringify([
                  currentPage,
                  search,
                  partnerId,
                  period,
                  state,
                  sort,
                ])}
              >
                <table className="aw-table aw-queue-table">
                  <thead>
                    <tr>
                      <th>人员</th>
                      <th>报告周期</th>
                      <th>当前状态</th>
                      <th>卡片进度</th>
                      <th>最近更新</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => {
                      const total =
                        item.pending_count +
                        item.approved_count +
                        item.excluded_count;
                      return (
                        <tr key={item.review_id}>
                          <td>
                            <div className="aw-person">
                              <span className="avatar">
                                {item.partner_name.slice(0, 1)}
                              </span>
                              <div>
                                <strong>{item.partner_name}</strong>
                                <small>{item.partner_email}</small>
                              </div>
                            </div>
                          </td>
                          <td data-label="报告周期">{item.period_key}</td>
                          <td>
                            <Badge
                              tone={
                                item.review_state === "IN_PROGRESS"
                                  ? "warning"
                                  : "neutral"
                              }
                            >
                              {reviewLabel(item.review_state)}
                            </Badge>
                          </td>
                          <td>
                            <div className="aw-progress">
                              <strong>
                                {item.approved_count + item.excluded_count} /{" "}
                                {total}
                              </strong>
                              <small>已处理</small>
                              <progress
                                aria-label={`${item.partner_name} 卡片进度`}
                                max={Math.max(1, total)}
                                value={
                                  item.approved_count + item.excluded_count
                                }
                              />
                            </div>
                            <div className="aw-queue-counts">
                              <span>{item.pending_count} 待审</span>
                              <span>{item.approved_count} 通过</span>
                              <span>{item.excluded_count} 忽略</span>
                            </div>
                          </td>
                          <td>
                            <time aria-label="最近更新">
                              {new Date(item.updated_at).toLocaleString(
                                "zh-CN",
                                {
                                  timeZone: "Asia/Shanghai",
                                  hour12: false,
                                },
                              )}
                            </time>
                            {item.review_state === "IN_PROGRESS" ? (
                              <small className="aw-reminder-age">
                                距上次提醒：
                                {formatReminderAge(item.last_reminded_at, now)}
                              </small>
                            ) : null}
                          </td>
                          <td>
                            {item.review_state === "IN_PROGRESS" ? (
                              <div className="aw-inline-actions">
                                <Button
                                  variant="secondary"
                                  icon={<ClipboardCheck size={15} />}
                                  onClick={() => open(item)}
                                >
                                  审核项目卡
                                </Button>
                                <Button
                                  variant="ghost"
                                  icon={<Bell size={15} />}
                                  loading={remindingReviewId === item.review_id}
                                  disabled={reminder.isPending}
                                  onClick={() => {
                                    reminder.reset();
                                    setReminderFeedback(null);
                                    setRemindingReviewId(item.review_id);
                                    reminder.mutate(item.review_id);
                                  }}
                                >
                                  提醒审核
                                </Button>
                              </div>
                            ) : item.review_state === "PENDING" ? (
                              <span className="aw-kicker">
                                <Clock3 size={13} /> 生成中
                              </span>
                            ) : (
                              <Link
                                className="aw-text-button"
                                href="/admin/reports"
                              >
                                查看归档
                              </Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </AdminTableScroll>
            ) : (
              <EmptyState
                title={
                  queue.length ? "没有符合条件的审核记录" : "当前没有待审核内容"
                }
                action={
                  queue.length ? (
                    <button className="aw-text-button" onClick={clear}>
                      重置筛选
                    </button>
                  ) : undefined
                }
              />
            )}
            <AdminPagination
              page={currentPage}
              pageCount={pageCount}
              total={filtered.length}
              onChange={setPage}
              loading={query.isLoading}
            />
          </section>
        </div>
      </section>
    </div>
  );
}

function reviewLabel(value: string) {
  return (
    (
      {
        IN_PROGRESS: "待审核",
        ITEMS_APPROVED: "已完成",
        ITEMS_DISMISSED: "已忽略",
        PENDING: "生成中",
      } as Record<string, string>
    )[value] ?? value
  );
}
