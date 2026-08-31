import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useRoute } from "wouter";
import { api } from "./api.js";
import { Button, EmptyState, ErrorBanner } from "./components.js";

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
  const detail = useQuery({
    queryKey: ["team-report", id],
    queryFn: () => api<Detail>(`/v1/admin/team-reports/${id}`),
    refetchInterval: 15_000,
  });
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [copiedVersion, setCopiedVersion] = useState<number | null>(null);
  const current = detail.data?.current;
  const report = detail.data?.report;
  const viewed = selectedVersion
    ? detail.data?.versions.find(
        (version) => version.version === selectedVersion,
      )
    : current;
  const error = detail.error;
  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">TEAM REPORT</span>
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
            <div className="team-report-document-toolbar">
              <Button
                type="button"
                variant="secondary"
                icon={
                  copiedVersion === viewed?.version ? (
                    <Check size={16} />
                  ) : (
                    <Copy size={16} />
                  )
                }
                disabled={!viewed}
                onClick={async () => {
                  if (!viewed) return;
                  await copyText(reportClipboardText(viewed));
                  setCopiedVersion(viewed.version);
                  window.setTimeout(
                    () =>
                      setCopiedVersion((currentVersion) =>
                        currentVersion === viewed.version
                          ? null
                          : currentVersion,
                      ),
                    1_600,
                  );
                }}
              >
                {copiedVersion === viewed?.version ? "已复制" : "复制周报"}
              </Button>
            </div>
            <article className="report-document">
              <h1>{viewed?.title}</h1>
              <section className="report-management-summary">
                <h2>管理概览</h2>
                <p className="report-lede">{viewed?.summary}</p>
              </section>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {withoutLegacyWeeklySummary(viewed?.markdown ?? "")}
              </ReactMarkdown>
            </article>
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

export function reportClipboardText(version: Version) {
  return [
    `# ${version.title}`,
    version.summary,
    withoutLegacyWeeklySummary(version.markdown),
  ]
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function withoutLegacyWeeklySummary(markdown: string) {
  return markdown
    .replace(/(^|\n)##\s+本周团队工作摘要\s*\n[\s\S]*?(?=\n##\s+|$)/u, "$1")
    .trim();
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("复制失败，请稍后重试。");
  }
}

function statusLabel(value: string) {
  return (
    (
      {
        AGGREGATING: "生成中",
        TEAM_DRAFT: "已生成",
        LOCKED: "已归档",
      } as Record<string, string>
    )[value] ?? value
  );
}
