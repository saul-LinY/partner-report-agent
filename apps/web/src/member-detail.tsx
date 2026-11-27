import { Link, useRoute } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { WorkspaceHeader } from "./admin-workspace.js";
import { EmptyState, ErrorBanner } from "./components.js";
import { LineChart, seriesColor } from "./charts.js";
import {
  dayDistance,
  memberHeadline,
  memberProjects,
  type MemberProject,
  type ProjectState,
} from "@partner-report/contracts/member-overview";
import { stateText, useLeadershipSnapshot } from "./leadership-data.js";
import { formatMoment, weekLabel } from "./schedule.js";
import { reviewNote, UpdateBar } from "./update-bar.js";
import { QuietProjectsButton } from "./stalled-projects.js";
import "./leadership.css";

const formatDay = (day: string) =>
  `${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
const shortDay = (day: string) =>
  `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;

const STATE_COLOR: Record<ProjectState, string> = {
  blocked: "var(--danger)",
  stalled: "var(--warning)",
  ok: "var(--success)",
  shelved: "#c8c8c8",
};

const projectFocus = (item: MemberProject) =>
  item.project.currentFocus?.text ||
  item.profile?.note.status.text ||
  "暂无当前重点";

/** 项目进展: a name list across the top, and the picked member's page below (the first member on /admin). */
export function MemberDetailPage() {
  const [, params] = useRoute("/admin/members/:id");
  const query = useLeadershipSnapshot();
  const snapshot = query.data;
  const progress = snapshot?.progress ?? null;
  const a = snapshot?.activity ?? null;
  // Everything on this page comes from the latest published work card.
  const period = snapshot?.schedule.current?.periodKey;
  const profiles = snapshot?.profiles ?? [];
  const roster =
    progress && a
      ? progress.members
          .map((entry) => ({
            member: entry,
            projects: memberProjects(entry.id, progress, a, profiles, period),
          }))
          .filter((entry) => entry.projects.length > 0)
          .sort((x, y) => x.member.name.localeCompare(y.member.name, "zh-CN"))
      : [];
  const id = params?.id ?? roster[0]?.member.id ?? "";
  const member = progress?.members.find((item) => item.id === id);
  const projects =
    progress && a ? memberProjects(id, progress, a, profiles, period) : [];
  const active = a?.members.find((item) => item.id === id);
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
  // Projects without a single turn in the viewed range (stalled ones, typically) get no line.
  const hourLines = lines
    .map((line) => ({
      name: line.name,
      color: line.color,
      values: hours.map((hour) => line.count(`${day ?? "never"}T${hour}`)),
    }))
    .filter((line) => line.values.some((value) => value > 0));
  const monthLines = lines
    .map((line) => ({
      name: line.name,
      color: line.color,
      values: monthDays.map((date) => line.count(`${month}-${date}`)),
    }))
    .filter((line) => line.values.some((value) => value > 0));
  const total = (series: { values: number[] }[]) =>
    series.reduce(
      (sum, line) => sum + line.values.reduce((x, y) => x + y, 0),
      0,
    );
  const dayTotal = total(hourLines);
  const monthTotal = total(monthLines);
  // With several projects, one extra dashed line adds them all up. With one project that line already is the total.
  const withSum = <T extends { values: number[] }>(series: T[]) =>
    series.length > 1
      ? [
          ...series,
          {
            name: "总计",
            color: "var(--ink)",
            dashed: true,
            values: (series[0]?.values ?? []).map((_, i) =>
              series.reduce((sum, line) => sum + (line.values[i] ?? 0), 0),
            ),
          },
        ]
      : series;

  const schedule = snapshot?.schedule;
  const timezone = schedule?.timezone ?? "Asia/Shanghai";
  const cutoff = schedule?.current
    ? formatMoment(schedule.current.cutoffAt, timezone)
    : null;
  const headline = a ? memberHeadline(id, projects, a) : null;
  // The 28 days ending at the cutoff, split by project for the share bar.
  const from28 = a
    ? new Date(Date.parse(`${a.to}T00:00:00Z`) - 27 * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : "";
  const recent = events.filter((event) => event.t.slice(0, 10) >= from28);
  const shares = projects
    .map((item, i) => ({
      name: item.project.projectName,
      color: seriesColor(i),
      turns: recent.filter(
        (event) =>
          projects.length <= 1 || event.p === item.project.projectName,
      ).length,
    }))
    .filter((share) => share.turns > 0)
    .sort((x, y) => y.turns - x.turns);
  const shareSum = shares.reduce((sum, share) => sum + share.turns, 0);

  const count = (state: ProjectState) =>
    projects.filter((item) => item.state === state).length;
  // The main view shows projects that are moving; stalled and shelved ones wait behind a dialog.
  const moving = projects.filter(
    (item) => item.state === "ok" || item.state === "blocked",
  );
  const quiet = projects
    .filter((item) => item.state === "stalled" || item.state === "shelved")
    .map((item) => ({ owner: member?.name ?? "", item }));
  const verdict = [
    count("ok") > 0 &&
      (count("ok") === moving.length ? (
        <>全部正常推进</>
      ) : (
        <>
          <span className="lb-n is-ok">{count("ok")} 个</span>正常推进
        </>
      )),
    count("blocked") > 0 && (
      <>
        <span className="lb-n is-block">{count("blocked")} 个有卡点</span>
        需要你拍板
      </>
    ),
  ].filter(Boolean);
  const resolved = projects.flatMap((item) =>
    item.resolved.map((event) => ({ item, event })),
  );
  const blockers = projects
    .filter((item) => item.state === "blocked")
    .flatMap((item) =>
      item.project.keyEvents
        .filter(
          (event) =>
            event.type === "blocker" &&
            !event.resolvedOn &&
            event.periodKey === period,
        )
        .sort((x, y) => y.date.localeCompare(x.date))
        .map((event) => ({ item, event })),
    );

  return (
    <div className="page admin-page management-page">
      <WorkspaceHeader title="项目进展" />
      <ErrorBanner error={query.error} />
      <div className="lc-stack lb-page">
        {snapshot && schedule && <UpdateBar schedule={schedule} />}
        {roster.length > 0 && (
          <nav className="lc-names" aria-label="成员">
            {roster.map((entry) => (
              <Link
                key={entry.member.id}
                href={`/admin/members/${entry.member.id}`}
                aria-current={entry.member.id === id ? "page" : undefined}
              >
                {entry.member.name}
                <small>{entry.projects.length}</small>
              </Link>
            ))}
          </nav>
        )}
        {query.isLoading ? (
          <p role="status">加载成员…</p>
        ) : !snapshot || !schedule ? null : (
          <>
            {!progress || !a ? (
              <EmptyState title="面板还没有发布数据" />
            ) : !member ? (
              <EmptyState
                title={id ? "没有找到该成员" : "还没有已审核的项目进展"}
              />
            ) : (
              <>
                <section className="lb-card lb-verdict" aria-label="整体结论">
                  {moving.length === 0 ? (
                    <p>{member.name} 本期没有在推进的项目。</p>
                  ) : (
                    <p>
                      {moving.length} 个在推进的项目中，
                      {verdict.map((part, i) => (
                        <span key={i}>
                          {i > 0 && "，"}
                          {part}
                        </span>
                      ))}
                      。
                    </p>
                  )}
                  <QuietProjectsButton projects={quiet} />
                  {moving.length > 0 && (
                    <>
                      <div className="lb-strip" aria-hidden="true">
                        {moving.map((item) => (
                          <span
                            key={item.project.projectId}
                            style={{ background: STATE_COLOR[item.state] }}
                          />
                        ))}
                      </div>
                      <div className="lb-strip-labels" aria-hidden="true">
                        {moving.map((item) => (
                          <span key={item.project.projectId}>
                            {item.project.projectName}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <section aria-labelledby="lb-attn-title">
                  <div className="lb-sec-title">
                    <h2 id="lb-attn-title">需要你关注</h2>
                    <span>按紧急程度排序</span>
                  </div>
                  <div className="lb-attn">
                    {blockers.length === 0 && resolved.length === 0 && (
                      <p className="lb-card lb-none">
                        本期没有需要你关注的事项。
                      </p>
                    )}
                    {blockers.map(({ item, event }) => {
                            const review =
                              event.periodKey === schedule.current?.periodKey
                                ? snapshot.reviews.find(
                                    (entry) => entry.partnerId === id,
                                  )
                                : undefined;
                            const days = dayDistance(event.date, progress.today);
                            return (
                              <article
                                className="lb-card lb-issue is-block"
                                key={`${item.project.projectId}:${event.date}:${event.title}`}
                              >
                                <div className="lb-issue-bar" />
                                <div className="lb-issue-body">
                                  <div className="lb-issue-top">
                                    <span className="lb-pill is-block">
                                      {stateText.blocked}
                                    </span>
                                    <span className="lb-issue-proj">
                                      {item.project.projectName}
                                    </span>
                                    <span className="lb-issue-since">
                                      {shortDay(event.date)}出现 ·{" "}
                                      {days > 0
                                        ? `截至本期已持续 ${days} 天`
                                        : "本期内出现"}
                                    </span>
                                  </div>
                                  <h3>{event.title}</h3>
                                  {event.detail && (
                                    <p className="lb-issue-detail">
                                      {event.detail}
                                    </p>
                                  )}
                                  {event.neededSupport && (
                                    <div className="lb-ask">
                                      <b>需要你</b>
                                      <span>{event.neededSupport}</span>
                                    </div>
                                  )}
                                  {event.periodKey && (
                                    <div className="lb-source">
                                      来源：{weekLabel(event.periodKey)} 工作卡
                                      {review &&
                                        ` · ${reviewNote(member.name, review, timezone)}`}
                                    </div>
                                  )}
                                </div>
                              </article>
                            );
                    })}
                    {resolved.map(({ item, event }) => (
                      <article
                        className="lb-card lb-issue is-done"
                        key={`done:${item.project.projectId}:${event.date}:${event.title}`}
                      >
                        <div className="lb-issue-bar" />
                        <div className="lb-issue-body">
                          <div className="lb-issue-top">
                            <span className="lb-pill is-ok">已解决</span>
                            <span className="lb-issue-proj">
                              {item.project.projectName}
                            </span>
                            <span className="lb-issue-since">
                              {shortDay(event.date)}出现 · {shortDay(event.resolvedOn!)}
                              解决
                            </span>
                          </div>
                          <h3 className="lb-done-title">{event.title}</h3>
                          {event.resolvedEvidence && (
                            <p className="lb-issue-detail">
                              {event.resolvedEvidence}
                            </p>
                          )}
                          <div className="lb-source">
                            {event.resolvedBy === "manual"
                              ? `${member.name} 手动标记已解决`
                              : "工作卡判定已解决"}
                            {" · 下期起不再显示"}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <section aria-labelledby="lb-list-title">
                  <div className="lb-sec-title">
                    <h2 id="lb-list-title">负责的项目</h2>
                  </div>
                  <div className="lb-pgrid">
                    {moving.map((item) => {
                      const { project, profile } = item;
                      const focusPeriod = project.currentFocus?.periodKey;
                      return (
                        <article
                          className="lb-card lb-pcard"
                          key={project.projectId}
                        >
                          <div className="lb-ph">
                            <h3 className="lb-name">{project.projectName}</h3>
                            {profile?.note.oneLine.text && (
                              <p className="lb-what">
                                {profile.note.oneLine.text}
                              </p>
                            )}
                          </div>
                          <div className="lb-now">
                            <span>当前重点</span>
                            <b>
                              {projectFocus(item)}
                              {focusPeriod &&
                                schedule.current &&
                                focusPeriod !== schedule.current.periodKey && (
                                  <small>
                                    {" "}
                                    · 本期无新会话，沿用 {weekLabel(focusPeriod)}{" "}
                                    工作卡
                                  </small>
                                )}
                            </b>
                          </div>
                          <div className="lb-more">
                            <div>
                              {profile?.note.intro.text && (
                                <>
                                  <h4>项目简介</h4>
                                  <p>{profile.note.intro.text}</p>
                                </>
                              )}
                              <h4>已开发</h4>
                              <p>{project.contributionDays} 天</p>
                            </div>
                            {profile && profile.note.features.length > 0 && (
                              <div>
                                <h4>主要功能</h4>
                                <ul>
                                  {profile.note.features.map((feature) => (
                                    <li key={feature.text}>{feature.text}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {profile && profile.note.openIssues.length > 0 && (
                              <div className="lb-risk">
                                <h4>待验证的风险</h4>
                                <ul>
                                  {profile.note.openIssues.map((issue) => (
                                    <li key={issue.text}>{issue.text}</li>
                                  ))}
                                </ul>
                                <div className="lb-hint">
                                  风险是还没验证的假设，不等于卡点。
                                </div>
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>

                <section aria-labelledby="lb-invest-title">
                  <div className="lb-sec-title">
                    <h2 id="lb-invest-title">工作投入</h2>
                    <span>辅助参考，不代表进展 · 随面板每周一更新</span>
                  </div>
                  <div className="lb-card lb-stats">
                    <div>
                      <span>近 28 天活跃</span>
                      <b>{headline?.activeDays28 ?? 0} 天</b>
                    </div>
                    <div>
                      <span>最近活跃</span>
                      <b>
                        {headline?.lastActiveDate
                          ? shortDay(headline.lastActiveDate)
                          : "—"}
                      </b>
                    </div>
                    <div>
                      <span>近 28 天交互</span>
                      <b>{recent.length} 轮</b>
                    </div>
                    <div className="lb-stats-share">
                      <span>
                        各项目投入占比
                        {cutoff ? `（截至 ${cutoff} 的近 28 天）` : ""}
                      </span>
                      <div className="lb-share" aria-hidden="true">
                        {shares.map((share) => (
                          <span
                            key={share.name}
                            style={{
                              width: `${(share.turns / shareSum) * 100}%`,
                              background: share.color,
                            }}
                          />
                        ))}
                      </div>
                      <div className="lb-share-labels">
                        {shares.map((share) => (
                          <span key={share.name}>
                            <i style={{ background: share.color }} />
                            {share.name}{" "}
                            {Math.round((share.turns / shareSum) * 100)}%
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <section className="lb-card lc-panel">
                    <div className="lc-section-title">
                      <h3>
                        {view === "month"
                          ? `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月 会话活跃度`
                          : day
                            ? `${formatDay(day)} 会话活跃度`
                            : "会话活跃度"}
                      </h3>
                      <div className="lc-chart-controls">
                        <div
                          className="lc-seg"
                          role="group"
                          aria-label="活跃度范围"
                        >
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
                          series={withSum(hourLines)}
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
                        series={withSum(monthLines)}
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
                      {cutoff && `数据截至 ${cutoff}，`}每周一 13:00 随面板更新。
                    </p>
                  </section>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
