import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  FileText,
  LoaderCircle,
  Monitor,
  Package,
  RefreshCw,
  RotateCw,
  TerminalSquare,
  UserRound,
  Users,
} from "lucide-react";
import { Link, useSearchParams } from "wouter";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner } from "./components.js";
import { WorkspaceHeader } from "./admin-workspace.js";
import {
  DetailList,
  LogWindowToolbar,
  collectorCodeLabels,
  collectorStageLabels,
  dateKeyInTimezone,
  detailEntries,
  formatTime,
  levelLabel,
  levelTone,
  severityTone,
  type Severity,
} from "./monitoring-common.js";
import "./monitoring.css";

type Member = {
  partnerId: string;
  name: string;
  devices: Array<{
    id: string;
    deviceName: string;
    version: string;
    lastLogAt: string | null;
    lastUploadAt: string | null;
  }>;
  appVersion: string | null;
  online: boolean;
  lastLogAt: string | null;
  lastUploadAt: string | null;
  errorCount: number;
  severity: Severity;
};

type UserLogMembers = {
  checkedAt: string;
  onlineWindowMinutes: number;
  windowHours: number;
  members: Member[];
};

type ClientState = {
  startupStage: string;
  projectCount: number;
  allowedProjectCount: number;
  sessionCount: number;
  unreadableSessionCount: number;
  pendingSessionCount: number;
  isScanning: boolean;
  isUploading: boolean;
  scanProcessed: number;
  scanTotal: number;
  uploadProcessed: number;
  uploadTotal: number;
  autoUpload: boolean;
  frequency: string;
  uploadHour: number;
  uploadMinute: number;
  uploadWeekday: number | null;
};

type UserLogDevice = {
  id: string;
  deviceName: string;
  version: string;
  lastLogAt: string | null;
  lastUploadAt: string | null;
  clientState: ClientState | null;
  stateObservedAt: string | null;
  online: boolean;
  notificationCode: string | null;
};

type UserLogEvent = {
  eventId: string;
  deviceId: string;
  deviceName: string;
  occurredAt: string;
  receivedAt: string;
  stage: string;
  level: "info" | "warning" | "error";
  code: string;
  uploadId: string | null;
  sessionCount: number;
  message: string | null;
  details: Record<string, unknown>;
};

type UserLogUpload = {
  id: string;
  device_name: string;
  period_key: string;
  period_id: string;
  session_count: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  analysis_total: number;
  analysis_completed: number;
  analysis_ignored: number;
  analysis_failed: number;
  analysis_retrying: number;
  error_code: string | null;
  card_error_code: string | null;
  report_error_code: string | null;
  next_retry_at: string | null;
  stage: string;
  label: string;
  tone: "success" | "danger" | "warning" | "neutral";
  review_id: string | null;
  pending_cards: number;
  approved_cards: number;
  report_id: string | null;
  cutoff_at: string | null;
};

type UserLogDetail = {
  partner: { id: string; name: string };
  window: {
    mode: "recent" | "day";
    date: string | null;
    timezone: string;
    startedAt: string;
    endedAt: string;
  };
  devices: UserLogDevice[];
  events: UserLogEvent[];
  uploads: UserLogUpload[];
};

const severityText: Record<Severity, string> = {
  normal: "正常",
  warning: "日志或会话包接收延迟",
  critical: "运行异常",
  unknown: "尚无日志",
};

const startupStageLabel: Record<string, string> = {
  binding: "等待绑定",
  permissions: "等待项目授权",
  welcome: "欢迎页",
  scanning: "首次扫描中",
  ready: "已就绪",
};

const notificationLabel: Record<string, string> = {
  NOTIFICATIONS_ALLOWED: "已允许",
  NOTIFICATIONS_DENIED: "未开启",
  NOTIFICATIONS_NOT_CONFIGURED: "尚未授权",
};

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

function uploadPlan(state: ClientState) {
  if (!state.autoUpload) return "已暂停";
  const when = `${String(state.uploadHour).padStart(2, "0")}:${String(state.uploadMinute).padStart(2, "0")}`;
  return state.frequency === "daily"
    ? `每天 ${when}`
    : `每周${weekdays[(state.uploadWeekday ?? 6) - 1]} ${when}`;
}

