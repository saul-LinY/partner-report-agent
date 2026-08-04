import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Ban,
  BrainCircuit,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  FolderKanban,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Server,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useLocation } from "wouter";
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

type Section = "overview" | "partners" | "projects";
type Overview = {
  team: any;
  projects: any[];
  partners: any[];
  plugins: any[];
  periods: any[];
  bindingCodes: any[];
  reviewQueue: any[];
  jobs: Array<{ status: string; type: string; count: number }>;
  modelConfig: {
    selectedModel: string;
    availableModels: string[];
    gatewayConfigured: boolean;
  };
};

const statusTone: Record<string, "success" | "warning" | "danger" | "neutral"> =
  {
    healthy: "success",
    verified: "success",
    pending: "warning",
    waiting_first_run: "warning",
    abnormal: "danger",
    failed: "danger",
    offline: "danger",
    blocked: "neutral",
    expired: "neutral",
  };

const statusLabel: Record<string, string> = {
  verified: "连接正常",
  pending: "待验证",
  failed: "连接失败",
  expired: "连接过期",
  waiting_first_run: "等待首次采集",
  healthy: "采集健康",
  abnormal: "采集异常",
  offline: "采集离线",
  blocked: "已阻断",
};

export function AdminConsole({ section }: { section: Section }) {
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
  if (section === "partners") return <PartnerManagement data={data} />;
  if (section === "projects") return <ProjectManagement data={data} />;
  return <Operations data={data} />;
}

