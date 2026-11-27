import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Plus, X } from "lucide-react";
import {
  addProgressDays,
  calculateProgress,
  progressEventLabels,
  validateProgressEvents,
  type ParticipationResponse,
  type ProgressEvent,
} from "@partner-report/contracts/project-progress";
import { api } from "./api.js";
import { Button, ErrorBanner, Field } from "./components.js";
import "./project-progress.css";

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
      await client.invalidateQueries({ queryKey: ["participation"] });
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
