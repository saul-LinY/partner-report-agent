import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileStack,
  FolderKanban,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";

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
  const archive = useQuery({
    queryKey: ["report-archive"],
    queryFn: () => api<ReportArchive>("/v1/admin/report-archive"),
  });
  const periods = archive.data?.periods ?? [];
  const cardCount = periods.reduce(
    (total, period) =>
      total +
      period.people.reduce((sum, person) => sum + person.workItems.length, 0),
    0,
  );

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">WEEKLY ARCHIVE</span>
          <h1>每周归档</h1>
          <p>按周期查看已确认的项目工作卡和团队周报</p>
        </div>
        <div className="archive-summary">
          <span>{cardCount} 张项目工作卡</span>
          <span>
            {periods.filter((period) => period.teamReport).length} 份团队周报
          </span>
        </div>
      </header>
      <div className="archive-view-tabs" role="tablist" aria-label="归档内容">
        <button
          id="archive-tab-team-report"
          type="button"
          role="tab"
          aria-selected={view === "team-report"}
          aria-controls="archive-content"
          className={view === "team-report" ? "active" : ""}
          onClick={() => setView("team-report")}
        >
          <FileStack size={17} />
          团队周报
        </button>
        <button
          id="archive-tab-work-cards"
          type="button"
          role="tab"
          aria-selected={view === "work-cards"}
          aria-controls="archive-content"
          className={view === "work-cards" ? "active" : ""}
          onClick={() => setView("work-cards")}
        >
          <FolderKanban size={17} />
          项目工作卡
        </button>
      </div>
      <ErrorBanner error={archive.error} />
      {archive.isLoading ? (
        <div className="page-loading">
          <RefreshCw className="spin" />
          加载每周归档
        </div>
      ) : periods.length === 0 ? (
        <EmptyState title="还没有每周归档" />
      ) : (
        <div
          id="archive-content"
          className="archive-periods"
          role="tabpanel"
          aria-labelledby={
            view === "team-report"
              ? "archive-tab-team-report"
              : "archive-tab-work-cards"
          }
        >
          {periods.map((period) => (
            <section className="archive-period" key={period.id}>
              <header className="archive-period-header">
                <div>
                  <span className="eyebrow">REPORT PERIOD</span>
                  <h2>{period.periodKey}</h2>
                  <time>
                    {formatDate(period.startsAt)} - {formatDate(period.endsAt)}
                  </time>
                </div>
                <Badge
                  tone={
                    view === "work-cards"
                      ? "neutral"
                      : period.teamReport
                        ? "success"
                        : "warning"
                  }
                >
                  {view === "work-cards"
                    ? `${period.people.reduce(
                        (total, person) => total + person.workItems.length,
                        0,
                      )} 张项目工作卡`
                    : period.teamReport
                      ? "团队周报已归档"
                      : "等待团队周报"}
                </Badge>
              </header>
              {view === "team-report" ? (
                <div className="archive-team-report">
                  {period.teamReport ? (
                    <Link
                      className="archive-team-report-link"
                      href={`/admin/team-reports/${period.teamReport.id}`}
                    >
                      <FileStack size={20} />
                      <div>
                        <strong>{period.teamReport.title}</strong>
                        <p>{period.teamReport.summary}</p>
                      </div>
                      <span>v{period.teamReport.version}</span>
                      <ChevronRight size={18} />
                    </Link>
                  ) : (
                    <p className="archive-team-report-empty">
                      该周期的团队周报尚未生成
                    </p>
                  )}
                </div>
              ) : (
                period.people.map((person) => (
                  <section className="archive-person" key={person.id}>
                    <header>
                      <UserRound size={18} />
                      <div>
                        <strong>{person.name}</strong>
                        <span>{person.email}</span>
                      </div>
                      <Badge tone="neutral">
                        {person.workItems.length} 张项目工作卡
                      </Badge>
                    </header>
                    <div className="archive-person-content">
                      <section className="archive-final-work-items">
                        <div className="archive-content-heading">
                          <FolderKanban size={17} />
                          <h3>项目工作卡</h3>
                          <span>最终确认结果</span>
                        </div>
                        {person.workItems.length ? (
                          <div className="archive-work-item-list">
                            {person.workItems.map((item) => (
                              <div
                                className="archive-work-item-static"
                                key={item.id}
                              >
                                <div>
                                  <strong>{item.title}</strong>
                                  <p>{item.overview || "暂无卡片摘要"}</p>
                                </div>
                                <Badge
                                  tone={
                                    item.reviewStatus === "approved"
                                      ? "success"
                                      : "neutral"
                                  }
                                >
                                  {item.reviewStatus === "approved"
                                    ? "已确认"
                                    : "已忽略"}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="archive-inline-empty">
                            没有已确认的项目工作卡
                          </p>
                        )}
                      </section>
                    </div>
                  </section>
                ))
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
