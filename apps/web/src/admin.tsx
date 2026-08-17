import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
import { selectCurrentOpenPeriod } from "./period-selection.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
  SuccessBanner,
} from "./components.js";

type FeishuConnectionState =
  | "disabled"
  | "not_connected"
  | "pending"
  | "connected"
  | "invalid"
  | "delivery_pending"
  | "delivery_error";

type FeishuConnectionOverview = {
  state: FeishuConnectionState;
  bindingState:
    "disabled" | "not_connected" | "pending" | "connected" | "invalid";
  deliveryState:
    | "idle"
    | "pending"
    | "sending"
    | "healthy"
    | "retrying"
    | "failed"
    | "deferred"
    | "unknown";
  verifiedAt: string | null;
  lastDeliveryKind: string | null;
  lastDeliveryStatus: string | null;
  lastDeliveryAt: string | null;
  lastErrorCode: string | null;
  nextRetryAt: string | null;
};

type PartnerConnection = {
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  pluginInstanceId: string | null;
  connectionState: string;
  verifiedAt: string | null;
  lastUploadAt: string | null;
  deviceName: string | null;
  version: string | null;
  reviewProgress: {
    periodKey: string | null;
    stage:
      | "not_started"
      | "reviewing_cards"
      | "generating_report"
      | "reviewing_report"
      | "completed";
    reviewed: number;
    total: number;
    pending: number;
    approved: number;
    excluded: number;
  };
  feishu?: FeishuConnectionOverview;
};

type ProjectScopePermission = "pending" | "allowed" | "denied";

type AdminProjectScope = {
  partner: {
    id: string;
    displayName: string;
    email: string;
  };
  summary: {
    total: number;
    allowed: number;
    pending: number;
    denied: number;
  };
  instances: Array<{
    id: string;
    deviceName: string;
    version: string;
    policyVersion: number;
    initialized: boolean;
    initializedAt: string | null;
    projects: Array<{
      name: string;
      permission: ProjectScopePermission;
      effectiveFrom: string | null;
      firstSeenPeriodKey: string;
      firstSeenAt: string;
      lastSeenAt: string;
      sessionCount: number;
    }>;
  }>;
};

type ProjectScopeDeliveryResult = {
  queued: true;
  mode: "review" | "status";
  queuedCount: number;
  pendingCount: number;
  totalCount: number;
};

type Overview = {
  team: any;
  partners: any[];
  connections: PartnerConnection[];
  periods: any[];
  bindingCodes: any[];
  reviewQueue: any[];
  jobs: Array<{ status: string; type: string; count: number }>;
};

const statusTone: Record<string, "success" | "warning" | "danger" | "neutral"> =
  {
    active: "success",
    connected: "warning",
    pending: "warning",
    failed: "danger",
    expired: "neutral",
    not_connected: "neutral",
  };

const statusLabel: Record<string, string> = {
  active: "正常上传",
  connected: "已连接，等待数据",
  pending: "连接测试中",
  failed: "连接测试失败",
  expired: "连接已失效",
  not_connected: "未连接",
};

const feishuStatusTone: Record<
  FeishuConnectionState,
  "success" | "warning" | "danger" | "neutral"
> = {
  disabled: "warning",
  connected: "success",
  pending: "warning",
  delivery_pending: "warning",
  delivery_error: "danger",
  invalid: "danger",
  not_connected: "neutral",
};

const feishuStatusLabel: Record<FeishuConnectionState, string> = {
  disabled: "飞书 · 未启用",
  connected: "飞书 · 已绑定",
  pending: "飞书 · 待确认",
  delivery_pending: "飞书 · 投递中",
  delivery_error: "飞书 · 投递异常",
  invalid: "飞书 · 绑定异常",
  not_connected: "飞书 · 未接入",
};

const reviewStageLabel: Record<
  PartnerConnection["reviewProgress"]["stage"],
  string
> = {
  not_started: "尚未生成",
  reviewing_cards: "卡片审核中",
  generating_report: "个人报告生成中",
  reviewing_report: "个人报告待审核",
  completed: "审核完成",
};

