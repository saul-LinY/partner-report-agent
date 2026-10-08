import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileStack,
  FolderKanban,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";
import {
  AdminTableScroll,
  AdminHeader,
  AdminTabs,
  AdminPagination,
} from "./admin-workspace.js";

type FinalWorkItem = {
  id: string;
  title: string;
  status: string;
  reviewStatus: string;
  overview: string;
};

type ArchivePerson = {
  id: string;
  name: string;
  email: string;
  workItems: FinalWorkItem[];
};

type ArchivePeriod = {
  id: string;
  periodKey: string;
  startsAt: string;
  endsAt: string;
  people: ArchivePerson[];
  teamReport: {
    id: string;
    title: string;
    summary: string;
    version: number;
  } | null;
};

type ReportArchive = { periods: ArchivePeriod[] };
type ArchiveView = "team-report" | "work-cards";

export function ReportArchivePage() {
  const [view, setView] = useState<ArchiveView>("team-report");
  const [page, setPage] = useState(1);
  const archive = useQuery({
    queryKey: ["report-archive"],
    queryFn: () => api<ReportArchive>("/v1/admin/report-archive"),
  });
  const periods = [...(archive.data?.periods ?? [])].sort(
    (a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt),
  );
  const cards = periods.flatMap((period) =>
    period.people.flatMap((person) => {
      const items: Array<FinalWorkItem | null> = person.workItems.length
        ? person.workItems
        : [null];
      return items.map((item) => ({ period, person, item }));
    }),
  );
  const total = view === "team-report" ? periods.length : cards.length;
  const pageCount = Math.max(1, Math.ceil(total / 12));
  const currentPage = Math.min(page, pageCount);
  const visiblePeriods = periods.slice(
    (currentPage - 1) * 12,
    currentPage * 12,
  );
  const visibleCards = cards.slice((currentPage - 1) * 12, currentPage * 12);
  return (
    <div className="page admin-page management-page reports-page">
      <AdminHeader
        title="周报与工作卡"
        icon={FileStack}
        context="团队周报与最终确认的项目工作卡"
        refreshing={archive.isFetching}
        onRefresh={() => void archive.refetch()}
      />
      <ErrorBanner error={archive.error} />
      <section className="aw-view">
        <AdminTabs
          label="归档内容"
          value={view}
          onChange={(value) => {
            setView(value);
            setPage(1);
          }}
          items={[
            { value: "team-report", label: "团队周报", icon: FileStack },
            { value: "work-cards", label: "项目工作卡", icon: FolderKanban },
          ]}
        />
        <div
          id={`aw-panel-${view}`}
          role="tabpanel"
          aria-labelledby={`aw-tab-${view}`}
        >
          <section
            className="aw-section"
            aria-label={
              view === "team-report" ? "团队周报列表" : "归档工作卡列表"
            }
          >
            <div className="aw-section-heading">
              <h2>
                {view === "team-report" ? "周期报告" : "项目工作卡"}{" "}
                <span>{total}</span>
              </h2>
              <span>按周期倒序</span>
            </div>
            {archive.isLoading ? (
              <div className="aw-loading" role="status">
                <RefreshCw className="spin" size={18} />
                加载周报与工作卡
              </div>
            ) : !archive.data ? (
              <EmptyState
                title="周报与工作卡暂不可用"
                action={
                  <button
                    className="aw-text-button"
                    onClick={() => void archive.refetch()}
                  >
                    重试
                  </button>
                }
              />
            ) : !total ? (
              <EmptyState
                title={
                  view === "team-report" ? "还没有每周归档" : "还没有归档工作卡"
                }
              />
            ) : view === "team-report" ? (
              <AdminTableScroll resetKey={JSON.stringify([currentPage, view])}>
                <table className="aw-table aw-archive-table">
                  <thead>
                    <tr>
                      <th>报告周期</th>
                      <th>团队周报</th>
                      <th>状态</th>
                      <th>工作卡</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePeriods.map((period) => (
                      <tr key={period.id}>
                        <td>
                          <strong>{period.periodKey}</strong>
                          <small>
                            {formatDate(period.startsAt)}
                            <br />至 {formatDate(period.endsAt)}
                          </small>
                        </td>
                        <td>
                          {period.teamReport ? (
                            <Link
                              href={`/admin/team-reports/${period.teamReport.id}`}
                            >
                              <strong>{period.teamReport.title}</strong>
                              <p className="aw-archive-summary">
                                {period.teamReport.summary}
                              </p>
                              <small>版本 v{period.teamReport.version}</small>
                            </Link>
                          ) : (
                            <span className="aw-kicker">
                              该周期的团队周报尚未生成
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={period.teamReport ? "success" : "warning"}
                          >
                            {period.teamReport ? "已归档" : "等待周报"}
                          </Badge>
                        </td>
                        <td>
                          {period.people.reduce(
                            (sum, person) => sum + person.workItems.length,
                            0,
                          )}{" "}
                          张<small>{period.people.length} 位人员</small>
                        </td>
                        <td>
                          {period.teamReport && (
                            <Link
                              className="aw-text-button"
                              href={`/admin/team-reports/${period.teamReport.id}`}
                            >
                              查看报告
                              <ArrowUpRight size={14} />
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </AdminTableScroll>
            ) : (
              <div className="aw-archive-cards">
                {visibleCards.map(({ period, person, item }) => (
                  <details
                    className="aw-archive-card"
                    key={`${period.id}:${person.id}:${item?.id ?? "empty"}`}
                  >
                    <summary>
                      <div>
                        <strong>
                          {item?.title ?? "没有已确认的项目工作卡"}
                        </strong>
                        <small>
                          {period.periodKey} · {formatDate(period.startsAt)} 至{" "}
                          {formatDate(period.endsAt)}
                        </small>
                      </div>
                      <div className="aw-card-person">
                        <strong>{person.name}</strong>
                        <small>{person.email}</small>
                      </div>
                      <Badge
                        tone={
                          item?.reviewStatus === "approved"
                            ? "success"
                            : "neutral"
                        }
                      >
                        {item ? reviewLabel(item.reviewStatus) : "无工作卡"}
                      </Badge>
                      <ChevronRight size={15} />
                    </summary>
                    <div className="aw-archive-card-content">
                      <p>{item?.overview || "暂无卡片摘要"}</p>
                      {item && (
                        <dl>
                          <div>
                            <dt>工作状态</dt>
                            <dd>{workStatusLabel(item.status)}</dd>
                          </div>
                          <div>
                            <dt>记录编号</dt>
                            <dd>
                              <code>{item.id}</code>
                            </dd>
                          </div>
                        </dl>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
            <AdminPagination
              page={currentPage}
              pageCount={pageCount}
              total={total}
              onChange={setPage}
              loading={archive.isLoading}
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
      { approved: "已确认", excluded: "已忽略", pending: "待审核" } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}
function workStatusLabel(value: string) {
  return (
    (
      {
        discussion: "讨论",
        planned: "计划",
        in_progress: "进行中",
        awaiting_validation: "待验证",
        completed: "已完成",
        blocked: "阻塞",
        cancelled: "取消",
      } as Record<string, string>
    )[value] ?? value
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
