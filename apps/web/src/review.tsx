import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, RotateCcw, X } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import type { ReviewPeriod } from "@partner-report/contracts/leadership";
import { ParticipationEditor } from "./project-progress.js";
import { api } from "./api.js";
import { WorkspaceHeader } from "./admin-workspace.js";
import { Button, EmptyState, ErrorBanner, Field } from "./components.js";
import { countdownText, formatMoment, weekLabel } from "./schedule.js";
import "./review.css";

type CardEvent = {
  type: string;
  title: string;
  detail?: string;
  /** What leadership must decide or provide; blockers only. */
  neededSupport?: string | null;
};
type ResolvedBlocker = { title: string; evidence?: string | null };
type ReviewItem = {
  id: string;
  title: string;
  project_id?: string | null;
  project_name?: string | null;
  review_status: string;
  payload: {
    synthetic?: boolean;
    overview?: string;
    summary?: string;
    currentFocus?: string | null;
    keyEvents?: CardEvent[];
    resolvedBlockers?: ResolvedBlocker[];
  };
};
type RegenerationJob = {
  status: string;
  work_item_id: string;
  error_code?: string | null;
  error_message?: string | null;
};
type ReviewData = {
  review: { state: string; version: number; partner_id?: string };
  items: ReviewItem[];
  regenerationJobs: RegenerationJob[];
  period?: ReviewPeriod | null;
};

type Decision = "approve" | "exclude";

type ReviewCompletionResult = {
  reportId?: string;
  ignored?: boolean;
};

export function reviewNeedsCompletion(
  data:
    | {
        review: { state: string; version?: number };
        items: { review_status: string }[];
        regenerationJobs?: unknown[];
      }
    | undefined,
) {
  return Boolean(
    data?.review.state === "IN_PROGRESS" &&
    data.items.length > 0 &&
    data.items.every((item) => item.review_status !== "pending"),
  );
}
const decisionLabels: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  excluded: "已拒绝",
};
const decisionTags: Record<string, string> = {
  pending: "todo",
  approved: "done",
  excluded: "off",
};

const projectLabel = (item: ReviewItem) =>
  item.payload.synthetic ? item.title : (item.project_name ?? item.title);

const REGENERATING = ["PENDING", "LEASED", "RETRY_WAIT"];

/** The card's blockers: new ones with what leadership must decide, and earlier ones it says are resolved. */
const cardBlockers = (payload: ReviewItem["payload"]) => ({
  open: (payload.keyEvents ?? []).filter((event) => event.type === "blocker"),
  resolved: payload.resolvedBlockers ?? [],
});

function DeadlineBanner({ period }: { period: ReviewPeriod | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!period)
    return (
      <div className="rv-deadline">
        <div>通过的内容会在 周一 13:00 出现在面板；周一 12:00 前未处理自动通过</div>
      </div>
    );
  const remaining = countdownText(period.autoApproveAt, now);
  return (
    <div className="rv-deadline">
      <div>
        通过的内容会在{" "}
        <b>{formatMoment(period.publishAt, period.timezone, true)}</b>{" "}
        出现在面板上。
        <br />
        <b>{formatMoment(period.autoApproveAt, period.timezone)}</b>{" "}
        前没有处理的卡片，会按当前内容<b>自动通过</b>。
      </div>
      <div className="rv-count">
        {remaining ? (
          <>
            距自动通过<strong>{remaining}</strong>
          </>
        ) : (
          <strong>已到自动通过时间</strong>
        )}
      </div>
    </div>
  );
}