const projectScopeLabel: Record<ProjectScopePermission, string> = {
  allowed: "允许采集",
  pending: "待审批",
  denied: "拒绝采集",
};

const projectScopeTone: Record<
  ProjectScopePermission,
  "success" | "warning" | "neutral"
> = {
  allowed: "success",
  pending: "warning",
  denied: "neutral",
};

export function AdminConsole() {
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<Overview>("/v1/admin/overview"),
    refetchInterval: 15_000,
  });
  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载真实数据
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );
  const data = query.data!;
  return <Operations data={data} />;
}

function Operations({ data }: { data: Overview }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [codeFor, setCodeFor] = useState<any | null>(null);
  const [scopeFor, setScopeFor] = useState<PartnerConnection | null>(null);
  const [editPartner, setEditPartner] = useState<any | null>(null);
  const [removePartner, setRemovePartner] = useState<any | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
  const connected = data.connections.filter((item) =>
    ["active", "connected"].includes(item.connectionState),
  ).length;
  const uploading = data.connections.filter(
    (item) => item.connectionState === "active",
  ).length;
  const pendingReviews = new Set(
    data.reviewQueue
      .filter(
        (item) =>
          item.review_state === "IN_PROGRESS" ||
          item.report_status === "REPORT_REVIEW",
      )
      .map((item) => item.partner_id),
  ).size;
  const modelFailures = data.jobs
    .filter((job) => job.status === "FAILED" || job.status === "RETRY_WAIT")
    .reduce((sum, job) => sum + job.count, 0);
  const openPeriod = selectCurrentOpenPeriod(data.periods);

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">ADMIN OPERATIONS</span>
          <h1>运行总览</h1>
          <p>
            {openPeriod
              ? `${openPeriod.period_key} · 下次聚合 ${formatFullTime(openPeriod.cutoff_at)}`
              : "插件数据会在上传后实时更新"}
          </p>
        </div>
      </header>
      <div className="ops-metrics">
        <Metric
          icon={<Server size={18} />}
          label="连接正常"
          value={`${connected}/${data.connections.length}`}
        />
        <Metric
          icon={<Activity size={18} />}
          label="已收到上传"
          value={`${uploading}/${data.connections.length}`}
        />
        <Metric
          icon={<ClipboardCheck size={18} />}
          label="待审核人员"
          value={pendingReviews}
        />
        <Metric
          icon={<TriangleAlert size={18} />}
          label="中台任务异常"
          value={modelFailures}
          tone={modelFailures ? "danger" : undefined}
          href="/admin/jobs"
        />
      </div>

      <ScheduleSettings team={data.team} openPeriod={openPeriod} />

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>人员连接状态</h2>
            <p>查看 Codex 插件上传与飞书机器人绑定状态</p>
          </div>
          <Button
            variant="secondary"
            icon={<Plus size={16} />}
            onClick={() => setCreateOpen(true)}
          >
            新增人员
          </Button>
        </div>
        {data.connections.length === 0 ? (
          <EmptyState title="还没有人员" />
        ) : (
          <div className="plugin-table">
            {data.connections.map((connection) => {
              const partner = data.partners.find(
                (candidate) => candidate.id === connection.partnerId,
              );
              const codes = data.bindingCodes.filter(
                (code) =>
                  code.partner_id === connection.partnerId &&
                  ["active", "claimed"].includes(code.status) &&
                  code.code_value,
              );
              const activeBindingCode =
                codes.find((code) => code.status === "active") ?? null;
              const bindingCode = activeBindingCode ?? codes[0] ?? null;
              const recoverableInstanceId =
                connection.connectionState === "expired"
                  ? null
                  : connection.pluginInstanceId;
              return (
                <div className="plugin-status-row" key={connection.partnerId}>
                  <span
                    className={`health-dot health-${connection.connectionState}`}
                  />
                  <div className="plugin-person-cell">
                    <div className="plugin-person-name">
                      <strong title={connection.partnerName}>
                        {connection.partnerName}
                      </strong>
                      <button
                        className="icon-button partner-name-edit"
                        type="button"
                        title="编辑姓名"
                        aria-label={`编辑 ${connection.partnerName} 的姓名`}
                        disabled={!partner}
                        onClick={() => setEditPartner(partner)}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                    <span>{connection.partnerEmail}</span>
                  </div>
                  <div className="binding-code-cell">
                    <span className="cell-label">绑定码</span>
                    {bindingCode ? (
                      <button
                        className="binding-code-copy"
                        type="button"
                        title="复制绑定码"
                        aria-label={`复制 ${connection.partnerName} 的绑定码`}
                        onClick={async () => {
                          await copyText(bindingCode.code_value);
                          setCopiedCodeId(bindingCode.id);
                          window.setTimeout(() => setCopiedCodeId(null), 1600);
                        }}
                      >
                        <code>{bindingCode.code_value}</code>
                        {copiedCodeId === bindingCode.id ? (
                          <Check size={13} />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                    ) : (
                      <strong>--</strong>
                    )}
                  </div>
                  <div className="plugin-state-badges">
                    <Badge tone={statusTone[connection.connectionState]}>
                      {statusLabel[connection.connectionState]}
                    </Badge>
                    <Badge
                      tone={
                        feishuStatusTone[
                          connection.feishu?.state ?? "not_connected"
                        ] ?? "neutral"
                      }
                    >
                      {feishuStatusLabel[
                        connection.feishu?.state ?? "not_connected"
                      ] ?? "飞书 · 状态未知"}
                    </Badge>
                    <span className="plugin-tested-at">
                      测试 {formatTime(connection.verifiedAt)}
                    </span>
                  </div>
                  <div
                    className="review-progress-cell"
                    title={`接受 ${connection.reviewProgress.approved} · 忽略 ${connection.reviewProgress.excluded} · 待审核 ${connection.reviewProgress.pending}`}
                  >
                    <span className="cell-label">审核卡片</span>
                    <div className="review-progress-value">
                      <strong>
                        {connection.reviewProgress.reviewed}/
                        {connection.reviewProgress.total}
                      </strong>
                      <span>
                        {reviewStageLabel[connection.reviewProgress.stage]}
                      </span>
                    </div>
                    <progress
                      aria-label={`${connection.partnerName} 审核卡片进度`}
                      max={Math.max(1, connection.reviewProgress.total)}
                      value={connection.reviewProgress.reviewed}
                    />
                    <span>
                      {connection.reviewProgress.periodKey ?? "当前无周期"}
                    </span>
                  </div>
                  <div className="plugin-upload-cell">
                    <span className="cell-label">最近上传</span>
                    <strong>{formatTime(connection.lastUploadAt)}</strong>
                  </div>
                  <div className="plugin-device-cell">
                    <span className="cell-label">插件设备</span>
                    <strong title={connection.deviceName ?? undefined}>
                      {connection.deviceName ?? "--"}
                    </strong>
                    <span>
                      {connection.version
                        ? `v${connection.version}`
                        : "尚未配置"}
                    </span>
                  </div>
                  <div className="plugin-row-actions">
                    <Button
                      variant="secondary"
                      icon={<ShieldCheck size={16} />}
                      onClick={() => setScopeFor(connection)}
                    >
                      采集权限
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<KeyRound size={16} />}
                      disabled={!partner}
                      onClick={() =>
                        setCodeFor({
                          ...partner,
                          existingCode: activeBindingCode,
                          pluginInstanceId: recoverableInstanceId,
                        })
                      }
                    >
                      {activeBindingCode
                        ? "查看绑定码"
                        : recoverableInstanceId
                          ? "恢复连接"
                          : "生成绑定码"}
                    </Button>
                    <button
                      className="icon-button danger"
                      type="button"
                      title="删除人员"
                      aria-label={`删除 ${connection.partnerName}`}
                      disabled={!partner}
                      onClick={() => setRemovePartner(partner)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {createOpen && (
        <CreatePartnerModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      )}
      {codeFor && (
        <BindingCodeModal
          partner={codeFor}
          onClose={() => setCodeFor(null)}
          onCreated={refresh}
        />
      )}
      {editPartner && (
        <EditPartnerNameModal
          partner={editPartner}
          onClose={() => setEditPartner(null)}
          onUpdated={() => {
            setEditPartner(null);
            refresh();
          }}
        />
      )}
      {scopeFor && (
        <ProjectScopeModal
          connection={scopeFor}
          onClose={() => setScopeFor(null)}
        />
      )}
      {removePartner && (
        <RemovePartnerModal
          partner={removePartner}
          onClose={() => setRemovePartner(null)}
          onRemoved={() => {
            setRemovePartner(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function EditPartnerNameModal({
  partner,
  onClose,
  onUpdated,
}: {
  partner: { id: string; display_name: string; email: string };
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [displayName, setDisplayName] = useState(partner.display_name);
  const normalizedName = displayName.trim();
  const mutation = useMutation({
    mutationFn: () =>
      api(`/v1/admin/partners/${partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: normalizedName }),
      }),
    onSuccess: onUpdated,
  });

  return (
    <Modal
      title="编辑姓名"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            icon={<Save size={16} />}
            loading={mutation.isPending}
            disabled={
              !normalizedName || normalizedName === partner.display_name
            }
            onClick={() => mutation.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <ErrorBanner error={mutation.error} />
      <Field label="姓名">
        <input
          value={displayName}
          maxLength={120}
          autoFocus
          onChange={(event) => setDisplayName(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              normalizedName &&
              normalizedName !== partner.display_name &&
              !mutation.isPending
            )
              mutation.mutate();
          }}
        />
      </Field>
      <Field label="工作邮箱">
        <input value={partner.email} readOnly />
      </Field>
    </Modal>
  );
}

function ProjectScopeModal({
  connection,
  onClose,
}: {
  connection: PartnerConnection;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["admin-project-scopes", connection.partnerId],
    queryFn: () =>
      api<AdminProjectScope>(
        `/v1/admin/partners/${connection.partnerId}/project-scopes`,
      ),
  });
  const data = query.data;
  const delivery = useMutation({
    mutationFn: () =>
      api<ProjectScopeDeliveryResult>(
        `/v1/admin/partners/${connection.partnerId}/project-scopes/deliver`,
        { method: "POST" },
      ),
  });
  const deliveryLabel = data?.summary.pending ? "再次发送审核" : "发送权限状态";

  return (
    <Modal
      title={`${connection.partnerName} 的采集权限`}
      onClose={onClose}
      footer={
        <>
          <Button
            icon={<Send size={16} />}
            loading={delivery.isPending}
            disabled={!data || data.summary.total === 0 || query.isError}
            onClick={() => delivery.mutate()}
          >
            {deliveryLabel}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {delivery.isError && <ErrorBanner error={delivery.error} />}
      {delivery.data && (
        <SuccessBanner>
          {delivery.data.mode === "review"
            ? `已提交发送，${delivery.data.pendingCount} 个待审批项目将再次发给用户。`
            : "已提交发送，用户将在飞书中看到当前项目权限状态。"}
        </SuccessBanner>
      )}
      {query.isLoading ? (
        <div className="scope-loading">
          <RefreshCw className="spin" size={18} />
          <span>正在加载</span>
        </div>
      ) : query.isError ? (
        <ErrorBanner error={query.error} />
      ) : data ? (
        <>
          <div className="scope-summary" aria-label="项目采集权限汇总">
            <div>
              <span>允许采集</span>
              <strong>{data.summary.allowed}</strong>
            </div>
            <div>
              <span>待审批</span>
              <strong>{data.summary.pending}</strong>
            </div>
            <div>
              <span>拒绝采集</span>
              <strong>{data.summary.denied}</strong>
            </div>
          </div>
          {data.instances.length === 0 ? (
            <EmptyState title="尚未连接插件" />
          ) : (
            <div className="scope-instance-list">
              {data.instances.map((instance) => (
                <section className="scope-instance" key={instance.id}>
                  <header className="scope-instance-header">
                    <div>
                      <strong>{instance.deviceName}</strong>
                      <span>
                        v{instance.version} · 权限版本 {instance.policyVersion}
                      </span>
                    </div>
                    <Badge tone={instance.initialized ? "success" : "warning"}>
                      {instance.initialized ? "首次审批完成" : "等待首次审批"}
                    </Badge>
                  </header>
                  {instance.projects.length === 0 ? (
                    <div className="scope-instance-empty">尚未发现项目</div>
                  ) : (
                    <div className="scope-project-table">
                      <div className="scope-project-head" aria-hidden="true">
                        <span>项目</span>
                        <span>状态</span>
                        <span>生效时间</span>
                        <span>首次发现</span>
                        <span>Session</span>
                      </div>
                      {instance.projects.map((project, index) => (
                        <div
                          className="scope-project-row"
                          key={`${project.name}-${project.firstSeenAt}-${index}`}
                        >
                          <strong title={project.name}>{project.name}</strong>
                          <Badge tone={projectScopeTone[project.permission]}>
                            {projectScopeLabel[project.permission]}
                          </Badge>
                          <span>{formatScopeEffectiveAt(project)}</span>
                          <span>{project.firstSeenPeriodKey}</span>
                          <span>{project.sessionCount}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      ) : null}
    </Modal>
  );
}

function formatScopeEffectiveAt(project: {
  permission: ProjectScopePermission;
  effectiveFrom: string | null;
}) {
  if (project.permission === "pending") return "审批后确定";
  if (project.permission === "denied" || !project.effectiveFrom) return "--";
  const effectiveAt = new Date(project.effectiveFrom);
  const label = effectiveAt.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  });
  return effectiveAt.getTime() > Date.now() ? `${label} 生效` : "已生效";
}

function ScheduleSettings({
  team,
  openPeriod,
}: {
  team: any;
  openPeriod: any | null;
}) {
  const queryClient = useQueryClient();
  const defaults = team.period_rule ?? {};
  const [cutoffDay, setCutoffDay] = useState(
    String(defaults.factCutoffWeekday ?? 5),
  );
  const [cutoffTime, setCutoffTime] = useState(
    defaults.factCutoffTime ?? "14:00",
  );
  const saveDefaults = useMutation({
    mutationFn: () =>
      api("/v1/admin/team", {
        method: "PATCH",
        body: JSON.stringify({
          periodRule: {
            frequency: "weekly",
            weekStartsOn: 1,
            factCutoffWeekday: Number(cutoffDay),
            factCutoffTime: cutoffTime,
          },
        }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
  });
  return (
    <section className="schedule-settings-band">
      <div className="section-heading">
        <div>
          <h2>报告生成时间</h2>
          <p>
            工作卡片按设定时间聚合，后续 Report 流程按审批自动推进，时区为
            Asia/Shanghai
          </p>
        </div>
        <CalendarClock size={19} />
      </div>
      <div className="schedule-settings-grid">
        <div className="schedule-setting">
          <div className="schedule-setting-title">
            <strong>工作卡片聚合</strong>
            <span>
              {openPeriod
                ? `下次执行 ${formatFullTime(openPeriod.cutoff_at)}`
                : "等待开放周期"}
            </span>
          </div>
          <Field label="每周">
            <select
              value={cutoffDay}
              onChange={(event) => setCutoffDay(event.target.value)}
            >
              {weekdayOptions()}
            </select>
          </Field>
          <Field label="聚合时间">
            <input
              type="time"
              value={cutoffTime}
              onChange={(event) => setCutoffTime(event.target.value)}
            />
          </Field>
        </div>
        <div className="schedule-setting">
          <div className="schedule-setting-title">
            <strong>自动生成链路</strong>
            <span>
              用户审批完工作卡片后生成个人 Report；全部个人 Report 通过后生成
              Team Report
            </span>
          </div>
        </div>
        <Button
          variant="secondary"
          icon={<Save size={16} />}
          loading={saveDefaults.isPending}
          onClick={() => saveDefaults.mutate()}
        >
          保存生成时间
        </Button>
      </div>
      <ErrorBanner error={saveDefaults.error} />
    </section>
  );
}

function weekdayOptions() {
  return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
    (label, index) => (
      <option value={index + 1} key={label}>
        {label}
      </option>
    ),
  );
}

function Metric({
  icon,
  label,
  value,
  tone,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone?: string | undefined;
  href?: string | undefined;
}) {
  const content = (
    <>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </>
  );
  return href ? (
    <Link className={`ops-metric ops-metric-link ${tone ?? ""}`} href={href}>
      {content}
    </Link>
  ) : (
    <div className={`ops-metric ${tone ?? ""}`}>{content}</div>
  );
}
function formatTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Shanghai",
      })
    : "从未";
}

function formatFullTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        weekday: "short",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Shanghai",
      })
    : "未设置";
}

function CreatePartnerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/v1/admin/partners", {
        method: "POST",
        body: JSON.stringify({ displayName, email }),
      }),
    onSuccess: onCreated,
  });
  return (
    <Modal
      title="新增 Partner"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            loading={mutation.isPending}
            disabled={!displayName || !email}
            onClick={() => mutation.mutate()}
          >
            创建
          </Button>
        </>
      }
    >
      <ErrorBanner error={mutation.error} />
      <Field label="姓名">
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          autoFocus
        />
      </Field>
      <Field label="唯一工作邮箱">
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
    </Modal>
  );
}

function BindingCodeModal({
  partner,
  onClose,
  onCreated,
}: {
  partner: any;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("Codex Plugin");
  const [result, setResult] = useState<any | null>(
    partner.existingCode?.code_value
      ? { code: partner.existingCode.code_value }
      : null,
  );
  const [copied, setCopied] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api<any>(`/v1/admin/partners/${partner.id}/binding-codes`, {
        method: "POST",
        body: JSON.stringify({
          label,
          pluginInstanceId: partner.pluginInstanceId ?? undefined,
        }),
      }),
    onSuccess: (value) => {
      setResult(value);
      onCreated();
    },
  });
  const copy = async () => {
    await copyText(result.code);
    setCopied(true);
  };
  return (
    <Modal
      title={
        result
          ? `${partner.display_name} 的绑定码`
          : partner.pluginInstanceId
            ? `为 ${partner.display_name} 生成连接恢复码`
            : `为 ${partner.display_name} 生成绑定码`
      }
      onClose={onClose}
      footer={
        result ? (
          <Button
            icon={copied ? <Check size={16} /> : <Copy size={16} />}
            onClick={copy}
          >
            {copied ? "已复制" : "复制绑定码"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              生成
            </Button>
          </>
        )
      }
    >
      <ErrorBanner error={mutation.error} />
      {result ? (
        <div className="binding-result">
          <KeyRound size={22} />
          <span>此绑定码会保留在 Partner 列表中</span>
          <code>{result.code}</code>
          <small>插件安装后使用此码绑定到 {partner.email}</small>
        </div>
      ) : (
        <>
          {partner.pluginInstanceId && (
            <p>
              当前设备已经绑定。只有本机凭据丢失或连接失效时才需要生成恢复码。
            </p>
          )}
          <Field label="设备标签">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
            />
          </Field>
        </>
      )}
    </Modal>
  );
}

function RemovePartnerModal({
  partner,
  onClose,
  onRemoved,
}: {
  partner: any;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () =>
      api(`/v1/admin/partners/${partner.id}`, {
        method: "DELETE",
      }),
    onSuccess: onRemoved,
  });

  return (
    <Modal
      title="删除人员"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 size={16} />}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            确认删除
          </Button>
        </>
      }
    >
      <ErrorBanner error={mutation.error} />
      <div className="partner-remove-copy">
        <p>
          确认删除 <strong>{partner.display_name}</strong>（{partner.email}）？
        </p>
        <p>
          删除后，该人员的 Codex
          插件令牌、未使用绑定码和飞书绑定会立即失效，待发送的飞书消息也会停止重试。历史报告与审核记录仍会保留。
        </p>
      </div>
    </Modal>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}
