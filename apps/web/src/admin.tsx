import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  FileText,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { ApiClientError, api } from "./api.js";
import { selectCurrentOpenPeriod } from "./period-selection.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
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
  connectionState: string;
  verifiedAt: string | null;
  lastUploadAt: string | null;
  deviceName: string | null;
  version: string | null;
  feishu?: FeishuConnectionOverview;
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
        />
      </div>

      <ScheduleSettings team={data.team} />
      <ManualTeamReportGeneration periods={data.periods} />

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
                  code.status !== "revoked" &&
                  code.code_value,
              );
              const bindingCode = codes[0] ?? null;
              return (
                <div className="plugin-status-row" key={connection.partnerId}>
                  <span
                    className={`health-dot health-${connection.connectionState}`}
                  />
                  <div>
                    <strong>{connection.partnerName}</strong>
                    <span>{connection.partnerEmail}</span>
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
                  </div>
                  <div>
                    <span className="cell-label">连接测试</span>
                    <strong>{formatTime(connection.verifiedAt)}</strong>
                  </div>
                  <div>
                    <span className="cell-label">最近上传</span>
                    <strong>{formatTime(connection.lastUploadAt)}</strong>
                  </div>
                  <div>
                    <span className="cell-label">插件</span>
                    <strong title={connection.deviceName ?? undefined}>
                      {connection.deviceName ?? "--"}
                    </strong>
                    <span>
                      {connection.version
                        ? `v${connection.version}`
                        : "尚未配置"}
                    </span>
                  </div>
                  <div className="binding-code-cell">
                    <span className="cell-label">绑定码</span>
                    {bindingCode ? (
                      <button
                        className="binding-code-copy"
                        title="复制绑定码"
                        onClick={async () => {
                          await copyText(bindingCode.code_value);
                          setCopiedCodeId(bindingCode.id);
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
                      <strong>尚未生成</strong>
                    )}
                  </div>
                  <div className="plugin-row-actions">
                    <Button
                      variant="secondary"
                      icon={<KeyRound size={16} />}
                      disabled={!partner}
                      onClick={() =>
                        setCodeFor({ ...partner, existingCode: bindingCode })
                      }
                    >
                      {bindingCode ? "查看绑定码" : "生成绑定码"}
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

function ManualTeamReportGeneration({ periods }: { periods: any[] }) {
  const queryClient = useQueryClient();
  const defaultPeriod =
    selectCurrentOpenPeriod(periods) ??
    [...periods].sort(
      (left, right) =>
        new Date(right.starts_at).getTime() -
        new Date(left.starts_at).getTime(),
    )[0];
  const [periodId, setPeriodId] = useState(defaultPeriod?.id ?? "");
  const [submittedPeriodIds, setSubmittedPeriodIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [notice, setNotice] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const generate = useMutation({
    mutationFn: () =>
      api("/v1/admin/team-reports/generate", {
        method: "POST",
        body: JSON.stringify({ periodId }),
      }),
    onSuccess: (result: any) => {
      setSubmittedPeriodIds((current) => new Set(current).add(periodId));
      setNotice({
        title: "已提交生成",
        message: result?.queued
          ? "Team Report 已进入生成队列。"
          : "Team Report 已经在生成队列中，请稍后查看。",
      });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
      queryClient.invalidateQueries({ queryKey: ["team-reports"] });
      queryClient.invalidateQueries({ queryKey: ["report-archive"] });
    },
    onError: (error) => {
      if (
        error instanceof ApiClientError &&
        ["TEAM_REPORT_EXISTS", "TEAM_REPORT_LOCKED"].includes(error.code)
      ) {
        setSubmittedPeriodIds((current) => new Set(current).add(periodId));
        setNotice({
          title: "该周期已有 Team Report",
          message:
            "当前周期已经存在 Team Report，请到 Team Report 页面查看或继续编辑现有报告。",
        });
      }
    },
  });
  const selectedPeriod = periods.find((period) => period.id === periodId);
  const alreadySubmitted = submittedPeriodIds.has(periodId);
  return (
    <section className="schedule-settings-band">
      <div className="section-heading">
        <div>
          <h2>一键生成 Team Report</h2>
          <p>选择周期后，使用该周期已最终确认的个人 Report 直接生成团队报告</p>
        </div>
        <FileText size={19} />
      </div>
      <div className="schedule-settings-grid">
        <div className="schedule-setting">
          <div className="schedule-setting-title">
            <strong>生成周期</strong>
            <span>
              {selectedPeriod
                ? `${formatFullTime(selectedPeriod.starts_at)} - ${formatFullTime(selectedPeriod.ends_at)}`
                : "只会读取所选周期下已通过的个人 Report"}
            </span>
          </div>
          <Field label="周期">
            <select
              value={periodId}
              onChange={(event) => setPeriodId(event.target.value)}
            >
              {periods.map((period) => (
                <option value={period.id} key={period.id}>
                  {period.period_key}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button
          variant="secondary"
          icon={<FileText size={16} />}
          loading={generate.isPending}
          disabled={!periodId || alreadySubmitted}
          onClick={() => generate.mutate()}
        >
          {alreadySubmitted ? "已提交生成" : "生成 Team Report"}
        </Button>
      </div>
      <ErrorBanner
        error={
          generate.error instanceof ApiClientError &&
          ["TEAM_REPORT_EXISTS", "TEAM_REPORT_LOCKED"].includes(
            generate.error.code,
          )
            ? null
            : generate.error
        }
      />
      {notice && (
        <Modal
          title={notice.title}
          onClose={() => setNotice(null)}
          footer={
            <Button variant="secondary" onClick={() => setNotice(null)}>
              知道了
            </Button>
          }
        >
          <p>{notice.message}</p>
          {selectedPeriod && (
            <p>
              周期：{selectedPeriod.period_key} ·{" "}
              {formatFullTime(selectedPeriod.starts_at)} -{" "}
              {formatFullTime(selectedPeriod.ends_at)}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}

function ScheduleSettings({ team }: { team: any }) {
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
            <span>冻结本期贡献并生成项目卡片</span>
          </div>
          <Field label="每周">
            <select
              value={cutoffDay}
              onChange={(event) => setCutoffDay(event.target.value)}
            >
              {weekdayOptions()}
            </select>
          </Field>
          <Field label="开始时间">
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone?: string | undefined;
}) {
  return (
    <div className={`ops-metric ${tone ?? ""}`}>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
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
        body: JSON.stringify({ label }),
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
        <Field label="设备标签">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoFocus
          />
        </Field>
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