function Operations({ data }: { data: Overview }) {
  const [, navigate] = useLocation();
  const activePlugins = data.plugins.filter(
    (plugin) => plugin.status === "active",
  );
  const actionable = data.reviewQueue.filter(
    (item) =>
      item.review_state === "IN_PROGRESS" ||
      item.report_status === "REPORT_REVIEW",
  );
  const modelFailures = data.jobs
    .filter((job) => job.status === "FAILED" || job.status === "RETRY_WAIT")
    .reduce((sum, job) => sum + job.count, 0);
  const openPeriod = selectCurrentOpenPeriod(data.periods);
  const openReview = (item: any, kind: "review" | "report") => {
    window.localStorage.setItem(
      "partner-report-simulated-partner",
      item.partner_id,
    );
    navigate(
      kind === "review"
        ? `/partner/review/${item.review_id}`
        : `/partner/report/${item.report_id}`,
    );
  };

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">ADMIN OPERATIONS</span>
          <h1>本周运行总览</h1>
          <p>
            {openPeriod
              ? `${openPeriod.period_key} · ${formatFullTime(openPeriod.cutoff_at)} Fact 截止`
              : "暂无开放周期"}
          </p>
        </div>
      </header>
      <div className="ops-metrics">
        <Metric
          icon={<Server size={18} />}
          label="连接正常"
          value={`${activePlugins.filter((p) => p.connectivityStatus === "verified").length}/${activePlugins.length}`}
        />
        <Metric
          icon={<Activity size={18} />}
          label="采集健康"
          value={`${activePlugins.filter((p) => p.runStatus === "healthy").length}/${activePlugins.length}`}
        />
        <Metric
          icon={<ClipboardCheck size={18} />}
          label="待人工审核"
          value={actionable.length}
        />
        <Metric
          icon={<TriangleAlert size={18} />}
          label="中台任务异常"
          value={modelFailures}
          tone={modelFailures ? "danger" : undefined}
        />
      </div>

      <ModelSettings config={data.modelConfig} />
      <ScheduleSettings team={data.team} openPeriod={openPeriod} />

      <section className="section-block workflow-band">
        <div className="section-heading">
          <div>
            <h2>本周链路</h2>
            <p>插件只采集，中台负责聚合与生成</p>
          </div>
        </div>
        <div className="workflow-steps">
          <FlowStep
            index="1"
            title="增量采集"
            detail="每次 Run 清空完整 Turn"
          />
          <FlowStep
            index="2"
            title="中台聚合"
            detail="跨 Session 生成工作卡片"
          />
          <FlowStep
            index="3"
            title="第一次审核"
            detail="Admin 模拟 Partner 确认"
          />
          <FlowStep index="4" title="生成 Report" detail="中台按确认快照生成" />
          <FlowStep index="5" title="个人归档" detail="确认并锁定个人版本" />
          <FlowStep index="6" title="Team Report" detail="团队审核后锁定归档" />
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>审核队列</h2>
            <p>这里的卡片和 Report 均来自真实中台数据</p>
          </div>
          <Badge tone={actionable.length ? "warning" : "success"}>
            {actionable.length} 待处理
          </Badge>
        </div>
        {data.reviewQueue.length === 0 ? (
          <EmptyState title="还没有进入审核的数据" />
        ) : (
          <div className="review-queue">
            {data.reviewQueue.map((item) => (
              <div className="queue-row" key={item.review_id}>
                <div className="queue-person">
                  <span className="avatar">
                    {item.partner_name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>{item.partner_name}</strong>
                    <span>
                      {item.partner_email} · {item.period_key}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="cell-label">工作卡片</span>
                  <Badge
                    tone={
                      item.review_state === "IN_PROGRESS"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {reviewLabel(item.review_state)}
                  </Badge>
                </div>
                <div>
                  <span className="cell-label">Report</span>
                  <Badge
                    tone={
                      item.report_status === "REPORT_REVIEW"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {reportLabel(item.report_status)}
                  </Badge>
                </div>
                <div className="queue-actions">
                  {item.review_state === "IN_PROGRESS" && (
                    <Button
                      variant="secondary"
                      onClick={() => openReview(item, "review")}
                    >
                      审核卡片
                    </Button>
                  )}
                  {item.report_status === "REPORT_REVIEW" && (
                    <Button onClick={() => openReview(item, "report")}>
                      审核 Report
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>Plugin 状态</h2>
            <p>连接验证与真实采集结果独立判断</p>
          </div>
        </div>
        {data.plugins.length === 0 ? (
          <EmptyState title="还没有绑定 Plugin" />
        ) : (
          <div className="plugin-table">
            {data.plugins.map((plugin) => (
              <div className="plugin-status-row" key={plugin.id}>
                <span className={`health-dot health-${plugin.runStatus}`} />
                <div>
                  <strong>{plugin.partner_name}</strong>
                  <span>
                    {plugin.device_name} · v{plugin.version}
                  </span>
                </div>
                <div className="plugin-state-badges">
                  <Badge tone={statusTone[plugin.connectivityStatus]}>
                    {statusLabel[plugin.connectivityStatus]}
                  </Badge>
                  <Badge tone={statusTone[plugin.runStatus]}>
                    {statusLabel[plugin.runStatus]}
                  </Badge>
                </div>
                <div>
                  <span className="cell-label">最近采集</span>
                  <strong>
                    {formatTime(plugin.last_collection_completed_at)}
                  </strong>
                </div>
                <div>
                  <span className="cell-label">Session / Fact</span>
                  <strong>
                    {plugin.last_collection_session_count} /{" "}
                    {plugin.last_collection_fact_count}
                  </strong>
                </div>
                <div>
                  <span className="cell-label">当前 Run / 待处理</span>
                  <strong>
                    {collectionRunLabel(plugin.current_run_status)} /{" "}
                    {plugin.current_run_pending_local_jobs ?? 0}
                  </strong>
                  <span>
                    已同步 {plugin.current_run_synced_session_count ?? 0}{" "}
                    Session
                  </span>
                </div>
                <div>
                  <span className="cell-label">最近诊断</span>
                  <strong>
                    {plugin.last_diagnostic_error_code ??
                      plugin.last_connectivity_error_code ??
                      "--"}
                  </strong>
                  <span>
                    {plugin.last_diagnostic_message ??
                      formatTime(plugin.connectivity_verified_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ScheduleSettings({
  team,
  openPeriod,
}: {
  team: any;
  openPeriod: any;
}) {
  const queryClient = useQueryClient();
  const defaults = team.period_rule ?? {};
  const [timezone, setTimezone] = useState(team.timezone ?? "Asia/Shanghai");
  const [cutoffDay, setCutoffDay] = useState(
    String(defaults.factCutoffWeekday ?? 5),
  );
  const [cutoffTime, setCutoffTime] = useState(
    defaults.factCutoffTime ?? "14:00",
  );
  const [deadlineDay, setDeadlineDay] = useState(
    String(defaults.reportDeadlineWeekday ?? 1),
  );
  const [deadlineTime, setDeadlineTime] = useState(
    defaults.reportDeadlineTime ?? "10:00",
  );
  const [grace, setGrace] = useState(
    String(team.collection_grace_minutes ?? 120),
  );
  const [currentCutoff, setCurrentCutoff] = useState(
    toLocalInput(openPeriod?.cutoff_at),
  );
  const [currentDeadline, setCurrentDeadline] = useState(
    toLocalInput(openPeriod?.submission_deadline_at),
  );
  const saveDefaults = useMutation({
    mutationFn: () =>
      api("/v1/admin/team", {
        method: "PATCH",
        body: JSON.stringify({
          timezone,
          collectionGraceMinutes: Number(grace),
          periodRule: {
            frequency: "weekly",
            weekStartsOn: 1,
            factCutoffWeekday: Number(cutoffDay),
            factCutoffTime: cutoffTime,
            reportDeadlineWeekday: Number(deadlineDay),
            reportDeadlineTime: deadlineTime,
          },
        }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
  });
  const saveCurrent = useMutation({
    mutationFn: () =>
      api(`/v1/admin/report-periods/${openPeriod.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: openPeriod.status,
          cutoffAt: new Date(currentCutoff).toISOString(),
          submissionDeadlineAt: new Date(currentDeadline).toISOString(),
        }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
  });
  return (
    <section className="schedule-settings-band">
      <div className="section-heading">
        <div>
          <h2>周期与截止时间</h2>
          <p>默认规则用于新周期；当前周期可单独覆盖</p>
        </div>
        <CalendarClock size={19} />
      </div>
      <div className="schedule-settings-grid">
        <Field label="Team 时区">
          <input
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </Field>
        <Field label="Fact 截止星期">
          <select
            value={cutoffDay}
            onChange={(event) => setCutoffDay(event.target.value)}
          >
            {weekdayOptions()}
          </select>
        </Field>
        <Field label="Fact 截止时间">
          <input
            type="time"
            value={cutoffTime}
            onChange={(event) => setCutoffTime(event.target.value)}
          />
        </Field>
        <Field label="采集宽限（分钟）">
          <input
            type="number"
            min="0"
            max="1440"
            value={grace}
            onChange={(event) => setGrace(event.target.value)}
          />
        </Field>
        <Field label="个人报告截止星期">
          <select
            value={deadlineDay}
            onChange={(event) => setDeadlineDay(event.target.value)}
          >
            {weekdayOptions()}
          </select>
        </Field>
        <Field label="个人报告截止时间">
          <input
            type="time"
            value={deadlineTime}
            onChange={(event) => setDeadlineTime(event.target.value)}
          />
        </Field>
        <Button
          variant="secondary"
          icon={<Save size={16} />}
          loading={saveDefaults.isPending}
          onClick={() => saveDefaults.mutate()}
        >
          保存默认规则
        </Button>
      </div>
      {openPeriod && (
        <div className="current-period-override">
          <strong>{openPeriod.period_key} 当前周期覆盖</strong>
          <Field label="Fact 截止">
            <input
              type="datetime-local"
              value={currentCutoff}
              onChange={(event) => setCurrentCutoff(event.target.value)}
            />
          </Field>
          <Field label="个人报告截止">
            <input
              type="datetime-local"
              value={currentDeadline}
              onChange={(event) => setCurrentDeadline(event.target.value)}
            />
          </Field>
          <Button
            variant="secondary"
            icon={<Save size={16} />}
            loading={saveCurrent.isPending}
            disabled={!currentCutoff || !currentDeadline}
            onClick={() => saveCurrent.mutate()}
          >
            保存本期覆盖
          </Button>
        </div>
      )}
      <ErrorBanner error={saveDefaults.error ?? saveCurrent.error} />
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

function toLocalInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function collectionRunLabel(value: string | null) {
  return (
    (
      {
        started: "已开始",
        running: "进行中",
        continuation_pending: "续跑中",
        completed: "已完成",
        failed: "失败",
      } as Record<string, string>
    )[value?.toLowerCase() ?? ""] ?? "无"
  );
}

function ModelSettings({ config }: { config: Overview["modelConfig"] }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState(config.selectedModel);
  const mutation = useMutation({
    mutationFn: () =>
      api("/v1/admin/team", {
        method: "PATCH",
        body: JSON.stringify({ centralModel: model }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
  });
  const changed = model !== config.selectedModel;

  return (
    <section className="model-config-band">
      <div className="model-config-summary">
        <span className="model-config-icon">
          <BrainCircuit size={19} />
        </span>
        <div>
          <small>中台生成模型</small>
          <strong>{config.selectedModel}</strong>
          <span>用于跨 Session 聚合和 Report 生成</span>
        </div>
      </div>
      <Badge tone={config.gatewayConfigured ? "success" : "danger"}>
        {config.gatewayConfigured ? "网关已连接" : "网关未配置"}
      </Badge>
      <div className="model-config-controls">
        <label>
          <span>选择模型</span>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            {config.availableModels.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          icon={<Save size={16} />}
          loading={mutation.isPending}
          disabled={!changed}
          onClick={() => mutation.mutate()}
        >
          保存
        </Button>
      </div>
      {mutation.error && <ErrorBanner error={mutation.error} />}
    </section>
  );
}

function PartnerManagement({ data }: { data: Overview }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [codeFor, setCodeFor] = useState<any | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">IDENTITY & ISOLATION</span>
          <h1>Partner 与绑定</h1>
          <p>工作邮箱是唯一身份；一个邮箱可绑定多个 Plugin</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
          新增 Partner
        </Button>
      </header>
      <section className="section-block">
        <div className="partner-list">
          {data.partners.map((partner) => {
            const codes = data.bindingCodes.filter(
              (code) => code.partner_id === partner.id,
            );
            const plugins = data.plugins.filter(
              (plugin) =>
                plugin.partner_id === partner.id && plugin.status === "active",
            );
            return (
              <div className="partner-row" key={partner.id}>
                <div className="queue-person">
                  <span className="avatar">
                    {partner.display_name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>{partner.display_name}</strong>
                    <span>{partner.email}</span>
                  </div>
                </div>
                <div>
                  <span className="cell-label">活动 Plugin</span>
                  <strong>{plugins.length}</strong>
                </div>
                <div className="binding-list">
                  {codes.length === 0 ? (
                    <span className="muted">暂无绑定码</span>
                  ) : (
                    codes.map((code) => (
                      <BindingCodeItem code={code} key={code.id} />
                    ))
                  )}
                </div>
                <Button
                  variant="secondary"
                  icon={<KeyRound size={16} />}
                  onClick={() => setCodeFor(partner)}
                >
                  生成绑定码
                </Button>
              </div>
            );
          })}
        </div>
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

function BindingCodeItem({ code }: { code: any }) {
  const [copied, setCopied] = useState(false);
  const value = code.code_value as string | null;
  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="binding-code-item">
      <KeyRound size={15} />
      <div>
        <code>{value ?? `${code.code_prefix}••••`}</code>
        {!value && <small>旧绑定码不可恢复，请重新生成</small>}
      </div>
      <Badge
        tone={
          code.status === "active"
            ? "warning"
            : code.status === "claimed"
              ? "success"
              : "neutral"
        }
      >
        {bindingStatusLabel(code.status)}
      </Badge>
      {value && code.status === "active" && (
        <button
          className="icon-button binding-copy"
          onClick={copy}
          title="复制绑定码"
          aria-label="复制绑定码"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      )}
    </div>
  );
}

function bindingStatusLabel(value: string) {
  return (
    (
      {
        active: "未使用",
        claimed: "已绑定",
        revoked: "已停用",
      } as Record<string, string>
    )[value] ?? value
  );
}

function ProjectManagement({ data }: { data: Overview }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PROJECT MAPPING</span>
          <h1>项目目录</h1>
          <p>项目根目录下的所有子文件夹 Session 自动归入同一项目</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => setOpen(true)}>
          新增项目
        </Button>
      </header>
      <section className="section-block">
        {data.projects.length === 0 ? (
          <EmptyState title="还没有配置项目目录" />
        ) : (
          <div className="project-grid">
            {data.projects.map((project) => (
              <div className="project-item" key={project.id}>
                <span className="project-icon">
                  <FolderKanban size={19} />
                </span>
                <div>
                  <strong>{project.name}</strong>
                  <span>
                    {project.aliases?.length
                      ? `别名：${project.aliases.join("、")}`
                      : "无别名"}
                  </span>
                  {project.allowed_paths.map((path: string) => (
                    <code key={path}>{path}</code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {open && (
        <CreateProjectModal
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
          }}
        />
      )}
    </div>
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
function FlowStep({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="flow-step">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}
function reviewLabel(value: string) {
  return (
    (
      {
        IN_PROGRESS: "待确认",
        ITEMS_APPROVED: "已确认",
        WAITING_LOCAL_REANALYSIS: "重新分析",
      } as Record<string, string>
    )[value] ?? value
  );
}
function reportLabel(value: string | null) {
  if (!value) return "未生成";
  return (
    (
      {
        REPORT_DRAFT: "生成中",
        REPORT_REVIEW: "待确认",
        LOCKED: "已锁定",
        RETURNED_TO_ITEMS: "已退回",
      } as Record<string, string>
    )[value] ?? value
  );
}
function formatTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
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
  const [result, setResult] = useState<any | null>(null);
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
    await navigator.clipboard.writeText(result.code);
    setCopied(true);
  };
  return (
    <Modal
      title={`为 ${partner.display_name} 生成绑定码`}
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

function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [paths, setPaths] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/v1/admin/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          aliases: aliases
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
          allowedPaths: paths
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean),
          externalIds: [],
        }),
      }),
    onSuccess: onCreated,
  });
  return (
    <Modal
      title="新增项目目录"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            loading={mutation.isPending}
            disabled={!name || !paths.trim()}
            onClick={() => mutation.mutate()}
          >
            创建
          </Button>
        </>
      }
    >
      <ErrorBanner error={mutation.error} />
      <Field label="项目名称">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </Field>
      <Field label="别名" hint="多个别名用逗号分隔">
        <input
          value={aliases}
          onChange={(event) => setAliases(event.target.value)}
        />
      </Field>
      <Field label="项目根目录" hint="每行一个绝对路径；子目录无需重复配置">
        <textarea
          rows={5}
          value={paths}
          onChange={(event) => setPaths(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
