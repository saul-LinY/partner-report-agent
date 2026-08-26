import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, RefreshCw, UserRound } from "lucide-react";
import { useLocation } from "wouter";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field } from "./components.js";

type QueueData = {
  partners: Array<{ id: string; display_name: string }>;
  reviewQueue: any[];
};

export function ReviewQueuePage() {
  const [, navigate] = useLocation();
  const [partnerId, setPartnerId] = useState("all");
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<QueueData>("/v1/admin/overview"),
    refetchInterval: 15_000,
  });

  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载审核队列
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );

  const data = query.data!;
  const visible = data.reviewQueue.filter(
    (item) => partnerId === "all" || item.partner_id === partnerId,
  );
  const open = (item: any) => {
    window.localStorage.setItem(
      "partner-report-simulated-partner",
      item.partner_id,
    );
    navigate(`/partner/review/${item.review_id}`);
  };

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">REVIEW QUEUE</span>
          <h1>审核队列</h1>
          <p>按人员审核本周项目工作卡片</p>
        </div>
        <div className="queue-filter">
          <Field label="人员">
            <select
              value={partnerId}
              onChange={(event) => setPartnerId(event.target.value)}
            >
              <option value="all">全部人员</option>
              {data.partners.map((partner) => (
                <option value={partner.id} key={partner.id}>
                  {partner.display_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </header>

      <section className="section-block queue-page-list">
        {visible.length === 0 ? (
          <EmptyState title="当前没有待审核内容" />
        ) : (
          <div className="review-queue">
            {visible.map((item) => (
              <div className="queue-row" key={item.review_id}>
                <div className="queue-person">
                  <span className="avatar">
                    {item.partner_name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>{item.partner_name}</strong>
                    <span>
                      {item.partner_email} · {item.period_key}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="cell-label">项目卡片</span>
                  <Badge
                    tone={
                      item.review_state === "IN_PROGRESS"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {reviewLabel(item.review_state)}
                  </Badge>
                  <span className="queue-counts">
                    {item.pending_count} 待审 · {item.approved_count} 通过 ·{" "}
                    {item.excluded_count} 忽略
                  </span>
                </div>
                <div className="queue-actions">
                  {item.review_state === "IN_PROGRESS" && (
                    <Button
                      variant="secondary"
                      icon={<ClipboardCheck size={16} />}
                      onClick={() => open(item)}
                    >
                      审核项目卡
                    </Button>
                  )}
                  {item.review_state !== "IN_PROGRESS" && !item.report_id && (
                    <span className="queue-waiting">
                      <UserRound size={15} />
                      等待下一步
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function reviewLabel(value: string) {
  return (
    (
      {
        IN_PROGRESS: "待审核",
        ITEMS_APPROVED: "已完成",
        ITEMS_DISMISSED: "已忽略",
        PENDING: "生成中",
      } as Record<string, string>
    )[value] ?? value
  );
}
