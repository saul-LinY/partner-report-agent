import type {
  LeadershipReview,
  LeadershipSchedule,
} from "@partner-report/contracts/leadership";
import { useEffect, useState } from "react";
import {
  countdownText,
  formatDate,
  formatMoment,
  weekLabel,
} from "./schedule.js";

const STEPS = ["采集本周会话", "发放审核卡", "成员审核", "面板更新"] as const;
/** Which of the four steps is under way for each phase the schedule reports. */
const ACTIVE_STEP = { collecting: 0, reviewing: 2, publishing: 3 } as const;

/** How a member's published data was confirmed, as one clause. */
export function reviewNote(
  name: string,
  review: LeadershipReview | undefined,
  timezone: string,
) {
  if (!review || review.approvedBy === "none") return `${name} 本期没有审核记录`;
  if (review.approvedBy === "auto") return `${name} 逾期未处理，已自动通过`;
  return review.approvedAt
    ? `${name} 已于 ${formatDate(review.approvedAt, timezone)}审核确认`
    : `${name} 已审核确认`;
}

/** What the panel shows now and when it changes next; shared by the overview and member pages. */
export function UpdateBar({ schedule }: { schedule: LeadershipSchedule }) {
  const { current, next, timezone } = schedule;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = countdownText(next.publishAt, now);
  const active = ACTIVE_STEP[next.step];
  const nextLabel = weekLabel(next.periodKey);
  const cutoff = formatMoment(next.cutoffAt, timezone);
  const approve = formatMoment(next.autoApproveAt, timezone);
  const details = [
    {
      title: STEPS[0],
      text:
        active === 0
          ? `进行中 · ${cutoff} 截止`
          : `${cutoff} 已截止`,
    },
    { title: STEPS[1], text: formatMoment(next.cutoffAt, timezone, true) },
    {
      title: STEPS[2],
      text:
        active === 2
          ? `进行中 · ${approve} 前，逾期自动通过`
          : `${approve} 前，逾期自动通过`,
    },
    {
      title: STEPS[3],
      text:
        active === 3
          ? `进行中 · ${formatMoment(next.publishAt, timezone, true)}`
          : formatMoment(next.publishAt, timezone, true),
    },
  ];
  return (
    <section className="lb-card lb-update" aria-label="数据更新">
      <div className="lb-update-now">
        <span className="lb-update-label">当前数据</span>
        <div className="lb-countdown" role="timer" aria-live="off">
          {remaining ? (
            <>
              距下次更新 <strong>{remaining}</strong>
            </>
          ) : (
            <strong>即将更新</strong>
          )}
        </div>
        {current ? (
          <b>
            {weekLabel(current.periodKey)} ·{" "}
            {formatMoment(current.startsAt, timezone)} –{" "}
            {formatMoment(current.cutoffAt, timezone)}
          </b>
        ) : (
          <>
            <b>尚未发布</b>
            <span className="lb-update-sub">
              首次发布后，这里会显示当前数据的周期。
            </span>
          </>
        )}
      </div>
      <div className="lb-update-next">
        <span className="lb-update-label">下次更新</span>
        <b>
          {formatMoment(next.publishAt, timezone, true)} 更新为 {nextLabel}（
          {formatMoment(next.startsAt, timezone)} – {cutoff}）
        </b>
        <ol className="lb-steps" aria-label={`${nextLabel} 更新进度`}>
          {details.map((step, index) => (
            <li
              key={step.title}
              className={index === active ? "is-on" : undefined}
              aria-current={index === active ? "step" : undefined}
            >
              {step.title}
              <small>{step.text}</small>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
