import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Flag,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import {
  addProgressDays,
  calculateProgress,
  type ProgressProject,
  progressEventLabels,
  validateProgressEvents,
  type ParticipationResponse,
  type ProgressEvent,
  type ProjectProgressResponse,
} from "@partner-report/contracts/project-progress";
import { api } from "./api.js";
import { Button, EmptyState, ErrorBanner, Field } from "./components.js";
import "./project-progress.css";
import "./project-calendar.css";
import { calendarMonthDays, shiftCalendarMonth } from "./project-calendar.js";

const keyEventTypeLabels: Record<
  ProgressProject["keyEvents"][number]["type"],
  string
> = {
  goal_change: "目标调整",
  milestone: "里程碑",
  decision: "重要决定",
  blocker: "问题阻塞",
  stage_change: "阶段切换",
};
const countDays = (value: number | null) =>
  value === null ? "待核查" : `${value} 天`;
function timestamp(value: string | null, timezone: string) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "暂无";
}
function ProgressDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="pp-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="关闭详情"
        >
          <X size={20} />
        </button>
      </header>
      <div className="pp-dialog-body">{children}</div>
    </dialog>
  );
}

export function ParticipationEditor({
  partnerId,
  projectId,
  projectName,
  reviewId,
}: {
  partnerId: string;
  projectId: string;
  projectName: string;
  reviewId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        icon={<Flag size={14} />}
        onClick={() => {
          setSaved(false);
          setOpen(true);
        }}
      >
        核查时间
      </Button>
      {saved && (
        <span className="pp-saved" role="status">
          时间已保存
        </span>
      )}
      {open && (
        <ProgressDialog
          title={`${projectName} · 时间核查`}
          onClose={() => setOpen(false)}
        >
          <ParticipationLoader
            partnerId={partnerId}
            projectId={projectId}
            {...(reviewId ? { reviewId } : {})}
            onSaved={() => {
              setSaved(true);
              setOpen(false);
            }}
          />
        </ProgressDialog>
      )}
    </>
  );
}
function ParticipationLoader({
  partnerId,
  projectId,
  reviewId,
  onSaved,
}: {
  partnerId: string;
  projectId: string;
  reviewId?: string;
  onSaved: () => void;
}) {
  const path = `/v1/project-progress/participations/${partnerId}/${projectId}`;
  const query = useQuery({
    queryKey: ["participation", partnerId, projectId],
    queryFn: () => api<ParticipationResponse>(path),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const [revision, setRevision] = useState(0);
  return (
    <>
      <ErrorBanner error={query.error} />
      {!query.data || !query.isFetchedAfterMount ? (
        query.isFetching ? (
          <p role="status">加载时间记录…</p>
        ) : (
          <Button onClick={() => void query.refetch()}>重试</Button>
        )
      ) : (
        <ParticipationForm
          key={revision}
          data={query.data}
          path={path}
          {...(reviewId ? { reviewId } : {})}
          onSaved={onSaved}
          onReload={async () => {
            const result = await query.refetch();
            if (result.isSuccess) setRevision((r) => r + 1);
          }}
        />
      )}
    </>
  );
}
function ParticipationForm({
  data,
  path,
  reviewId,
  onSaved,
  onReload,
}: {
  data: ParticipationResponse;
  path: string;
  reviewId?: string;
  onSaved: () => void;
  onReload: () => Promise<void>;
}) {
  const client = useQueryClient();
  const [events, setEvents] = useState<ProgressEvent[]>(() =>
    data.events.map((e) => ({ ...e })),
  );
  const [baseVersion] = useState(data.version);
  const [note, setNote] = useState("");
  const [reloadOpen, setReloadOpen] = useState(false);
  const validation = validateProgressEvents(events, data.today);
  const metrics = validation ? null : calculateProgress(events, data.today);
  const mutation = useMutation({
    mutationFn: () =>
      api(path, {
        method: "POST",
        body: JSON.stringify({
          baseVersion,
          events,
          note,
          ...(reviewId ? { reviewId } : {}),
        }),
      }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["project-progress"] }),
        client.invalidateQueries({ queryKey: ["participation"] }),
      ]);
      onSaved();
    },
  });
  const update = (index: number, patch: Partial<ProgressEvent>) =>
    setEvents((value) =>
      value.map((event, i) => {
        if (i !== index) return event;
        const next = { ...event, ...patch };
        if (patch.type && patch.type !== "milestone") delete next.stage;
        return next;
      }),
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!validation && note.trim().length >= 2) mutation.mutate();
      }}
    >
      <p className="pp-explanation">
        记录这位成员在此项目上的开始、暂停、恢复和完成，也可以添加具体成果作为里程碑。并行项目各自记录，暂停时注明临时任务或其他原因。没有贡献记录的日期不会自动算作暂停。
      </p>
      <p className="pp-muted">
        按团队时区 {data.timezone}{" "}
        逐日统计，包含开始和完成当天；暂停从当天算起，恢复当天重新计入推进区间。一天内的短暂切换不折算为工时。
      </p>
      <fieldset disabled={mutation.isPending} className="pp-events-fieldset">
        <legend className="sr-only">时间事件</legend>
        {events.length === 0 && (
          <div className="pp-notice">
            尚未确认开始时间，项目跨度暂不计算。可以补录历史日期。
          </div>
        )}
        {events.map((event, index) => (
          <div className="pp-event-form" key={index}>
            <Field label={`事件 ${index + 1} 日期`}>
              <input
                type="date"
                required
                max={data.today}
                value={event.date}
                onChange={(e) => update(index, { date: e.target.value })}
              />
            </Field>
            <Field label={`事件 ${index + 1} 类型`}>
              <select
                value={event.type}
                onChange={(e) =>
                  update(index, {
                    type: e.target.value as ProgressEvent["type"],
                  })
                }
              >
                {Object.entries(progressEventLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={`事件 ${index + 1} 说明${["pause", "milestone"].includes(event.type) ? "（必填）" : ""}`}
            >
              <input
                value={event.reason}
                maxLength={500}
                required={["pause", "milestone"].includes(event.type)}
                placeholder={
                  event.type === "pause"
                    ? "例如：临时支援客户上线"
                    : "可记录阶段成果或业务调整"
                }
                onChange={(e) => update(index, { reason: e.target.value })}
              />
            </Field>
            <button
              type="button"
              className="icon-button"
              aria-label={`删除事件 ${index + 1}`}
              onClick={() =>
                setEvents((value) => value.filter((_, i) => i !== index))
              }
            >
              <X size={17} />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={events.length >= 500}
          icon={<Plus size={15} />}
          onClick={() => {
            const last = events
              .filter((event) => event.type !== "milestone")
              .at(-1);
            const type = !last
              ? "start"
              : last.type === "pause"
                ? "resume"
                : last.type === "complete"
                  ? "reopen"
                  : "pause";
            setEvents([...events, { date: data.today, type, reason: "" }]);
          }}
        >
          添加时间事件
        </Button>
        {events.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setEvents(
                [...events].sort((a, b) => a.date.localeCompare(b.date)),
              )
            }
          >
            按日期排序
          </Button>
        )}
        <Field label="本次核查说明">
          <textarea
            required
            rows={2}
            minLength={2}
            maxLength={500}
            placeholder="例如：核对本周记录，补充临时支援和恢复日期"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </fieldset>
      {validation && (
        <p className="pp-validation" role="alert">
          {validation}
        </p>
      )}
      {metrics && (
        <div className="pp-preview-metrics">
          <span>
            跨度 <b>{countDays(metrics.elapsedDays)}</b>
          </span>
          <span>
            暂停 <b>{countDays(metrics.pausedDays)}</b>
          </span>
          <span>
            推进区间 <b>{countDays(metrics.activeDays)}</b>
          </span>
        </div>
      )}
      <ErrorBanner error={mutation.error} />
      <div className="pp-form-actions">
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={!!validation || note.trim().length < 2}
        >
          保存核查
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={() => setReloadOpen(true)}
        >
          重新载入
        </Button>
        <span className="pp-muted">
          版本 {baseVersion}
          {reviewId ? " · 关联当前周卡" : ""}
        </span>
      </div>
      {reloadOpen && (
        <div className="pp-notice">
          重新载入会丢弃未保存的修改。
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void onReload();
            }}
          >
            丢弃草稿并载入
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setReloadOpen(false)}
          >
            保留草稿
          </Button>
        </div>
      )}
      <details className="pp-history">
        <summary>核查历史（最近 20 次）</summary>
        {!data.history.length ? (
          <p>暂无核查记录。</p>
        ) : (
          data.history.map((item) => (
            <details key={item.version}>
              <summary>
                v{item.version} · {item.actorName} ·{" "}
                {timestamp(item.createdAt, data.timezone)}
                {item.reviewId ? " · 周卡核查" : ""}
              </summary>
              <p>{item.note}</p>
              <ul>
                {item.events.map((event, index) => (
                  <li key={index}>
                    {event.date} {progressEventLabels[event.type]}{" "}
                    {event.reason}
                  </li>
                ))}
              </ul>
            </details>
          ))
        )}
      </details>
    </form>
  );
}