export function ReviewPage() {
  const [, params] = useRoute("/partner/review/:reviewId");
  const reviewId = params?.reviewId ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const attemptedCompletion = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["review", reviewId],
    queryFn: () => api<ReviewData>(`/v1/reviews/${reviewId}`),
    refetchInterval: (state) =>
      state.state.data?.regenerationJobs.some((job) =>
        REGENERATING.includes(job.status),
      )
        ? 2_500
        : false,
  });

  const afterChange = async () => {
    await queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
    await queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    await queryClient.invalidateQueries({ queryKey: ["leadership-snapshot"] });
  };
  const finish = (result: ReviewCompletionResult) => {
    if (result.reportId) navigate("/admin/reviews");
    else if (result.ignored) {
      window.localStorage.removeItem("partner-report-simulated-partner");
      navigate("/admin/reviews");
    }
  };

  const decisionMutation = useMutation({
    mutationFn: async ({
      id,
      decision,
    }: {
      id: string;
      decision: Decision;
    }) =>
      api<{ version: number } & ReviewCompletionResult>(
        `/v1/reviews/${reviewId}/items/${id}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            baseVersion: query.data!.review.version,
          }),
        },
      ),
    onSuccess: async (result) => {
      await afterChange();
      finish(result);
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
      await afterChange();
      finish(result);
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
    mutationFn: ({ id, instruction }: { id: string; instruction: string }) =>
      api(`/v1/reviews/${reviewId}/items/${id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({
          instruction: instruction.trim(),
          baseVersion: query.data!.review.version,
        }),
      }),
    onSuccess: async (_result, { id }) => {
      setInstructions((current) => ({ ...current, [id]: "" }));
      await afterChange();
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
  const pending = data.items.filter((item) => item.review_status === "pending");
  const handled = data.items.filter((item) => item.review_status !== "pending");
  const isEditable = data.review.state === "IN_PROGRESS";
  const period = data.period;
  const title = period
    ? `${weekLabel(period.periodKey)} 工作卡 · 请审核`
    : "工作卡 · 请审核";
  const busy = decisionMutation.isPending || regenerateMutation.isPending;

  return (
    <div className="page review-page">
      <WorkspaceHeader title={title} />
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

      <div className="rv-stack">
        {isEditable && pending.length > 0 && <DeadlineBanner period={period} />}
        <div className="rv-progress">
          已处理 <b>{handled.length}</b> / {data.items.length} · 待审核{" "}
          <b>{pending.length}</b>
        </div>

        {data.items.length === 0 && <EmptyState title="本期没有项目卡片" />}

        {pending.map((item) => {
          const job = data.regenerationJobs.find(
            (entry) => entry.work_item_id === item.id,
          );
          const regenerating = REGENERATING.includes(job?.status ?? "");
          const instruction = instructions[item.id] ?? "";
          const { open, resolved } = cardBlockers(item.payload);
          return (
            <article className="rv-card" key={item.id}>
              <div className="rv-ch">
                <h2>{projectLabel(item)}</h2>
                <span className={`rv-tag is-${decisionTags[item.review_status]}`}>
                  {decisionLabels[item.review_status] ?? item.review_status}
                </span>
              </div>
              <div className="rv-fields">
                <div className="rv-field">
                  <div className="rv-label">本周总结</div>
                  <p className="rv-summary">
                    {item.payload.overview ?? item.payload.summary}
                  </p>
                </div>
                <div className="rv-field">
                  <div className="rv-label">当前重点</div>
                  <div className="rv-focus">
                    {item.payload.currentFocus || "暂无"}
                  </div>
                </div>
                <div className="rv-field">
                  <div className="rv-label">卡点</div>
                  {open.length === 0 && resolved.length === 0 && (
                    <span className="rv-none">无卡点</span>
                  )}
                  {open.map((event, index) => (
                    <div className="rv-blk" key={`open-${index}`}>
                      <div className="rv-blk-top">
                        <h4>{event.title}</h4>
                        <span className="rv-kind">本周新发现</span>
                      </div>
                      {event.detail && <p>{event.detail}</p>}
                      {event.neededSupport && (
                        <div className="rv-ask">
                          <b>需要的支持</b>
                          {event.neededSupport}
                        </div>
                      )}
                    </div>
                  ))}
                  {resolved.map((blocker, index) => (
                    <div className="rv-blk is-resolved" key={`done-${index}`}>
                      <div className="rv-blk-top">
                        <h4>{blocker.title}</h4>
                        <span className="rv-kind">上期遗留 · 本周已解决</span>
                      </div>
                      {blocker.evidence && (
                        <div className="rv-why">✓ {blocker.evidence}</div>
                      )}
                    </div>
                  ))}
                </div>
                {item.project_id && data.review.partner_id && (
                  <div className="rv-field">
                    <div className="rv-label">项目时间</div>
                    <p className="rv-hint">
                      确认本人在此项目上的开始、暂停、恢复或完成日期。时间修改会同步到项目进展，通过周卡不会自动把整个项目标为完成。
                    </p>
                    <ParticipationEditor
                      key={item.project_id}
                      partnerId={data.review.partner_id}
                      projectId={item.project_id}
                      projectName={item.project_name ?? item.title}
                      reviewId={reviewId}
                    />
                  </div>
                )}
              </div>
              {isEditable && (
                <div className="rv-review">
                  {job?.status === "FAILED" && (
                    <div className="card-generation-error">
                      <strong>重新生成失败</strong>
                      <span>{job.error_message ?? job.error_code}</span>
                    </div>
                  )}
                  <Field label="修改意见">
                    <textarea
                      rows={3}
                      maxLength={1200}
                      value={instruction}
                      placeholder="内容不对就写在这里，例如：这个不算卡点，已经决定先上架 20 部人工看过的作品"
                      disabled={regenerating || regenerateMutation.isPending}
                      onChange={(event) =>
                        setInstructions((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="rv-acts">
                    <span className="rv-hint">
                      写了修改意见后，按意见重新生成这张卡片，再审核一次
                    </span>
                    <Button
                      variant="secondary"
                      icon={<RotateCcw size={16} />}
                      loading={regenerateMutation.isPending || regenerating}
                      disabled={instruction.trim().length < 2 || regenerating || busy}
                      onClick={() =>
                        regenerateMutation.mutate({ id: item.id, instruction })
                      }
                    >
                      {regenerating ? "正在重新生成" : "按修改意见重新生成"}
                    </Button>
                    <Button
                      variant="danger"
                      icon={<X size={16} />}
                      disabled={regenerating || busy}
                      onClick={() =>
                        decisionMutation.mutate({
                          id: item.id,
                          decision: "exclude",
                        })
                      }
                    >
                      拒绝
                    </Button>
                    <Button
                      icon={<Check size={16} />}
                      disabled={regenerating || busy}
                      onClick={() =>
                        decisionMutation.mutate({
                          id: item.id,
                          decision: "approve",
                        })
                      }
                    >
                      通过
                    </Button>
                  </div>
                </div>
              )}
            </article>
          );
        })}

        {handled.map((item) => {
          const { open } = cardBlockers(item.payload);
          const note =
            item.review_status === "excluded"
              ? "不进入面板"
              : `${open.length > 0 ? `${open.length} 个卡点` : "无卡点"} · 当前重点：${item.payload.currentFocus || "暂无"}`;
          return (
            <article className="rv-card" key={item.id}>
              <div className="rv-done-row">
                <h2>{projectLabel(item)}</h2>
                <span className="rv-done-note">{note}</span>
                <span className={`rv-tag is-${decisionTags[item.review_status]}`}>
                  {decisionLabels[item.review_status] ?? item.review_status}
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
