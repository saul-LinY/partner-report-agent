import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileStack } from "lucide-react";
import { api } from "./api.js";
import { EmptyState, ErrorBanner } from "./components.js";
import { AdminHeader } from "./admin-workspace.js";
import { TeamReportView } from "./team-reports.js";
import "./leadership.css";

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

const workStatus: Record<string, { label: string; tone: string }> = {
  discussion: { label: "讨论中", tone: "neutral" },
  planned: { label: "计划中", tone: "neutral" },
  in_progress: { label: "进行中", tone: "ok" },
  awaiting_validation: { label: "待验证", tone: "stalled" },
  completed: { label: "已完成", tone: "ok" },
  blocked: { label: "有卡点", tone: "stalled" },
  cancelled: { label: "已取消", tone: "neutral" },
};

/** Leadership reading view: pick a week, read what each person did on their projects. */
export function ReportArchivePage() {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const archive = useQuery({
    queryKey: ["report-archive"],
    queryFn: () => api<ReportArchive>("/v1/admin/report-archive"),
  });
  const periods = [...(archive.data?.periods ?? [])].sort(
    (a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt),
  );
  // A deep link (?report=<id>) opens that report's period.
  const linkedReport = new URLSearchParams(window.location.search).get(
    "report",
  );
  const selected =
    periods.find((period) => period.id === pickedId) ??
    periods.find((period) => period.teamReport?.id === linkedReport) ??
    periods.find((period) => period.teamReport) ??
    periods[0];
  return (
    <div className="page admin-page management-page reports-page">
      <AdminHeader
        title="周报与工作卡"
        icon={FileStack}
        context="各成员负责项目的每周工作总结"
        refreshing={archive.isFetching}
        onRefresh={() => void archive.refetch()}
      />
      <ErrorBanner error={archive.error} />
      <section className="aw-view">
        {archive.isLoading ? (
          <p role="status">加载周报…</p>
        ) : !archive.data ? (
          <EmptyState
            title="周报暂不可用"
            action={
              <button
                className="aw-text-button"
                onClick={() => void archive.refetch()}
              >
                重试
              </button>
            }
          />
        ) : !selected ? (
          <EmptyState title="还没有每周归档" />
        ) : (
          <div className="wr-layout">
            <nav className="wr-periods" aria-label="报告周期">
              {periods.map((period) => (
                <button
                  key={period.id}
                  type="button"
                  className={period.id === selected.id ? "is-selected" : ""}
                  aria-pressed={period.id === selected.id}
                  onClick={() => setPickedId(period.id)}
                >
                  <strong>{period.periodKey}</strong>
                  <small>{formatRange(period)}</small>
                  <span
                    className={`wr-state ${period.teamReport ? "is-done" : ""}`}
                  >
                    {period.teamReport ? "已生成" : "待生成"}
                  </span>
                </button>
              ))}
            </nav>
            <ReportReader period={selected} />
          </div>
        )}
      </section>
    </div>
  );
}

function ReportReader({ period }: { period: ArchivePeriod }) {
  const report = period.teamReport;
  // The full report already covers every member's projects.
  if (report) return <TeamReportView key={report.id} id={report.id} />;
  const people = period.people.map((person) => ({
    name: person.name,
    items: person.workItems.filter((item) => item.reviewStatus === "approved"),
  }));
  const idle = people
    .filter((person) => person.items.length === 0)
    .map((person) => person.name);
  return (
    <article className="wr-reader" aria-label={`${period.periodKey} 周报`}>
      <header>
        <span className="aw-kicker">
          {period.periodKey} · {formatRange(period)}
        </span>
        <h2>{period.periodKey} 团队周报</h2>
      </header>
      <p className="wr-pending">
        该周期的团队周报尚未生成，以下是已确认的成员工作卡。
      </p>
      <section className="wr-people" aria-label="成员工作内容">
        {people
          .filter((person) => person.items.length > 0)
          .map((person) => (
            <section className="wr-person" key={person.name}>
              <h4>
                {person.name}
                <small>{person.items.length} 个项目</small>
              </h4>
              {person.items.map((item) => {
                const status = workStatus[item.status];
                return (
                  <div className="wr-item" key={item.id}>
                    <div className="wr-item-head">
                      <strong>{item.title}</strong>
                      {status && (
                        <span className={`lc-badge is-${status.tone}`}>
                          {status.label}
                        </span>
                      )}
                    </div>
                    <p>{item.overview || "暂无工作总结"}</p>
                  </div>
                );
              })}
            </section>
          ))}
        {idle.length > 0 && (
          <p className="wr-none">本周没有已确认工作卡：{idle.join("、")}</p>
        )}
      </section>
    </article>
  );
}

function formatRange(period: ArchivePeriod) {
  const format = (value: string) =>
    new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      timeZone: "Asia/Shanghai",
    }).format(new Date(value));
  return `${format(period.startsAt)} – ${format(period.endsAt)}`;
}
