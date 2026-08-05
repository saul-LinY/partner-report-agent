import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileStack,
  Filter,
  FolderKanban,
  GitBranch,
  RefreshCw,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Link, useLocation, useRoute } from "wouter";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner, Field } from "./components.js";

type ArchivedReport = {
  id: string;
  period_key: string;
  title: string;
  summary: string;
  locked_at: string;
  partner_id?: string;
  partner_name?: string;
  partner_email?: string;
  period_id?: string;
  starts_at?: string;
  status: string;
};

type ArchiveDetail = {
  report: ArchivedReport;
  current: any;
  workItemSnapshot: any;
  workItems: any[];
};

type FinalWorkItem = {
  id: string;
  title: string;
  status: string;
  reviewStatus: string;
  overview: string;
  includedInReport: boolean;
  createdAt: string;
};

type FinalIndividualReport = {
  id: string;
  title: string;
  summary: string;
  lockedAt: string;
};

type FinalTeamReport = FinalIndividualReport & { version: number };

type ArchivePerson = {
  id: string;
  name: string;
  email: string;
  individualReport: FinalIndividualReport;
  workItems: FinalWorkItem[];
};

type ArchivePeriod = {
  id: string;
  periodKey: string;
  startsAt: string;
  endsAt: string;
  people: ArchivePerson[];
  teamReport: FinalTeamReport | null;
};

type ReportArchive = { periods: ArchivePeriod[] };

export function ReportArchivePage() {
  const [, params] = useRoute("/admin/reports/individual/:id");
  if (params?.id) return <IndividualArchiveDetail id={params.id} />;
  return <ArchiveList />;
}

