import { Link, useRoute } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import { WorkspaceHeader } from "./admin-workspace.js";
import { EmptyState, ErrorBanner } from "./components.js";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LineChart, seriesColor } from "./charts.js";
import { ProjectProgress } from "./project-progress.js";
import {
  memberProjects,
  stateLabels,
  useLeadershipData,
  useProjectProfiles,
} from "./leadership-data.js";
import "./leadership.css";

const shiftDate = (date: string, offset: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const formatDay = (day: string) =>
  `${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;

const COLLAPSED_ROWS = 2;

/** Card grid showing two rows by default; extra rows toggle open/closed. */
function CollapsibleCards({ children }: { children: ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setColumns(
        Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").length),
      ),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const limit = columns * COLLAPSED_ROWS;
  const hidden = children.length - limit;
  return (
    <>
      <div className="lc-cards" ref={ref}>
        {open || hidden <= 0 ? children : children.slice(0, limit)}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="lc-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "收起" : `展开其余 ${hidden} 个项目`}
        </button>
      )}
    </>
  );
}

export function MemberDetailPage() {
  const [, params] = useRoute("/admin/members/:id");
  const id = params?.id ?? "";
  // Three months so the chart can page back by month; the headline figures still cover 28 days.
  const { activity, progress } = useLeadershipData(90);
  const a = activity.data;
  const p = progress.data;
  const member = p?.members.find((item) => item.id === id);
  const profiles = useProjectProfiles().data?.items;
  const projects = a && p ? memberProjects(id, p, a, profiles) : [];
  const active = a?.members.find((item) => item.id === id);
  const lastActive = Object.values(active?.byProject ?? {})
    .map((entry) => entry.lastActiveDate)
    .sort()
    .at(-1);
  const events = active?.events ?? [];
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  const [view, setView] = useState<"day" | "month">("day");
  const day = pickedDay ?? events.at(-1)?.t.slice(0, 10) ?? null;
  const month = pickedMonth ?? (day ?? a?.to ?? "").slice(0, 7);
  const firstMonth = (a?.from ?? "").slice(0, 7);
  const lastMonth = (a?.to ?? "").slice(0, 7);
  const shiftMonth = (delta: number) => {
    const [year, mon] = month.split("-").map(Number) as [number, number];
    const next = new Date(Date.UTC(year, mon - 1 + delta, 1));
    setPickedMonth(next.toISOString().slice(0, 7));
  };
  const daysInMonth = month
    ? new Date(
        Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
      ).getUTCDate()
    : 0;
  const monthDays = Array.from({ length: daysInMonth }, (_, i) =>
    String(i + 1).padStart(2, "0"),
  );
  const hours = Array.from({ length: 24 }, (_, h) =>
    String(h).padStart(2, "0"),
  );
  // One line per project, or a single line when the person owns one project.
  const lines = (
    projects.length > 1
      ? projects.map((item, i) => ({
          name: item.project.projectName,
          color: seriesColor(i),
        }))
      : [{ name: "交互轮数", color: seriesColor(0) }]
  ).map((line) => ({
    ...line,
    count: (prefix: string) =>
      events.filter(
        (event) =>
          event.t.startsWith(prefix) &&
          (projects.length <= 1 || event.p === line.name),
      ).length,
  }));
  const hourLines = lines.map((line) => ({
    name: line.name,
    color: line.color,
    values: hours.map((hour) => line.count(`${day ?? "never"}T${hour}`)),
  }));
  const monthLines = lines.map((line) => ({
    name: line.name,
    color: line.color,
    values: monthDays.map((date) => line.count(`${month}-${date}`)),
  }));
  const total = (series: { values: number[] }[]) =>
    series.reduce(
      (sum, line) => sum + line.values.reduce((x, y) => x + y, 0),
      0,
    );
  const dayTotal = total(hourLines);
  const monthTotal = total(monthLines);
  const recentDays = new Set(
    events
      .map((event) => event.t.slice(0, 10))
      .filter((date) => a && date >= shiftDate(a.to, -27)),
  ).size;
  const attention = projects.filter((item) => item.state !== "ok").length;
  return (
    <div className="page admin-page management-page">
      <WorkspaceHeader
        title={member?.name ?? "成员"}
        icon={UserRound}
        context="该成员负责的项目进展与工作活跃度"
      >
        <Link className="button button-ghost" href="/admin">
          <ArrowLeft size={14} />
          返回总览
        </Link>
      </WorkspaceHeader>
      <ErrorBanner error={activity.error} />
      <div className="lc-stack lc-overview">
        {!member || !a || !p ? (
          activity.isLoading || progress.isLoading ? (
            <p role="status">加载成员…</p>
          ) : progress.data && !member ? (
            <EmptyState title="没有找到该成员" />
          ) : null
        ) : (
          <>
            <div className="lc-kpis">
              <div className="lc-kpi">
                <span>负责的项目</span>
                <strong>{projects.length}</strong>
              </div>
              <div className="lc-kpi">
                <span>需要关注</span>
                <strong className={attention ? "is-warn" : ""}>
                  {attention}
                </strong>
                <small className="lc-delta">有卡点或停滞的项目</small>
              </div>
              <div className="lc-kpi">
                <span>近 28 天活跃</span>
                <strong>{recentDays}</strong>
                <small className="lc-delta">天</small>
              </div>
              <div className="lc-kpi">
                <span>最近活跃</span>
                <strong className="lc-kpi-date">
                  {lastActive?.slice(5) ?? "--"}
                </strong>
                <small className="lc-delta">{lastActive?.slice(0, 4)}</small>
              </div>
            </div>

            <div className="lc-section-title">
              <h3>负责的项目</h3>
            </div>
            <CollapsibleCards>
              {projects.map(
                ({
                  project,
                  profile,
                  steps,
                  done,
                  current,
                  blocker,
                  state,
                  focus,
                }) => (
                  <article className="lc-card" key={project.projectId}>
                    <header>
                      <h4>{project.projectName}</h4>
                      <span className={`lc-badge is-${state}`}>
                        {stateLabels[state]}
                      </span>
                    </header>
                    {profile?.note.oneLine.text && (
                      <p className="lc-oneline">{profile.note.oneLine.text}</p>
                    )}
                    {steps.length > 0 && (
                      <div className="lc-stage">
                        <div className="lc-stage-bar" aria-hidden="true">
                          {steps.map((step) => (
                            <span
                              key={step.name}
                              className={`is-${step.state}`}
                            />
                          ))}
                        </div>
                        <small>
                          {done}/{steps.length} 阶段
                          {current ? ` · 当前：${current.name}` : ""}
                        </small>
                      </div>
                    )}
                    {profile && (
                      <div className="lc-profile">
                        {profile.note.intro.text && (
                          <p className="lc-intro">{profile.note.intro.text}</p>
                        )}
                        {profile.note.features.length > 0 && (
                          <div>
                            <strong>能做什么</strong>
                            <ul>
                              {profile.note.features.map((feature) => (
                                <li key={feature.text}>{feature.text}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {profile.note.openIssues.length > 0 && (
                          <div>
                            <strong>待解决</strong>
                            <ul>
                              {profile.note.openIssues.map((issue) => (
                                <li key={issue.text}>{issue.text}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                    <p className="lc-focus">{focus}</p>
                    {blocker && (
                      <p className="lc-blocker">当前卡点：{blocker.title}</p>
                    )}
                    <footer>
                      <small>已开发 {project.contributionDays} 天</small>
                    </footer>
                  </article>
                ),
              )}
            </CollapsibleCards>

            <section className="lc-panel">
              <div className="lc-section-title">
                <h3>
                  {view === "month"
                    ? `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月 会话活跃度`
                    : day
                      ? `${formatDay(day)} 会话活跃度`
                      : "会话活跃度"}
                </h3>
                <div className="lc-chart-controls">
                  <div className="lc-seg" role="group" aria-label="活跃度范围">
                    {(["day", "month"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={view === mode}
                        className={view === mode ? "is-on" : ""}
                        onClick={() => setView(mode)}
                      >
                        {mode === "day" ? "按天看" : "按月看"}
                      </button>
                    ))}
                  </div>
                  {view === "day" ? (
                    <label className="lc-day-picker">
                      日期
                      <input
                        type="date"
                        value={day ?? ""}
                        min={a.from}
                        max={a.to}
                        onChange={(event) =>
                          setPickedDay(event.target.value || null)
                        }
                      />
                    </label>
                  ) : (
                    <div className="lc-month-nav">
                      <button
                        type="button"
                        aria-label="上一月"
                        disabled={month <= firstMonth}
                        onClick={() => shiftMonth(-1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>{month}</span>
                      <button
                        type="button"
                        aria-label="下一月"
                        disabled={month >= lastMonth}
                        onClick={() => shiftMonth(1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {view === "day" ? (
                dayTotal ? (
                  <LineChart
                    categories={hours}
                    series={hourLines}
                    xTitle="时间（小时）"
                    yTitle="交互轮数（轮）"
                    formatCategory={(hour) => String(Number(hour))}
                    formatTip={(hour) =>
                      `${Number(hour)}:00–${Number(hour)}:59`
                    }
                    hint="移动到图上查看该小时的交互轮数"
                    label={`${member.name} ${day ?? ""} 每小时交互轮数折线图`}
                  />
                ) : (
                  <p className="lc-empty">这一天没有交互</p>
                )
              ) : monthTotal ? (
                <LineChart
                  categories={monthDays}
                  series={monthLines}
                  xTitle="日期（日）"
                  yTitle="交互轮数（轮）"
                  formatCategory={(date) => String(Number(date))}
                  formatTip={(date) =>
                    `${Number(month.slice(5, 7))}月${Number(date)}日`
                  }
                  hint="移动到图上查看当天的交互轮数，点击可查看这一天每小时的情况"
                  onSelect={(date) => {
                    setPickedDay(`${month}-${date}`);
                    setView("day");
                  }}
                  label={`${member.name} ${month} 每日交互轮数折线图`}
                />
              ) : (
                <p className="lc-empty">这个月没有交互</p>
              )}
              <p className="lc-note">
                统计与 AI 的交互轮数（{a.timezone}
                ），已剔除测试、闲聊等无效会话。
              </p>
            </section>
          </>
        )}
        <h3 className="lc-detail-title">项目详细进展</h3>
        <ProjectProgress memberId={id} />
      </div>
    </div>
  );
}
