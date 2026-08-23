import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  ChevronRight,
  FolderKanban,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field } from "./components.js";

type ReviewData = {
  review: any;
  items: any[];
  regenerationJobs: any[];
};

type Decision = "approve" | "exclude";

type ReviewCompletionResult = {
  reportId?: string;
  ignored?: boolean;
};

export function reviewNeedsCompletion(data: ReviewData | undefined) {
  return Boolean(
    data?.review.state === "IN_PROGRESS" &&
    data.items.length > 0 &&
    data.items.every((item) => item.review_status !== "pending"),
  );
}

const statusLabels: Record<string, string> = {
  discussion: "讨论",
  planned: "计划",
  in_progress: "进行中",
  awaiting_validation: "待验证",
  completed: "已完成",
  blocked: "阻塞",
  cancelled: "取消",
};

const decisionLabels: Record<string, string> = {
  pending: "待审核",
  approved: "已接受",
  excluded: "已忽略",
};

export function ReviewPage() {
  const [, params] = useRoute("/partner/review/:reviewId");
  const reviewId = params?.reviewId ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const attemptedCompletion = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["review", reviewId],
    queryFn: () => api<ReviewData>(`/v1/reviews/${reviewId}`),
    refetchInterval: (state) =>
      state.state.data?.regenerationJobs.some((job: any) =>
        ["PENDING", "LEASED", "RETRY_WAIT"].includes(job.status),
      )
        ? 2_500
        : false,
  });

  useEffect(() => {
    const items = query.data?.items ?? [];
    if (!items.some((item) => item.id === selectedId)) {
      setSelectedId(items[0]?.id ?? null);
    }
  }, [query.data?.items, selectedId]);

  const selected = useMemo(
    () =>
      query.data?.items.find((item) => item.id === selectedId) ??
      query.data?.items[0],
    [query.data?.items, selectedId],
  );
  const selectedJob = query.data?.regenerationJobs.find(
    (job) => job.work_item_id === selected?.id,
  );
  const isRegenerating = ["PENDING", "LEASED", "RETRY_WAIT"].includes(
    selectedJob?.status ?? "",
  );

  const decisionMutation = useMutation({
    mutationFn: async (decision: Decision) => {
      const before = query.data!;
      return api<{
        version: number;
        reportId?: string;
        ignored?: boolean;
      }>(`/v1/reviews/${reviewId}/items/${selected.id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          baseVersion: before.review.version,
        }),
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
      await queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      if (result.reportId) navigate("/admin/reviews");
      else if (result.ignored) {
        window.localStorage.removeItem("partner-report-simulated-partner");
        navigate("/admin/reviews");
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["review", reviewId] }),
  });

  const completionMutation = useMutation({
    mutationFn: () =>
      api<ReviewCompletionResult>(`/v1/reviews/${reviewId}/complete`, {
        method: "POST",
        body: JSON.stringify({ baseVersion: query.data!.review.version }),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
      await queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      if (result.reportId) navigate("/admin/reviews");
      else if (result.ignored) {
        window.localStorage.removeItem("partner-report-simulated-partner");
        navigate("/admin/reviews");
      }
    },
  });

  const completionKey = reviewNeedsCompletion(query.data)
    ? `${reviewId}:${query.data!.review.version}`
    : null;
  useEffect(() => {
    if (!completionKey || attemptedCompletion.current === completionKey) return;
    attemptedCompletion.current = completionKey;
    completionMutation.mutate();
  }, [completionKey]);

  const regenerateMutation = useMutation({
    mutationFn: () =>
      api(`/v1/reviews/${reviewId}/items/${selected.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({
          instruction: instruction.trim(),
          baseVersion: query.data!.review.version,
        }),
      }),
    onSuccess: async () => {
      setInstruction("");
      await queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
      await queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
  });

  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载项目卡片
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );

  const data = query.data!;
  const pending = data.items.filter(
    (item) => item.review_status === "pending",
  ).length;
  const isEditable = data.review.state === "IN_PROGRESS";
  const dailyProgress = selected
    ? (selected.payload.dailyProgress ?? [
        {
          date: new Date(selected.created_at).toISOString().slice(0, 10),
          summary:
            selected.payload.overview ??
            selected.payload.summary ??
            "暂无进展摘要",
        },
      ])
    : [];

  return (
    <div className="page review-page">
      <header className="page-header review-header">
        <div>
          <span className="eyebrow">PROJECT CARD REVIEW</span>
          <h1>项目工作卡片</h1>
          <p>
            {data.items.length} 个项目 · {pending} 个待审核
          </p>
        </div>
      </header>
      <ErrorBanner
        error={
          decisionMutation.error ??
          regenerateMutation.error ??
          completionMutation.error
        }
      />

      {reviewNeedsCompletion(data) && completionMutation.isError && (
        <div className="review-completion-retry">
          <Button
            icon={<RefreshCw size={16} />}
            loading={completionMutation.isPending}
            onClick={() => completionMutation.mutate()}
          >
            继续生成报告
          </Button>
        </div>
      )}

      <div className="review-layout project-card-review">
        <aside className="item-list">
          {data.items.map((item) => (
            <button
              key={item.id}
              className={`item-list-row ${item.id === selected?.id ? "active" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <FolderKanban size={17} />
              <div>
                <strong>{item.project_name ?? item.title}</strong>
                <span>{statusLabels[item.status] ?? item.status}</span>
              </div>
              <Badge
                tone={
                  item.review_status === "approved"
                    ? "success"
                    : item.review_status === "excluded"
                      ? "neutral"
                      : "warning"
                }
              >
                {decisionLabels[item.review_status] ?? item.review_status}
              </Badge>
              <ChevronRight size={16} />
            </button>
          ))}
        </aside>

        <section className="item-detail project-card-detail">
          {!selected ? (
            <EmptyState title="本期没有项目卡片" />
          ) : (
            <>
              <div className="project-card-heading">
                <div>
                  <Badge tone="info">
                    {statusLabels[selected.status] ?? selected.status}
                  </Badge>
                  <h2>{selected.project_name ?? selected.title}</h2>
                </div>
                <Badge
                  tone={
                    selected.review_status === "approved"
                      ? "success"
                      : selected.review_status === "excluded"
                        ? "neutral"
                        : "warning"
                  }
                >
                  {decisionLabels[selected.review_status] ??
                    selected.review_status}
                </Badge>
              </div>

              {selected.payload.projectDescription && (
                <section className="project-overview">
                  <h3>项目描述</h3>
                  <p>{selected.payload.projectDescription}</p>
                </section>
              )}

              <section className="project-overview">
                <h3>总览</h3>
                <p>{selected.payload.overview ?? selected.payload.summary}</p>
              </section>

              <section className="daily-progress">
                <div className="section-heading">
                  <div>
                    <h3>每日进展</h3>
                  </div>
                  <CalendarDays size={18} />
                </div>
                <ol>
                  {dailyProgress.map((entry: any) => (
                    <li key={entry.date}>
                      <time>{formatDate(entry.date)}</time>
                      <p>{entry.summary}</p>
                    </li>
                  ))}
                </ol>
              </section>

              {selectedJob?.status === "FAILED" && (
                <div className="card-generation-error">
                  <strong>重新生成失败</strong>
                  <span>
                    {selectedJob.error_message ?? selectedJob.error_code}
                  </span>
                </div>
              )}

              {isEditable && selected.review_status === "pending" && (
                <div className="project-review-controls">
                  <Field label="修改意见">
                    <textarea
                      rows={4}
                      maxLength={1200}
                      value={instruction}
                      disabled={isRegenerating}
                      onChange={(event) => setInstruction(event.target.value)}
                    />
                  </Field>
                  <div className="project-review-actions">
                    <Button
                      variant="secondary"
                      icon={<RotateCcw size={16} />}
                      loading={regenerateMutation.isPending || isRegenerating}
                      disabled={instruction.trim().length < 2 || isRegenerating}
                      onClick={() => regenerateMutation.mutate()}
                    >
                      {isRegenerating ? "正在重新生成" : "重新生成"}
                    </Button>
                    <span />
                    <Button
                      variant="danger"
                      icon={<X size={16} />}
                      loading={decisionMutation.isPending}
                      disabled={isRegenerating}
                      onClick={() => decisionMutation.mutate("exclude")}
                    >
                      拒绝并忽略
                    </Button>
                    <Button
                      icon={<Check size={16} />}
                      loading={decisionMutation.isPending}
                      disabled={isRegenerating}
                      onClick={() => decisionMutation.mutate("approve")}
                    >
                      接受
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}
