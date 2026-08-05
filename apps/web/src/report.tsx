import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  Download,
  FileClock,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useLocation, useRoute } from "wouter";
import { api } from "./api.js";
import { Button, ErrorBanner, Field } from "./components.js";

type ReportData = {
  report: any;
  current: any | null;
};

const statusLabels: Record<string, string> = {
  REPORT_DRAFT: "生成中",
  REPORT_REVIEW: "待审核",
  RETURNED_TO_ITEMS: "已退回项目卡片",
  SUBMITTED: "已接受",
  LOCKED: "已接受",
};

export function ReportPage() {
  const [, params] = useRoute("/partner/report/:reportId");
  const reportId = params?.reportId ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState("");
  const query = useQuery({
    queryKey: ["report", reportId],
    queryFn: () => api<ReportData>(`/v1/individual-reports/${reportId}`),
    refetchInterval: (state) =>
      state.state.data?.report.status === "REPORT_DRAFT" ? 3_000 : false,
  });

  const regenerate = useMutation({
    mutationFn: () =>
      api(`/v1/individual-reports/${reportId}/regenerate`, {
        method: "POST",
        body: JSON.stringify({
          instruction: instruction.trim(),
          contentRevision: query.data!.report.content_revision,
        }),
      }),
    onSuccess: async () => {
      setInstruction("");
      await queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      await queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
  });
  const accept = useMutation({
    mutationFn: () =>
      api(`/v1/individual-reports/${reportId}/submit`, {
        method: "POST",
        body: JSON.stringify({
          contentRevision: query.data!.report.content_revision,
        }),
      }),
    onSuccess: async () => {
      window.localStorage.removeItem("partner-report-simulated-partner");
      await queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      navigate("/admin/reviews");
    },
  });
  const download = useMutation({
    mutationFn: () =>
      api<string>(`/v1/individual-reports/${reportId}/download.md`),
    onSuccess: (markdown) => {
      const href = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `partner-report-${reportId}.md`;
      anchor.click();
      URL.revokeObjectURL(href);
    },
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
  const viewing = data.current;
  const isLocked = data.report.status === "LOCKED";
  const canReview = data.report.status === "REPORT_REVIEW";

  return (
    <div className="page report-page">
      <header className="page-header report-header">
        <div>
          <span className="eyebrow">PERSONAL REPORT REVIEW</span>
          <h1>{viewing?.title ?? "个人 Report"}</h1>
          <p>{statusLabels[data.report.status] ?? data.report.status}</p>
        </div>
        <div className="header-actions">
          {data.current && (
            <Button
              variant="secondary"
              icon={<Download size={16} />}
              loading={download.isPending}
              onClick={() => download.mutate()}
            >
              Markdown
            </Button>
          )}
          {canReview && (
            <Button
              icon={<Check size={16} />}
              loading={accept.isPending}
              onClick={() => accept.mutate()}
            >
              接受 Report
            </Button>
          )}
        </div>
      </header>
      <ErrorBanner error={regenerate.error ?? accept.error ?? download.error} />

      {!data.current ? (
        <section className="generation-state">
          <span className="generation-icon">
            <FileClock size={24} />
          </span>
          <div>
            <strong>正在生成个人 Report</strong>
            <span>完成后会自动进入审核。</span>
          </div>
          <RefreshCw className="spin" size={18} />
        </section>
      ) : (
        <>
          <div className="report-layout report-layout-current">
            <article className="report-document">
              {isLocked && (
                <div className="locked-notice">
                  <CheckCircle2 size={18} />
                  这个 Report 已接受并锁定。
                </div>
              )}
              <ReactMarkdown>{viewing.markdown}</ReactMarkdown>
            </article>
          </div>

          {canReview && (
            <section className="report-review-controls">
              <Field label="修改意见">
                <textarea
                  rows={4}
                  maxLength={1200}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                />
              </Field>
              <Button
                variant="secondary"
                icon={<RotateCcw size={16} />}
                loading={regenerate.isPending}
                disabled={instruction.trim().length < 2}
                onClick={() => regenerate.mutate()}
              >
                按意见重新生成
              </Button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
