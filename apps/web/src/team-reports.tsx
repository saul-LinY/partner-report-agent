import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, RefreshCw, Save } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Link, useRoute } from "wouter";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field } from "./components.js";

type TeamReportSummary = {
  id: string;
  period_key: string;
  status: "AGGREGATING" | "TEAM_DRAFT" | "LOCKED";
  current_version: number;
  title: string | null;
  summary: string | null;
  locked_at: string | null;
};

type Version = {
  id: string;
  version: number;
  title: string;
  summary: string;
  markdown: string;
  payload: { missingPartnerIds?: string[]; qualityWarnings?: string[] };
  created_at: string;
};

type Detail = {
  report: TeamReportSummary;
  current: Version | null;
  versions: Version[];
};

export function TeamReportPage() {
  const [, params] = useRoute("/admin/team-reports/:id");
  return params?.id ? <TeamReportDetail id={params.id} /> : null;
}

function TeamReportDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["team-report", id],
    queryFn: () => api<Detail>(`/v1/admin/team-reports/${id}`),
    refetchInterval: 15_000,
  });
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [markdown, setMarkdown] = useState("");
  const current = detail.data?.current;
  const report = detail.data?.report;
  const viewed = selectedVersion
    ? detail.data?.versions.find(
        (version) => version.version === selectedVersion,
      )
    : current;
  useEffect(() => {
    if (!current) return;
    setTitle(current.title);
    setSummary(current.summary);
    setMarkdown(current.markdown);
  }, [current?.id]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["team-report", id] }),
      queryClient.invalidateQueries({ queryKey: ["team-reports"] }),
    ]);
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/v1/admin/team-reports/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          baseVersion: current?.version,
          title,
          summary,
          markdown,
        }),
      }),
    onSuccess: refresh,
  });
  const regenerate = useMutation({
    mutationFn: () =>
      api(`/v1/admin/team-reports/${id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: refresh,
  });
  const submit = useMutation({
    mutationFn: () =>
      api(`/v1/admin/team-reports/${id}/submit`, {
        method: "POST",
        body: JSON.stringify({ baseVersion: current?.version }),
      }),
    onSuccess: refresh,
  });
  const error = detail.error ?? save.error ?? regenerate.error ?? submit.error;
  const editable = report?.status === "TEAM_DRAFT" && selectedVersion === null;
  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">TEAM REPORT REVIEW</span>
          <h1>{report?.period_key ?? "Team Report"}</h1>
          <p>
            {report
              ? `${statusLabel(report.status)} · 当前版本 v${report.current_version}`
              : "加载中"}
          </p>
        </div>
        <div className="header-actions">
          <Link className="button button-ghost" href="/admin/reports">
            返回归档
          </Link>
          {editable && (
            <>
              <Button
                variant="secondary"
                icon={<RefreshCw size={16} />}
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                重新生成
              </Button>
              <Button
                variant="secondary"
                icon={<Save size={16} />}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                保存版本
              </Button>
              <Button
                icon={<Archive size={16} />}
                loading={submit.isPending}
                onClick={() => submit.mutate()}
              >
                锁定归档
              </Button>
            </>
          )}
        </div>
      </header>
      <ErrorBanner error={error} />
      {detail.isLoading ? (
        <div className="page-loading">
          <RefreshCw className="spin" />
          加载报告
        </div>
      ) : !current ? (
        <EmptyState title="报告正在生成，完成后会自动出现" />
      ) : (
        <div className="team-report-layout">
          <aside className="team-report-versions">
            <strong>历史版本</strong>
            {detail.data?.versions.map((version) => (
              <button
                className={viewed?.version === version.version ? "active" : ""}
                key={version.id}
                onClick={() =>
                  setSelectedVersion(
                    version.version === current.version
                      ? null
                      : version.version,
                  )
                }
              >
                <span>v{version.version}</span>
                <small>
                  {new Date(version.created_at).toLocaleString("zh-CN")}
                </small>
              </button>
            ))}
          </aside>
          <section className="team-report-editor">
            {editable ? (
              <>
                <Field label="标题">
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Field>
                <Field label="摘要">
                  <textarea
                    rows={3}
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                  />
                </Field>
                <Field label="报告正文">
                  <textarea
                    className="markdown-editor"
                    rows={24}
                    value={markdown}
                    onChange={(event) => setMarkdown(event.target.value)}
                  />
                </Field>
              </>
            ) : (
              <article className="report-document">
                <h1>{viewed?.title}</h1>
                <p className="report-lede">{viewed?.summary}</p>
                <ReactMarkdown>{viewed?.markdown ?? ""}</ReactMarkdown>
              </article>
            )}
            <div className="team-report-meta">
              <span>
                缺失用户 {viewed?.payload.missingPartnerIds?.length ?? 0}
              </span>
              <span>
                质量提醒 {viewed?.payload.qualityWarnings?.length ?? 0}
              </span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function statusLabel(value: string) {
  return (
    (
      {
        AGGREGATING: "生成中",
        TEAM_DRAFT: "待审核",
        LOCKED: "已归档",
      } as Record<string, string>
    )[value] ?? value
  );
}
