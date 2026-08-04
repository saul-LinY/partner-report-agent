import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileStack, RefreshCw, UserRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Link, useLocation, useRoute } from "wouter";
import { api } from "./api.js";
import { Badge, EmptyState, ErrorBanner } from "./components.js";

type ArchivedReport = {
  id: string;
  period_key: string;
  current_version: number;
  title: string;
  summary: string;
  locked_at: string;
  partner_name?: string;
  partner_email?: string;
  status: string;
};

type ArchiveDetail = {
  report: ArchivedReport;
  current: any;
  versions: any[];
};

export function ReportArchivePage() {
  const [, params] = useRoute("/admin/reports/individual/:id");
  if (params?.id) return <IndividualArchiveDetail id={params.id} />;
  return <ArchiveList />;
}

function ArchiveList() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"individual" | "team">("individual");
  const individual = useQuery({
    queryKey: ["archived-individual-reports"],
    queryFn: () => api<ArchivedReport[]>("/v1/admin/individual-reports"),
  });
  const team = useQuery({
    queryKey: ["team-reports"],
    queryFn: () => api<ArchivedReport[]>("/v1/admin/team-reports"),
  });
  const teamArchives = (team.data ?? []).filter(
    (report) => report.status === "LOCKED",
  );
  const visible = tab === "individual" ? (individual.data ?? []) : teamArchives;
  const error = individual.error ?? team.error;
  const loading = individual.isLoading || team.isLoading;

  return (
    <div className="page admin-page">
      <header className="page-header archive-header">
        <div>
          <span className="eyebrow">REPORT ARCHIVE</span>
          <h1>报告归档</h1>
          <p>仅展示已经接受并锁定的最终版本</p>
        </div>
        <div className="archive-tabs" role="tablist" aria-label="报告类型">
          <button
            className={tab === "individual" ? "active" : ""}
            onClick={() => setTab("individual")}
          >
            个人 Report
            <span>{individual.data?.length ?? 0}</span>
          </button>
          <button
            className={tab === "team" ? "active" : ""}
            onClick={() => setTab("team")}
          >
            Team Report
            <span>{teamArchives.length}</span>
          </button>
        </div>
      </header>
      <ErrorBanner error={error} />
      {loading ? (
        <div className="page-loading">
          <RefreshCw className="spin" />
          加载报告归档
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title={
            tab === "individual"
              ? "还没有个人 Report 归档"
              : "还没有 Team Report 归档"
          }
        />
      ) : (
        <section className="team-report-list archive-list">
          {visible.map((report) => (
            <button
              key={report.id}
              onClick={() =>
                navigate(
                  tab === "individual"
                    ? `/admin/reports/individual/${report.id}`
                    : `/admin/team-reports/${report.id}`,
                )
              }
            >
              {tab === "individual" ? (
                <UserRound size={20} />
              ) : (
                <FileStack size={20} />
              )}
              <div>
                <strong>{report.title ?? `${report.period_key} Report`}</strong>
                <span>
                  {tab === "individual" ? `${report.partner_name} · ` : ""}
                  {report.period_key} · {report.summary}
                </span>
              </div>
              <Badge tone="success">已归档</Badge>
              <span>v{report.current_version}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function IndividualArchiveDetail({ id }: { id: string }) {
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ["archived-individual-report", id],
    queryFn: () => api<ArchiveDetail>(`/v1/admin/individual-reports/${id}`),
  });
  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载个人 Report
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
  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">INDIVIDUAL ARCHIVE</span>
          <h1>{data.report.partner_name}</h1>
          <p>
            {data.report.period_key} · 最终版本 v{data.report.current_version}
          </p>
        </div>
        <Link className="button button-ghost" href="/admin/reports">
          返回归档
        </Link>
      </header>
      <div className="report-layout">
        <aside className="report-versions">
          <div className="section-heading">
            <div>
              <h2>版本</h2>
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
          <h1>{viewing.title}</h1>
          <p className="report-lede">{viewing.summary}</p>
          <ReactMarkdown>{viewing.markdown}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
