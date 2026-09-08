import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  addProgressDays,
  calculateProgress,
  currentProjectStage,
  projectStages,
  type ProjectStage,
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
import {
  calendarMonthDays,
  calendarExcerpt,
  shiftCalendarMonth,
} from "./project-calendar.js";

const stateLabels = {
  unknown: "时间待核查",
  active: "推进中",
  paused: "已暂停",
  completed: "已完成",
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

function StageEditor({
  project,
  onClose,
}: {
  project: ProgressProject;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const path = `/v1/project-progress/participations/${project.partnerId}/${project.projectId}`;
  const query = useQuery({
    queryKey: ["participation", project.partnerId, project.projectId],
    queryFn: () => api<ParticipationResponse>(path),
    refetchOnWindowFocus: false,
  });
  const existing = currentProjectStage(project.events);
  const [stage, setStage] = useState<ProjectStage>(
    existing && existing !== "completed" ? existing : "development",
  );
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: () => {
      const data = query.data!;
      return api(path, {
        method: "POST",
        body: JSON.stringify({
          baseVersion: data.version,
          events: [
            ...data.events,
            {
              date: data.today,
              type: "milestone",
              stage,
              reason: reason.trim() || `当前阶段：${projectStages[stage]}`,
            },
          ],
          note: `确认项目阶段：${projectStages[stage]}`,
        }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["project-progress"] }),
        client.invalidateQueries({ queryKey: ["participation"] }),
      ]);
      onClose();
    },
  });
  return (
    <ProgressDialog title="更新项目阶段" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <p>{project.projectName}</p>
        <Field label="当前阶段">
          <select
            aria-label="当前阶段"
            value={stage}
            onChange={(event) => setStage(event.target.value as ProjectStage)}
          >
            {Object.entries(projectStages).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="最近完成了什么">
          <textarea
            rows={3}
            maxLength={500}
            placeholder="例如：核心功能已完成，正在进行接口联调"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <ErrorBanner error={query.error ?? mutation.error} />
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={
            !query.isFetchedAfterMount ||
            !query.data ||
            !!query.error ||
            currentProjectStage(query.data.events) === "completed"
          }
        >
          保存阶段
        </Button>
        {!!mutation.error && (
          <p className="pp-muted">
            若记录已被更新，请关闭后重新打开，再确认阶段。
          </p>
        )}
      </form>
    </ProgressDialog>
  );
}