function activity(state: ClientState) {
  if (state.isScanning)
    return `扫描中 ${state.scanProcessed}/${state.scanTotal}`;
  if (state.isUploading)
    return `上传中 ${state.uploadProcessed}/${state.uploadTotal}`;
  return "空闲";
}

export function UserLogsPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const requested = params.get("partnerId");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [view, setView] = useState<"recent" | "history">("recent");
  const [historyDate, setHistoryDate] = useState(() =>
    dateKeyInTimezone("Asia/Shanghai"),
  );
  const [level, setLevel] = useState("");
  const [stage, setStage] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [mobileDetail, setMobileDetail] = useState(requested !== null);

  const members = useQuery({
    queryKey: ["admin-user-logs"],
    queryFn: () => api<UserLogMembers>("/v1/admin/user-logs"),
    refetchInterval: autoRefresh ? 10_000 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const list = members.data?.members ?? [];
  const selected = requested
    ? list.find((member) => member.partnerId === requested)
    : list[0];
  const requestedMissing = Boolean(requested && members.data && !selected);

  const detailParams = new URLSearchParams();
  if (view === "history") detailParams.set("date", historyDate);
  if (level) detailParams.set("level", level);
  if (stage) detailParams.set("stage", stage);
  if (deviceId) detailParams.set("deviceId", deviceId);
  const detail = useQuery({
    queryKey: [
      "admin-user-log",
      selected?.partnerId,
      view,
      view === "history" ? historyDate : null,
      level,
      stage,
      deviceId,
    ],
    queryFn: () =>
      api<UserLogDetail>(
        `/v1/admin/user-logs/${selected!.partnerId}?${detailParams}`,
      ),
    enabled: Boolean(selected),
    // Filters may keep the previous result on screen, a different member never may.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === selected?.partnerId ? previous : undefined,
    refetchInterval: autoRefresh && view === "recent" ? 10_000 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const data =
    detail.data && detail.data.partner.id === selected?.partnerId
      ? detail.data
      : undefined;

  useEffect(() => {
    setDeviceId("");
  }, [selected?.partnerId]);

  const retry = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/admin/collector-uploads/${id}/retry`, { method: "POST" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-user-log"] }),
  });
  const generate = useMutation({
    mutationFn: (periodId: string) =>
      api("/v1/admin/team-reports/generate", {
        method: "POST",
        body: JSON.stringify({ periodId }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-user-log"] }),
  });

  const selectMember = (partnerId: string) => {
    setParams({ partnerId });
    setMobileDetail(true);
  };
  const timezone = data?.window.timezone ?? "Asia/Shanghai";
  const today = dateKeyInTimezone(timezone);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-user-logs"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-user-log"] });
  };

  return (
    <div className="page admin-page monitoring-page user-logs-page">
      <WorkspaceHeader
        title="用户日志"
        icon={UserRound}
        context="按成员查看 App 的运行状态、会话包上传批次与运行日志"
      >
        <div className="sm-refresh-time">
          <span className={`sm-live-dot ${autoRefresh ? "" : "is-paused"}`} />
          <span>
            {members.isError
              ? "状态更新失败"
              : members.data
                ? `更新于 ${formatTime(members.data.checkedAt)}`
                : "等待成员状态"}
          </span>
        </div>
        <label className="sm-check">
          <input
            type="checkbox"
            role="switch"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          自动刷新
        </label>
        <button
          className="icon-button"
          title="刷新用户日志"
          disabled={members.isFetching}
          onClick={refresh}
        >
          <RefreshCw size={17} className={members.isFetching ? "spin" : ""} />
        </button>
      </WorkspaceHeader>
      <ErrorBanner error={members.error ?? retry.error ?? generate.error} />
      <section className="aw-view sm-view">
        <div
          className={`sm-log-workspace ${mobileDetail ? "sm-show-detail" : ""}`}
        >
          <div className="sm-records" aria-label="成员列表">
            <div className="sm-section-heading">
              <h2>
                <Users size={16} />
                成员 <span>{list.length}</span>
              </h2>
              <span>
                {members.data ? `${members.data.windowHours} 小时内错误` : ""}
              </span>
            </div>
            <div className="sm-record-scroll">
              {list.length ? (
                <ul className="sm-member-list">
                  {list.map((member) => (
                    <li
                      key={member.partnerId}
                      className={
                        member.partnerId === selected?.partnerId
                          ? "is-selected"
                          : ""
                      }
                    >
                      <button
                        className="sm-member-button"
                        aria-pressed={member.partnerId === selected?.partnerId}
                        onClick={() => selectMember(member.partnerId)}
                      >
                        <span className="sm-member-title">
                          <strong>{member.name}</strong>
                          <Badge tone={member.online ? "success" : "neutral"}>
                            {member.online ? "在线" : "离线"}
                          </Badge>
                        </span>
                        <span className="sm-member-meta">
                          {member.devices
                            .map((device) => device.deviceName)
                            .join("、")}
                          {member.appVersion
                            ? ` · App ${member.appVersion}`
                            : ""}
                        </span>
                        <span className="sm-member-meta">
                          最近上传{" "}
                          {formatTime(
                            member.lastUploadAt,
                            undefined,
                            "尚未上传",
                          )}
                        </span>
                        <span className="sm-member-status">
                          <Badge tone={severityTone[member.severity]}>
                            {severityText[member.severity]}
                          </Badge>
                          <small>
                            {member.errorCount > 0
                              ? `${member.errorCount} 条错误`
                              : "无错误"}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : members.isLoading ? (
                <div className="sm-loading" role="status">
                  <LoaderCircle size={18} className="spin" />
                  加载成员
                </div>
              ) : (
                <EmptyState
                  title={
                    members.isError
                      ? "成员暂时无法加载"
                      : "暂无已绑定 App 的成员"
                  }
                />
              )}
            </div>
          </div>
          <section className="sm-detail" aria-label="成员日志详情">
            <button
              className="sm-text-button sm-back"
              onClick={() => setMobileDetail(false)}
            >
              <ArrowLeft size={15} />
              返回成员列表
            </button>
            {requestedMissing ? (
              <EmptyState title="该成员没有可用的 App 设备" />
            ) : !selected ? (
              <EmptyState
                title={members.isLoading ? "等待成员" : "暂无可查看的成员"}
              />
            ) : (
              <>
                <header className="sm-detail-header">
                  <div>
                    <span className="sm-kicker">成员日志</span>
                    <h2>{selected.name}</h2>
                  </div>
                  <Badge tone={severityTone[selected.severity]}>
                    {severityText[selected.severity]}
                  </Badge>
                </header>
                <div className="sm-log-query">
                  <LogWindowToolbar
                    view={view}
                    onView={setView}
                    date={historyDate}
                    onDate={setHistoryDate}
                    today={today}
                    timezone={timezone}
                    fetching={detail.isFetching}
                    onRefresh={() => void detail.refetch()}
                    dateLabel="用户历史日志日期"
                    refreshTitle="刷新成员日志"
                  />
                </div>
                <ErrorBanner error={detail.error} />
                {!data ? (
                  <div className="sm-loading" role="status">
                    {detail.isError ? (
                      "成员日志加载失败，请刷新重试"
                    ) : (
                      <>
                        <LoaderCircle size={18} className="spin" />
                        加载成员日志
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    <section aria-label="设备状态">
                      <div className="sm-section-heading">
                        <h3>
                          <Monitor size={16} />
                          设备状态 <span>{data.devices.length}</span>
                        </h3>
                      </div>
                      <div className="sm-device-grid">
                        {data.devices.map((device) => (
                          <DeviceCard
                            key={device.id}
                            device={device}
                            timezone={timezone}
                          />
                        ))}
                      </div>
                    </section>
                    <section aria-label="上传批次">
                      <div className="sm-section-heading">
                        <h3>
                          <Package size={16} />
                          上传批次 <span>{data.uploads.length}</span>
                        </h3>
                      </div>
                      {data.uploads.length ? (
                        <div
                          className="sm-table-scroll"
                          role="region"
                          aria-label="上传批次表格"
                          tabIndex={0}
                        >
                          <table className="sm-table sm-upload-table">
                            <colgroup>
                              {[144, 64, 112, 208, 156, 120, 180, 96].map(
                                (width, index) => (
                                  <col key={index} style={{ width }} />
                                ),
                              )}
                            </colgroup>
                            <thead>
                              <tr>
                                <th>采集周期</th>
                                <th>会话数</th>
                                <th>接收状态</th>
                                <th>处理进度</th>
                                <th>审核 / 周报</th>
                                <th>操作</th>
                                <th>创建 / 完成</th>
                                <th>批次</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.uploads.map((upload) => (
                                <UploadRow
                                  key={upload.id}
                                  upload={upload}
                                  timezone={timezone}
                                  retrying={retry.isPending}
                                  generating={generate.isPending}
                                  onRetry={() => retry.mutate(upload.id)}
                                  onGenerate={() =>
                                    generate.mutate(upload.period_id)
                                  }
                                />
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <EmptyState title="暂无会话包" />
                      )}
                    </section>
                    <section aria-label="运行日志">
                      <div className="sm-section-heading sm-timeline-heading">
                        <h3>
                          <TerminalSquare size={16} />
                          运行日志 <span>{data.events.length}</span>
                        </h3>
                        <div className="sm-filters">
                          <label className="sm-select">
                            <span>级别</span>
                            <select
                              aria-label="日志级别"
                              value={level}
                              onChange={(event) => setLevel(event.target.value)}
                            >
                              <option value="">全部级别</option>
                              {Object.entries(levelLabel).map(
                                ([key, label]) => (
                                  <option key={key} value={key}>
                                    {label}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label className="sm-select">
                            <span>阶段</span>
                            <select
                              aria-label="日志阶段"
                              value={stage}
                              onChange={(event) => setStage(event.target.value)}
                            >
                              <option value="">全部阶段</option>
                              {Object.entries(collectorStageLabels).map(
                                ([key, label]) => (
                                  <option key={key} value={key}>
                                    {label}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          {data.devices.length > 1 && (
                            <label className="sm-select">
                              <span>设备</span>
                              <select
                                aria-label="日志设备"
                                value={deviceId}
                                onChange={(event) =>
                                  setDeviceId(event.target.value)
                                }
                              >
                                <option value="">全部设备</option>
                                {data.devices.map((device) => (
                                  <option key={device.id} value={device.id}>
                                    {device.deviceName}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      </div>
                      <div className="sm-events">
                        {data.events.length ? (
                          data.events.map((event) => (
                            <UserLogEventItem
                              key={`${event.deviceId}:${event.eventId}`}
                              event={event}
                              timezone={timezone}
                            />
                          ))
                        ) : (
                          <EmptyState
                            title={
                              level || stage || deviceId
                                ? "没有符合条件的日志"
                                : view === "recent"
                                  ? "最近 24 小时没有 App 日志"
                                  : "这一天没有 App 日志"
                            }
                          />
                        )}
                      </div>
                    </section>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function DeviceCard({
  device,
  timezone,
}: {
  device: UserLogDevice;
  timezone: string;
}) {
  const state = device.clientState;
  return (
    <article
      className="sm-device-card"
      aria-label={`设备 ${device.deviceName}`}
    >
      <header>
        <strong>{device.deviceName}</strong>
        <small>App {device.version}</small>
        <Badge tone={device.online ? "success" : "neutral"}>
          {device.online ? "在线" : "离线"}
        </Badge>
      </header>
      <DetailList
        entries={[
          ["最近日志到达", formatTime(device.lastLogAt, timezone, "尚未收到")],
          [
            "最近整批上传",
            formatTime(device.lastUploadAt, timezone, "尚未上传"),
          ],
          [
            "通知权限",
            device.notificationCode
              ? (notificationLabel[device.notificationCode] ??
                device.notificationCode)
              : "未上报",
          ],
          ...(state
            ? ([
                [
                  "启动阶段",
                  startupStageLabel[state.startupStage] ?? state.startupStage,
                ],
                [
                  "项目 / 已允许",
                  `${state.projectCount} / ${state.allowedProjectCount}`,
                ],
                ["会话", state.sessionCount],
                ["无法读取", state.unreadableSessionCount],
                ["待上传", state.pendingSessionCount],
                ["扫描 / 上传进度", activity(state)],
                ["自动上传计划", uploadPlan(state)],
                [
                  "状态上报时间",
                  formatTime(device.stateObservedAt, timezone, "尚未上报"),
                ],
              ] as Array<[string, string | number]>)
            : ([["客户端状态", "等待 App 上报"]] as Array<[string, string]>)),
        ]}
      />
    </article>
  );
}

function UploadRow({
  upload,
  timezone,
  retrying,
  generating,
  onRetry,
  onGenerate,
}: {
  upload: UserLogUpload;
  timezone: string;
  retrying: boolean;
  generating: boolean;
  onRetry: () => void;
  onGenerate: () => void;
}) {
  const test = upload.stage === "test";
  const errorCode =
    upload.error_code ?? upload.card_error_code ?? upload.report_error_code;
  return (
    <tr>
      <td>
        {upload.period_key}
        <small>{upload.device_name}</small>
      </td>
      <td>{upload.session_count}</td>
      <td>
        <Badge
          tone={
            upload.status === "completed"
              ? "success"
              : upload.status === "superseded"
                ? "neutral"
                : "warning"
          }
        >
          {upload.status === "completed"
            ? "整批已确认"
            : upload.status === "superseded"
              ? "已被新包替代"
              : "分包接收中"}
        </Badge>
      </td>
      <td>
        <Badge tone={upload.tone ?? "neutral"}>
          {upload.label ?? "等待分析"}
        </Badge>
        <small>
          已分析 {upload.analysis_completed ?? 0} /{" "}
          {upload.analysis_total ?? upload.session_count}，忽略{" "}
          {upload.analysis_ignored ?? 0}
        </small>
        {!test && errorCode && <small>{errorCode}</small>}
        {!test && upload.next_retry_at && (
          <small>下次重试 {formatTime(upload.next_retry_at, timezone)}</small>
        )}
      </td>
      <td>
        {test ? (
          "仅保留历史查看"
        ) : upload.review_id ? (
          <Link href="/admin/reviews">
            待审核 {upload.pending_cards} · 已确认 {upload.approved_cards}
          </Link>
        ) : (
          "尚无卡片"
        )}
        {!test &&
          (upload.report_id ? (
            <small>
              <Link href={`/admin/reports?report=${upload.report_id}`}>
                查看周报
              </Link>
            </small>
          ) : (
            <small>汇总时间 {formatTime(upload.cutoff_at, timezone)}</small>
          ))}
      </td>
      <td>
        {(upload.analysis_failed > 0 ||
          upload.analysis_retrying > 0 ||
          [
            "cards_failed",
            "cards_retrying",
            "report_failed",
            "report_retrying",
          ].includes(upload.stage)) && (
          <Button
            variant="ghost"
            icon={<RotateCw size={14} />}
            loading={retrying}
            onClick={onRetry}
          >
            重试处理
          </Button>
        )}
        {upload.stage === "reviewed" && (
          <Button
            variant="ghost"
            icon={<FileText size={14} />}
            loading={generating}
            onClick={onGenerate}
          >
            汇总周报
          </Button>
        )}
      </td>
      <td>
        {formatTime(upload.created_at, timezone)}
        <small>{formatTime(upload.completed_at, timezone)}</small>
      </td>
      <td>
        <code title={upload.id}>{upload.id.slice(0, 8)}</code>
      </td>
    </tr>
  );
}

function UserLogEventItem({
  event,
  timezone,
}: {
  event: UserLogEvent;
  timezone: string;
}) {
  const details = { ...event.details };
  if (event.message) delete details.message;
  const entries: Array<[string, string]> = [
    ["设备", event.deviceName],
    ["发生时间", formatTime(event.occurredAt, timezone)],
    ["到达时间", formatTime(event.receivedAt, timezone)],
    ...(event.uploadId
      ? ([["关联批次", event.uploadId]] as Array<[string, string]>)
      : []),
    ...(event.sessionCount > 0
      ? ([["会话数", String(event.sessionCount)]] as Array<[string, string]>)
      : []),
    ...detailEntries(details, timezone),
  ];
  return (
    <details
      className={`sm-event sm-event-${event.level}`}
      open={event.level === "error"}
    >
      <summary>
        <span className="sm-event-icon">
          {event.level === "info" ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
        </span>
        <span className="sm-event-title">
          <strong>{collectorCodeLabels[event.code] ?? event.code}</strong>
          <small>
            {collectorStageLabels[event.stage] ?? event.stage} ·{" "}
            {event.deviceName}
          </small>
        </span>
        <span className="sm-event-time">
          <Badge tone={levelTone(event.level)}>{levelLabel[event.level]}</Badge>
          <time dateTime={event.occurredAt}>
            {formatTime(event.occurredAt, timezone)}
          </time>
        </span>
        <ChevronRight size={14} />
      </summary>
      <div className="sm-event-body">
        {event.message && <p>{event.message}</p>}
        <DetailList entries={entries} />
      </div>
    </details>
  );
}