function ArchiveList() {
  const [, navigate] = useLocation();
  const [partnerId, setPartnerId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const archive = useQuery({
    queryKey: ["report-archive"],
    queryFn: () => api<ReportArchive>("/v1/admin/report-archive"),
  });
  const periods = archive.data?.periods ?? [];
  const partnerOptions = uniqueBy(
    periods.flatMap((period) => period.people),
    (person) => person.id,
  ).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const visiblePeriods = periods
    .filter((period) => !periodId || period.id === periodId)
    .map((period) => ({
      ...period,
      people: period.people.filter(
        (person) => !partnerId || person.id === partnerId,
      ),
    }))
    .filter((period) => !partnerId || period.people.length > 0);
  const finalWorkItemCount = periods.reduce(
    (total, period) =>
      total +
      period.people.reduce(
        (periodTotal, person) => periodTotal + person.workItems.length,
        0,
      ),
    0,
  );
  const finalReportCount = periods.reduce(
    (total, period) => total + period.people.length,
    0,
  );
  const finalTeamReportCount = periods.filter(
    (period) => period.teamReport,
  ).length;

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">REPORT ARCHIVE</span>
          <h1>报告归档</h1>
          <p>按周期查看每个人最终确认的工作卡片、个人 Report 与 Team Report</p>
        </div>
        <div className="archive-summary" aria-label="归档统计">
          <span>{finalWorkItemCount} 张工作卡片</span>
          <span>{finalReportCount} 份个人 Report</span>
          <span>{finalTeamReportCount} 份 Team Report</span>
        </div>
      </header>
      <ErrorBanner error={archive.error} />
      {!archive.isLoading && periods.length > 0 && (
        <section className="archive-filter-band" aria-label="个人归档筛选">
          <Filter size={18} />
          <Field label="人员">
            <select
              value={partnerId}
              onChange={(event) => setPartnerId(event.target.value)}
            >
              <option value="">全部人员</option>
              {partnerOptions.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="周期">
            <select
              value={periodId}
              onChange={(event) => setPeriodId(event.target.value)}
            >
              <option value="">全部周期</option>
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.periodKey}
                </option>
              ))}
            </select>
          </Field>
        </section>
      )}
      {archive.isLoading ? (
        <div className="page-loading">
          <RefreshCw className="spin" />
          加载报告归档
        </div>
      ) : visiblePeriods.length === 0 ? (
        <EmptyState
          title={
            partnerId || periodId
              ? "没有符合筛选条件的报告归档"
              : "还没有最终确认的报告归档"
          }
        />
      ) : (
        <div className="archive-periods">
          {visiblePeriods.map((period) => (
            <section className="archive-period" key={period.id}>
              <header className="archive-period-header">
                <div>
                  <span className="eyebrow">REPORT PERIOD</span>
                  <h2>{period.periodKey}</h2>
                  <time>
                    {formatDate(period.startsAt)} - {formatDate(period.endsAt)}
                  </time>
                </div>
                <div>
                  <Badge tone="neutral">{period.people.length} 人</Badge>
                  <Badge tone={period.teamReport ? "success" : "warning"}>
                    {period.teamReport
                      ? "Team Report 已归档"
                      : "等待 Team Report"}
                  </Badge>
                </div>
              </header>

              {period.people.map((person) => (
                <section className="archive-person" key={person.id}>
                  <header>
                    <UserRound size={18} />
                    <div>
                      <strong>{person.name}</strong>
                      <span>{person.email}</span>
                    </div>
                    <Badge tone="neutral">
                      {person.workItems.length} 张工作卡片
                    </Badge>
                  </header>
                  <div className="archive-person-content">
                    <section className="archive-final-work-items">
                      <div className="archive-content-heading">
                        <FolderKanban size={17} />
                        <h3>工作卡片</h3>
                        <span>最终确认结果</span>
                      </div>
                      {person.workItems.length > 0 ? (
                        <div className="archive-work-item-list">
                          {person.workItems.map((item) => (
                            <button
                              key={item.id}
                              onClick={() =>
                                navigate(
                                  `/admin/reports/individual/${person.individualReport.id}?view=work-items&workItem=${item.id}`,
                                )
                              }
                            >
                              <div>
                                <strong>{item.title}</strong>
                                <p>{item.overview || "暂无工作卡片总览"}</p>
                              </div>
                              <div className="archive-item-meta">
                                <Badge tone={reviewTone(item.reviewStatus)}>
                                  {reviewLabel(item.reviewStatus)}
                                </Badge>
                                <span>{statusLabel(item.status)}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="archive-inline-empty">
                          没有已确认的工作卡片
                        </p>
                      )}
                    </section>

                    <section className="archive-final-personal-report">
                      <div className="archive-content-heading">
                        <FileStack size={17} />
                        <h3>个人 Report</h3>
                        <Badge tone="success">已确认</Badge>
                      </div>
                      <button
                        onClick={() =>
                          navigate(
                            `/admin/reports/individual/${person.individualReport.id}`,
                          )
                        }
                      >
                        <strong>{person.individualReport.title}</strong>
                        <p>{person.individualReport.summary}</p>
                        <span>查看最终报告</span>
                      </button>
                    </section>
                  </div>
                </section>
              ))}

              <section className="archive-final-team-report">
                <div className="archive-content-heading">
                  <FileStack size={18} />
                  <h3>Team Report</h3>
                  <span>周期最终报告</span>
                </div>
                {period.teamReport ? (
                  <button
                    onClick={() =>
                      navigate(`/admin/team-reports/${period.teamReport!.id}`)
                    }
                  >
                    <div>
                      <strong>{period.teamReport.title}</strong>
                      <p>{period.teamReport.summary}</p>
                    </div>
                    <Badge tone="success">
                      最终 v{period.teamReport.version}
                    </Badge>
                  </button>
                ) : (
                  <p className="archive-inline-empty">
                    这个周期还没有最终确认的 Team Report。
                  </p>
                )}
              </section>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function uniqueBy<T>(items: T[], key: (item: T) => string | undefined) {
  return [...new Map(items.map((item) => [key(item), item])).values()].filter(
    (item) => key(item),
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

function IndividualArchiveDetail({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const initialParams = new URLSearchParams(window.location.search);
  const isWorkItemDetail = initialParams.get("view") === "work-items";
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(
    initialParams.get("workItem"),
  );
  const query = useQuery({
    queryKey: ["archived-individual-report", id],
    queryFn: () => api<ArchiveDetail>(`/v1/admin/individual-reports/${id}`),
  });
  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        {isWorkItemDetail ? "加载工作卡片" : "加载个人 Report"}
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );
  const data = query.data!;
  const selectedWorkItem =
    data.workItems.find((item) => item.id === selectedWorkItemId) ??
    data.workItems[0];
  const linkedWorkItems = data.workItems.filter(
    (item) => item.includedInReport,
  );
  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">
            {isWorkItemDetail ? "WORK ITEM ARCHIVE" : "INDIVIDUAL ARCHIVE"}
          </span>
          <h1>{data.report.partner_name}</h1>
          <p>
            {data.report.period_key} ·{" "}
            {isWorkItemDetail
              ? "工作卡片最终确认结果"
              : "个人 Report 最终确认结果"}
          </p>
        </div>
        <div className="header-actions archive-detail-actions">
          <Link className="button button-ghost" href="/admin/reports">
            返回归档
          </Link>
        </div>
      </header>
      {!isWorkItemDetail ? (
        <div className="report-layout report-layout-current">
          <article className="report-document">
            <div className="report-source-cards">
              <span>
                <GitBranch size={15} /> 来源工作卡片
              </span>
              <div>
                {linkedWorkItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedWorkItemId(item.id);
                      navigate(
                        `/admin/reports/individual/${id}?view=work-items&workItem=${item.id}`,
                      );
                    }}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </div>
            <h1>{data.current.title}</h1>
            <p className="report-lede">{data.current.summary}</p>
            <ReactMarkdown>{data.current.markdown}</ReactMarkdown>
          </article>
        </div>
      ) : (
        <div className="report-layout work-item-archive-layout">
          <aside className="report-side-list work-item-archive-list">
            <div className="section-heading">
              <div>
                <h2>工作卡片</h2>
              </div>
            </div>
            {data.workItems.map((item) => (
              <button
                key={item.id}
                title={item.title}
                className={selectedWorkItem?.id === item.id ? "active" : ""}
                onClick={() => setSelectedWorkItemId(item.id)}
              >
                <span>
                  <strong>{item.title}</strong>
                  <Badge tone="success">已采用</Badge>
                </span>
              </button>
            ))}
          </aside>
          {selectedWorkItem ? (
            <article className="report-document work-item-archive-document">
              <div className="work-item-archive-meta">
                <Badge tone={reviewTone(selectedWorkItem.reviewStatus)}>
                  {reviewLabel(selectedWorkItem.reviewStatus)}
                </Badge>
                <span>{statusLabel(selectedWorkItem.status)}</span>
                <time>
                  {new Date(selectedWorkItem.createdAt).toLocaleString("zh-CN")}
                </time>
              </div>
              <h1>{selectedWorkItem.title}</h1>
              <p className="report-lede">
                {selectedWorkItem.payload.overview ??
                  selectedWorkItem.payload.summary ??
                  "暂无总览"}
              </p>
              {(selectedWorkItem.payload.dailyProgress ?? []).length > 0 && (
                <section className="archived-daily-progress">
                  <h2>每日进展</h2>
                  <ol>
                    {selectedWorkItem.payload.dailyProgress.map(
                      (entry: any) => (
                        <li key={entry.date}>
                          <time>{entry.date}</time>
                          <p>{entry.summary}</p>
                        </li>
                      ),
                    )}
                  </ol>
                </section>
              )}
              <section className="work-item-report-links">
                <h2>对应个人 Report</h2>
                <div>
                  <button
                    onClick={() => navigate(`/admin/reports/individual/${id}`)}
                  >
                    {data.current.title}
                  </button>
                </div>
              </section>
            </article>
          ) : (
            <EmptyState title="没有工作卡片" />
          )}
        </div>
      )}
    </div>
  );
}

function reviewTone(value: string) {
  return value === "approved"
    ? "success"
    : value === "excluded"
      ? "neutral"
      : "warning";
}

function reviewLabel(value: string) {
  return (
    (
      { approved: "已接受", excluded: "已忽略", pending: "待审核" } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}

function statusLabel(value: string) {
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