export function ProjectProgress() {
  const [, navigate] = useLocation();
  const [memberId, setMemberId] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [editingStage, setEditingStage] = useState(false);
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
  const projects = (data?.projects ?? [])
    .filter((p) => !memberId || p.partnerId === memberId)
    .sort((a, b) =>
      (b.latestProgress?.date ?? b.events.at(-1)?.date ?? "").localeCompare(
        a.latestProgress?.date ?? a.events.at(-1)?.date ?? "",
      ),
    );
  const keyOf = (p: ProgressProject) => `${p.partnerId}:${p.projectId}`;
  const selected = projects.find((p) => keyOf(p) === selectedKey);
  const visible = selected ? [selected] : projects;
  const memberName = (id: string) =>
    data?.members.find((m) => m.id === id)?.name ?? "";
  const dates = shownMonth ? calendarMonthDays(shownMonth) : [];
  const phase = selected ? currentProjectStage(selected.events) : null;
  const stageIndex =
    phase === "completed"
      ? 4
      : phase
        ? Object.keys(projectStages).indexOf(phase)
        : -1;
  const latestStage = selected?.events.filter((event) => event.stage).at(-1);
  const phaseLabel = (p: ProgressProject) => {
    if (p.metrics.state === "paused") return "暂停中";
    const phase = currentProjectStage(p.events);
    return phase === "completed" ? "已完成" : phase ? projectStages[phase] : "";
  };
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
    <section className="pc-dashboard" aria-label="项目日历">
      <div className="pc-toolbar">
        <div>
          <h2>
            <CalendarDays size={20} />
            项目日历
          </h2>
          <p>看每天做了什么，也看项目走到了哪一步。</p>
        </div>
        <select
          aria-label="成员"
          value={memberId}
          onChange={(event) => {
            setMemberId(event.target.value);
            setSelectedKey("");
          }}
        >
          {<option value="">全部成员</option>}
          {data?.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
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
          <aside className="pc-projects" aria-label="项目列表">
            <button
              type="button"
              className={`pc-all ${!selected ? "selected" : ""}`}
              onClick={() => setSelectedKey("")}
            >
              <span>全部项目</span>
              <small>{projects.length}</small>
            </button>
            <div className="pc-project-list">
              {projects.map((project, index) => (
                <button
                  key={keyOf(project)}
                  type="button"
                  className={`pc-project ${selected === project ? "selected" : ""}`}
                  onClick={() => setSelectedKey(keyOf(project))}
                  aria-label={`查看 ${memberName(project.partnerId)} 的 ${project.projectName}`}
                >
                  <span className={`pc-project-owner pc-color-${index % 5}`}>
                    {memberName(project.partnerId)}
                  </span>
                  <strong>{project.projectName}</strong>
                  <span className="pc-project-summary">
                    {calendarExcerpt(
                      project.latestProgress?.summary ??
                        "还没有可展示的项目进展",
                      55,
                    )}
                  </span>
                  <span className="pc-project-meta">
                    {phaseLabel(project) && <span>{phaseLabel(project)}</span>}
                    <time>
                      {project.latestProgress?.date.slice(5).replace("-", "/")}
                    </time>
                  </span>
                </button>
              ))}
            </div>
            {!projects.length && (
              <p className="pc-empty">暂无已审核的项目进展</p>
            )}
          </aside>
          <div className="pc-main">
            {selected && (
              <section
                className="pc-project-overview"
                aria-label="当前项目进度"
              >
                <div className="pc-project-title">
                  <div>
                    <span>{memberName(selected.partnerId)}</span>
                    <h3>{selected.projectName}</h3>
                  </div>
                  <Button variant="ghost" onClick={() => setDetails(true)}>
                    项目详情
                  </Button>
                </div>
                <div className="pc-phase-heading">
                  <strong>
                    {selected.metrics.state === "paused"
                      ? "项目暂停中"
                      : phase
                        ? `当前：${phase === "completed" ? "已完成" : projectStages[phase]}`
                        : "阶段未设置"}
                  </strong>
                  {phase !== "completed" && (
                    <button
                      type="button"
                      className="pc-text-button"
                      onClick={() => setEditingStage(true)}
                    >
                      {phase ? "调整阶段" : "设置阶段"}
                    </button>
                  )}
                </div>
                <ol className="pc-stages" aria-label="项目阶段">
                  {[...Object.values(projectStages), "完成"].map(
                    (label, index) => (
                      <li
                        key={label}
                        className={`${index < stageIndex ? "passed" : ""} ${index === stageIndex ? "current" : ""}`}
                        aria-current={index === stageIndex ? "step" : undefined}
                      >
                        <span>
                          {index < stageIndex ? <Check size={12} /> : index + 1}
                        </span>
                        {label}
                      </li>
                    ),
                  )}
                </ol>
                <p className="pc-latest">
                  {calendarExcerpt(
                    latestStage &&
                      latestStage.date >= (selected.latestProgress?.date ?? "")
                      ? latestStage.reason
                      : (selected.latestProgress?.summary ??
                          "选择当前阶段，让团队知道项目走到了哪一步。"),
                    180,
                  )}
                </p>
              </section>
            )}
            <section className="pc-calendar" aria-label="月历">
              <div className="pc-month-nav">
                <h3>
                  {shownMonth.slice(0, 4)} 年 {Number(shownMonth.slice(5))} 月
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
                {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
                  (name) => (
                    <span key={name}>{name}</span>
                  ),
                )}
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
                        <time dateTime={date}>{Number(date.slice(-2))}</time>
                        {date === data.today && <small>今天</small>}
                      </button>
                      {entries.slice(0, 4).map(({ project }) => (
                        <button
                          key={keyOf(project)}
                          type="button"
                          className={`pc-calendar-entry pc-color-${Math.max(0, projects.indexOf(project)) % 5}`}
                          onClick={() => setDay(date)}
                          title={project.projectName}
                          aria-label={`${project.projectName} ${date} 的进展`}
                        >
                          <strong>{project.projectName}</strong>
                        </button>
                      ))}
                      {entries.length > 4 && (
                        <button
                          type="button"
                          className="pc-more"
                          onClick={() => setDay(date)}
                        >
                          还有 {entries.length - 4} 个项目
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
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
              <button
                type="button"
                className="pc-text-button"
                onClick={() => {
                  setSelectedKey(keyOf(project));
                  setDay(null);
                }}
              >
                查看项目整体进展
              </button>
            </section>
          ))}
        </ProgressDialog>
      )}
      {data && selected && details && (
        <ProgressDialog
          title={`${selected.projectName} · 项目详情`}
          onClose={() => setDetails(false)}
        >
          <p>{memberName(selected.partnerId)}</p>
          <p>{selected.latestProgress?.summary ?? "暂无进展摘要"}</p>
          <div className="pp-preview-metrics">
            <span>
              项目跨度 <b>{countDays(selected.metrics.elapsedDays)}</b>
            </span>
            <span>
              暂停 <b>{countDays(selected.metrics.pausedDays)}</b>
            </span>
            <span>
              贡献记录 <b>{selected.contributionDays} 天</b>
            </span>
          </div>
          <p className="pp-muted">
            项目跨度按确认的开始和完成日期计算，包含首尾及周末。并行项目分别统计，不相加为个人工时。
          </p>
          {selected.conflictingDays.length > 0 && (
            <p className="pp-notice">
              有 {selected.conflictingDays.length}{" "}
              天的贡献不在确认的推进区间内，可在时间记录中核对。
            </p>
          )}
          <ParticipationEditor
            partnerId={selected.partnerId}
            projectId={selected.projectId}
            projectName={selected.projectName}
          />
          <details className="pp-history">
            <summary>时间记录与里程碑</summary>
            {selected.events.map((event, index) => (
              <p key={index}>
                {event.date} · {progressEventLabels[event.type]} ·{" "}
                {event.reason}
              </p>
            ))}
            {!selected.events.length && <p>暂无时间记录</p>}
          </details>
        </ProgressDialog>
      )}
      {selected && editingStage && (
        <StageEditor
          project={selected}
          onClose={() => setEditingStage(false)}
        />
      )}
    </section>
  );
}
