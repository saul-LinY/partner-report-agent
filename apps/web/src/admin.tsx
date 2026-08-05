import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Server,
  TriangleAlert,
} from "lucide-react";
import { api } from "./api.js";
import { selectCurrentOpenPeriod } from "./period-selection.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
} from "./components.js";

type Overview = {
  team: any;
  partners: any[];
  connections: any[];
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

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>人员连接状态</h2>
            <p>首次配置完成连接测试；之后以中台收到的实时上传为准</p>
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
    </div>
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
  const [teamReportDay, setTeamReportDay] = useState(
    String(defaults.reportDeadlineWeekday ?? 1),
  );
  const [teamReportTime, setTeamReportTime] = useState(
    defaults.reportDeadlineTime ?? "10:00",
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
            reportDeadlineWeekday: Number(teamReportDay),
            reportDeadlineTime: teamReportTime,
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
          <p>分别控制工作卡片聚合与 Team Report 生成，时区为 Asia/Shanghai</p>
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
            <strong>Team Report 生成</strong>
            <span>按届时已归档的个人 Report 生成团队报告</span>
          </div>
          <Field label="每周">
            <select
              value={teamReportDay}
              onChange={(event) => setTeamReportDay(event.target.value)}
            >
              {weekdayOptions()}
            </select>
          </Field>
          <Field label="开始时间">
            <input
              type="time"
              value={teamReportTime}
              onChange={(event) => setTeamReportTime(event.target.value)}
            />
          </Field>
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