export function ProjectProgress() {
  const [, navigate] = useLocation();
  const [memberId, setMemberId] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["project-progress", "calendar", month],
    queryFn: async () => {
      // The first response provides the authoritative current date in the team timezone.
      if (!month)
        return api<ProjectProgressResponse>("/v1/admin/project-progress");
      const last = addProgressDays(`${shiftCalendarMonth(month, 1)}-01`, -1);
      return api<ProjectProgressResponse>(
        `/v1/admin/project-progress?from=${month}-01&to=${last}`,
      );
    },
    refetchInterval: 60_000,
  });
  const data = query.data;
  const currentMonth = data?.today.slice(0, 7) ?? "";
  const shownMonth = month || currentMonth;
  const projects = [...(data?.projects ?? [])].sort((a, b) =>
    (b.latestProgress?.date ?? b.events.at(-1)?.date ?? "").localeCompare(
      a.latestProgress?.date ?? a.events.at(-1)?.date ?? "",
    ),
  );
  const keyOf = (p: ProgressProject) => `${p.partnerId}:${p.projectId}`;
  const groups = (data?.members ?? [])
    .map((member) => ({
      ...member,
      projects: projects.filter((project) => project.partnerId === member.id),
    }))
    .filter((member) => member.projects.length > 0);
  const activeMember =
    groups.find((member) => member.id === memberId) ?? groups[0];
  const memberProjects = activeMember?.projects ?? [];
  const selected =
    memberProjects.find((project) => keyOf(project) === selectedKey) ??
    memberProjects[0];
  const activeKey = selected ? keyOf(selected) : "";
  const activeMemberId = activeMember?.id ?? "";
  useEffect(() => {
    if (activeKey) setSelectedKey(activeKey);
    if (activeMemberId) setMemberId(activeMemberId);
  }, [activeKey, activeMemberId]);
  const visible = selected ? [selected] : [];
  const focusText =
    selected?.currentFocus?.text ||
    selected?.latestProgress?.summary ||
    "暂无已审核的工作进展。";
  const totalDays = selected?.contributionDays ?? 0;
  const memberName = (id: string) =>
    data?.members.find((m) => m.id === id)?.name ?? "";
  const dates = shownMonth ? calendarMonthDays(shownMonth) : [];
  const entriesFor = (date: string) =>
    visible.flatMap((project) => {
      const entries = project.days.find((d) => d.date === date)?.entries ?? [];
      const events = project.events.filter((event) => event.date === date);
      return entries.length || events.length
        ? [{ project, entries, events }]
        : [];
    });
  const openReview = (partnerId: string, reviewId: string) => {
    window.localStorage.setItem("partner-report-simulated-partner", partnerId);
    navigate(`/partner/review/${reviewId}`);
  };
  const goMonth = (offset: number) => {
    const target = shiftCalendarMonth(shownMonth, offset);
    setMonth(target === currentMonth ? "" : target);
  };
  return (
    <section className="pc-dashboard" aria-label="项目进展">
      <div className="pc-toolbar">
        <div>
          <h2>
            <CalendarDays size={20} />
            项目进展
          </h2>
          <p>按人员查看项目，依据已审核的工作内容统计研发日期和天数。</p>
        </div>
        <button
          type="button"
          className="icon-button"
          title="刷新项目进展"
          aria-label="刷新项目进展"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            size={17}
            className={query.isFetching ? "spin" : undefined}
          />
        </button>
      </div>
      <ErrorBanner error={query.error} />
      {!data ? (
        query.isLoading ? (
          <p role="status">加载项目日历…</p>
        ) : (
          <EmptyState
            title="项目日历暂不可用"
            action={<Button onClick={() => void query.refetch()}>重试</Button>}
          />
        )
      ) : (
        <div className="pc-workspace">
          <aside className="pc-people" aria-label="人员列表">
            <div className="pc-member-list">
              {groups.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  className={`pc-member-button ${member.id === activeMemberId ? "selected" : ""}`}
                  aria-pressed={member.id === activeMemberId}
                  aria-controls="pc-project-picker"
                  onClick={() => {
                    if (member.id !== activeMemberId) {
                      setMemberId(member.id);
                      setSelectedKey("");
                    }
                    setDay(null);
                  }}
                >
                  {member.name}
                </button>
              ))}
            </div>
            {!projects.length && (
              <p className="pc-empty">暂无已审核的项目进展</p>
            )}
          </aside>
          <div className="pc-main">
            {activeMember && (
              <div
                id="pc-project-picker"
                className="pc-project-picker"
                role="group"
                aria-label={`${activeMember.name}的项目`}
              >
                {memberProjects.map((project) => (
                  <button
                    type="button"
                    key={keyOf(project)}
                    className={`pc-project-choice ${project === selected ? "selected" : ""}`}
                    aria-pressed={project === selected}
                    aria-controls="pc-selected-project"
                    aria-label={`查看 ${activeMember.name} 的 ${project.projectName}`}
                    onClick={() => {
                      setSelectedKey(keyOf(project));
                      setDay(null);
                    }}
                  >
                    {project.projectName}
                  </button>
                ))}
              </div>
            )}
            <div
              key={activeKey}
              className="pc-content"
              role="region"
              aria-label="项目内容"
              tabIndex={0}
            >
              {selected && (
                <section
                  key={activeKey}
                  id="pc-selected-project"
                  className="pc-project-overview"
                  aria-label="当前项目进度"
                >
                  <div className="pc-project-title">
                    <h3>{selected.projectName}</h3>
                    <span className="pc-project-days" aria-label="累计研发天数">
                      已开发 <strong>{totalDays}</strong> 天
                    </span>
                  </div>
                  <div className="pc-focus">
                    <div className="pc-focus-heading">
                      <strong>当前重点</strong>
                    </div>
                    <p className="pc-latest">{focusText}</p>
                  </div>
                  <p className="pc-project-description">
                    {selected.projectDescription?.trim() || "暂无项目说明"}
                  </p>
                  {selected.keyEvents.length > 0 && (
                    <section className="pc-key-events" aria-label="项目时间线">
                      <div className="pc-key-events-heading">
                        <strong>项目进展</strong>
                      </div>
                      <div className="pc-key-events-list">
                        {selected.keyEvents.map((event) => (
                          <article
                            className={`pc-key-event pc-key-event-${event.type}`}
                            key={`${activeKey}:${event.date}:${event.title}:${event.detail}`}
                          >
                            <div className="pc-event-heading">
                              <time dateTime={event.date}>{event.date}</time>
                              <span className="pc-event-type">
                                {keyEventTypeLabels[event.type]}
                              </span>
                              <strong>{event.title}</strong>
                            </div>
                            <p>{event.detail}</p>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                  <p className="pc-count-note">
                    研发天数按已审核工作内容的日期统计，同一天多条记录计 1 天。
                  </p>
                  {selected.undatedCount > 0 && (
                    <p className="pc-count-note">
                      另有 {selected.undatedCount}{" "}
                      条记录缺少有效日期，未计入研发天数。
                    </p>
                  )}
                </section>
              )}
              {selected && (
                <section className="pc-calendar" aria-label="研发日历">
                  <div className="pc-month-nav">
                    <h3>
                      研发日历
                      <span className="pc-calendar-month">
                        {shownMonth.slice(0, 4)} 年{" "}
                        {Number(shownMonth.slice(5))} 月
                      </span>
                    </h3>
                    <div>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="上个月"
                        onClick={() => goMonth(-1)}
                      >
                        <ChevronLeft size={18} />
                      </button>
                      <button
                        type="button"
                        className="pc-text-button"
                        onClick={() => setMonth("")}
                      >
                        本月
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="下个月"
                        disabled={shownMonth >= currentMonth}
                        onClick={() => goMonth(1)}
                      >
                        <ChevronRight size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="pc-weekdays" aria-hidden="true">
                    {[
                      "周一",
                      "周二",
                      "周三",
                      "周四",
                      "周五",
                      "周六",
                      "周日",
                    ].map((name) => (
                      <span key={name}>{name}</span>
                    ))}
                  </div>
                  <div className="pc-month-grid">
                    {dates.map((date) => {
                      const inside = date.startsWith(shownMonth);
                      const entries = inside ? entriesFor(date) : [];
                      return (
                        <div
                          key={date}
                          className={`pc-day ${inside ? "" : "outside"} ${date === data.today ? "today" : ""}`}
                        >
                          <button
                            type="button"
                            className="pc-day-number"
                            disabled={!inside || date > data.today}
                            aria-label={`查看 ${date} 的进展`}
                            onClick={() => setDay(date)}
                          >
                            <time dateTime={date}>
                              {Number(date.slice(-2))}
                            </time>
                            {date === data.today && <small>今天</small>}
                          </button>
                          <div className="pc-day-entries">
                            {entries.map(
                              ({ project, entries: workEntries }) => (
                                <button
                                  key={keyOf(project)}
                                  type="button"
                                  className={`pc-calendar-entry pc-color-${Math.max(0, projects.indexOf(project)) % 5}`}
                                  onClick={() => setDay(date)}
                                  title={
                                    workEntries.length
                                      ? project.projectName
                                      : "历史时间记录，不计入研发天数"
                                  }
                                  aria-label={`${project.projectName} ${date} 的进展`}
                                >
                                  <strong>
                                    {workEntries.length
                                      ? project.projectName
                                      : "时间记录"}
                                  </strong>
                                </button>
                              ),
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}
      {data && day && (
        <ProgressDialog
          title={`${day} · 项目进展`}
          onClose={() => setDay(null)}
        >
          {entriesFor(day).length === 0 && (
            <EmptyState title="这一天暂无已审核的每日进展" />
          )}
          {entriesFor(day).map(({ project, entries, events }) => (
            <section className="pc-day-detail" key={keyOf(project)}>
              <h3>{project.projectName}</h3>
              <span className="pp-muted">{memberName(project.partnerId)}</span>
              {events.map((event, index) => (
                <p key={index} className="pp-detail-event">
                  <Flag size={15} />
                  <strong>{progressEventLabels[event.type]}</strong>
                  {event.reason}
                </p>
              ))}
              {entries.map((entry) => (
                <article className="pp-entry" key={entry.id}>
                  <p>{entry.summary}</p>
                  <small>来自已审核周卡 · 每日进展</small>
                  {entry.reviewId &&
                    data.members.some(
                      (member) =>
                        member.id === project.partnerId &&
                        member.status === "active",
                    ) && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          openReview(project.partnerId, entry.reviewId!)
                        }
                      >
                        查看周卡
                      </Button>
                    )}
                </article>
              ))}
            </section>
          ))}
        </ProgressDialog>
      )}
    </section>
  );
}
