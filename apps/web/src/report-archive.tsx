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
  current_version: number;
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
  versions: any[];
  workItemSnapshot: any;
  workItems: any[];
};

type FinalWorkItem = {
  id: string;
  versionId: string;
  version: number;
  title: string;
  status: string;
  reviewStatus: string;
  overview: string;
  includedInReport: boolean;
  createdAt: string;
};

type FinalReport = {
  id: string;
  version: number;
  title: string;
  summary: string;
  lockedAt: string;
};

type ArchivePerson = {
  id: string;
  name: string;
  email: string;
  individualReport: FinalReport;
  workItems: FinalWorkItem[];
};

type ArchivePeriod = {
  id: string;
  periodKey: string;
  startsAt: string;
  endsAt: string;
  people: ArchivePerson[];
  teamReport: FinalReport | null;
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
                        <span>最终确认版本</span>
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
                                <span>v{item.version}</span>
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
                        <Badge tone="success">
                          最终 v{person.individualReport.version}
                        </Badge>
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
                        <span>查看报告与历史版本</span>
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
  const initialReportVersion = Number(initialParams.get("reportVersion"));
  const initialWorkItemVersion = Number(initialParams.get("workItemVersion"));
  const [selectedVersion, setSelectedVersion] = useState<number | null>(
    initialReportVersion > 0 ? initialReportVersion : null,
  );
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(
    initialParams.get("workItem"),
  );
  const [selectedWorkItemVersion, setSelectedWorkItemVersion] = useState<
    number | null
  >(initialWorkItemVersion > 0 ? initialWorkItemVersion : null);
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
  const viewing =
    data.versions.find((version) => version.version === selectedVersion) ??
    data.current;
  const selectedWorkItem =
    data.workItems.find((item) => item.id === selectedWorkItemId) ??
    data.workItems[0];
  const viewingWorkItem =
    selectedWorkItem?.versions.find(
      (version: any) => version.version === selectedWorkItemVersion,
    ) ?? selectedWorkItem?.versions[0];
  const linkedWorkItems = data.workItems.flatMap((item) =>
    item.versions
      .filter((version: any) =>
        version.report_versions.some(
          (link: any) => link.reportVersion === viewing.version,
        ),
      )
      .map((version: any) => ({ item, version })),
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
              ? "工作卡片最终确认版本"
              : `个人 Report 最终版本 v${data.report.current_version}`}
          </p>
        </div>
        <div className="header-actions archive-detail-actions">
          <Link className="button button-ghost" href="/admin/reports">
            返回归档
          </Link>
        </div>
      </header>
      {!isWorkItemDetail ? (
        <div className="report-layout">
          <aside className="report-versions">
            <div className="section-heading">
              <div>
                <h2>Report 版本</h2>
              </div>
            </div>
            {data.versions.map((version) => (
              <button
                key={version.id}
                className={viewing.version === version.version ? "active" : ""}
                onClick={() => setSelectedVersion(version.version)}
              >
                <span>
                  <strong>v{version.version}</strong>
                  {version.version === data.report.current_version && (
                    <Badge tone="success">最终</Badge>
                  )}
                </span>
                <time>
                  {new Date(version.created_at).toLocaleString("zh-CN")}
                </time>
              </button>
            ))}
          </aside>
          <article className="report-document">
            <div className="report-source-cards">
              <span>
                <GitBranch size={15} /> 来源工作卡片
              </span>
              <div>
                {linkedWorkItems.map(({ item, version }) => (
                  <button
                    key={version.id}
                    onClick={() => {
                      setSelectedWorkItemId(item.id);
                      setSelectedWorkItemVersion(version.version);
                      navigate(
                        `/admin/reports/individual/${id}?view=work-items&workItem=${item.id}&workItemVersion=${version.version}`,
                      );
                    }}
                  >
                    {item.title} <strong>v{version.version}</strong>
                  </button>
                ))}
              </div>
            </div>
            <h1>{viewing.title}</h1>
            <p className="report-lede">{viewing.summary}</p>
            <ReactMarkdown>{viewing.markdown}</ReactMarkdown>
          </article>
        </div>
      ) : (
        <div className="report-layout work-item-history-layout">
          <aside className="report-versions work-item-history-list">
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
                onClick={() => {
                  setSelectedWorkItemId(item.id);
                  setSelectedWorkItemVersion(null);
                }}
              >
                <span>
                  <strong>{item.title}</strong>
                  <Badge tone={item.includedInReport ? "success" : "neutral"}>
                    {item.includedInReport ? "已关联" : "已忽略"}
                  </Badge>
                </span>
                <time>{item.versions.length} 个版本</time>
              </button>
            ))}
          </aside>
          {viewingWorkItem ? (
            <article className="report-document work-item-history-document">
              <div className="work-item-version-tabs">
                {selectedWorkItem.versions.map((version: any) => (
                  <button
                    key={version.id}
                    className={
                      viewingWorkItem.version === version.version
                        ? "active"
                        : ""
                    }
                    onClick={() => setSelectedWorkItemVersion(version.version)}
                  >
                    v{version.version}
                  </button>
                ))}
              </div>
              <div className="work-item-version-meta">
                <Badge tone={reviewTone(viewingWorkItem.review_status)}>
                  {reviewLabel(viewingWorkItem.review_status)}
                </Badge>
                <span>{statusLabel(viewingWorkItem.status)}</span>
                <span>{changeLabel(viewingWorkItem.change_type)}</span>
                <time>
                  {new Date(viewingWorkItem.created_at).toLocaleString("zh-CN")}
                </time>
              </div>
              <h1>{viewingWorkItem.title}</h1>
              <p className="report-lede">
                {viewingWorkItem.payload.overview ??
                  viewingWorkItem.payload.summary ??
                  "暂无总览"}
              </p>
              {(viewingWorkItem.payload.dailyProgress ?? []).length > 0 && (
                <section className="archived-daily-progress">
                  <h2>每日进展</h2>
                  <ol>
                    {viewingWorkItem.payload.dailyProgress.map((entry: any) => (
                      <li key={entry.date}>
                        <time>{entry.date}</time>
                        <p>{entry.summary}</p>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <section className="work-item-report-links">
                <h2>对应个人 Report 版本</h2>
                {viewingWorkItem.report_versions.length > 0 ? (
                  <div>
                    {viewingWorkItem.report_versions.map((link: any) => (
                      <button
                        key={link.reportVersionId}
                        onClick={() => {
                          setSelectedVersion(link.reportVersion);
                          navigate(
                            `/admin/reports/individual/${id}?reportVersion=${link.reportVersion}`,
                          );
                        }}
                      >
                        Report v{link.reportVersion}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p>这个工作卡片版本未被个人 Report 采用。</p>
                )}
              </section>
            </article>
          ) : (
            <EmptyState title="没有工作卡片版本" />
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

function changeLabel(value: string) {
  return (
    (
      {
        generated: "中台生成",
        regenerated: "重新生成",
        regeneration_requested: "申请重新生成",
        approve: "审核接受",
        exclude: "审核忽略",
        review_completed: "完成审核",
        migration_snapshot: "历史快照",
        migration_current: "升级前版本",
      } as Record<string, string>
    )[value] ?? value
  );
}
