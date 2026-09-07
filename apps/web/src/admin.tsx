import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  LayoutDashboard,
  Users,
  Settings2,
  Laptop,
  X,
  Check,
  ClipboardCheck,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
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
} from "./components.js";

type PartnerConnection = {
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  pluginInstanceId: string | null;
  connectionState: string;
  feishuConnectionState: string;
  feishuConnectedAt: string | null;
  feishuLastAttemptAt: string | null;
  feishuLastErrorCode: string | null;
  verifiedAt: string | null;
  lastUploadAt: string | null;
  deviceName: string | null;
  version: string | null;
  reviewProgress: {
    periodKey: string | null;
    stage: "not_started" | "reviewing_cards" | "completed";
    reviewed: number;
    total: number;
    pending: number;
    approved: number;
    excluded: number;
  };
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
  string,
  "success" | "warning" | "danger" | "neutral"
> = {
  connected: "success",
  connecting: "warning",
  failed: "danger",
  not_connected: "neutral",
  not_started: "neutral",
  unavailable: "neutral",
};

const feishuStatusLabel: Record<string, string> = {
  connected: "已连接",
  connecting: "检测中",
  failed: "连接异常",
  not_connected: "待首次投递",
  not_started: "尚未发起",
  unavailable: "飞书未配置",
};

function feishuStatusDetail(connection: PartnerConnection) {
  if (connection.feishuConnectionState === "connected")
    return `送达 ${formatTime(connection.feishuConnectedAt)}`;
  if (connection.feishuLastErrorCode) return connection.feishuLastErrorCode;
  if (connection.feishuConnectionState === "connecting")
    return `尝试 ${formatTime(connection.feishuLastAttemptAt)}`;
  if (connection.feishuConnectionState === "not_connected") return "等待权限卡";
  if (connection.feishuConnectionState === "not_started") return "等待插件连接";
  return "检查飞书配置";
}

const reviewStageLabel: Record<
  PartnerConnection["reviewProgress"]["stage"],
  string
> = {
  not_started: "尚未生成",
  reviewing_cards: "卡片审核中",
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

import {
  AdminTableScroll,
  AdminHeader,
  AdminMetrics,
  AdminSearch,
  AdminTabs,
  AdminWorkspace,
  AdminPagination,
} from "./admin-workspace.js";

export function AdminConsole() {
  const query = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<Overview>("/v1/admin/overview"),
    refetchInterval: 15_000,
  });
  if (!query.data)
    return (
      <div className="page management-page">
        <AdminHeader
          title="运行总览"
          icon={LayoutDashboard}
          onRefresh={() => void query.refetch()}
          refreshing={query.isFetching}
        />
        <ErrorBanner error={query.error} />
        {query.isLoading ? (
          <div className="aw-loading" role="status">
            <RefreshCw className="spin" size={18} />
            加载运行总览
          </div>
        ) : (
          <EmptyState
            title="运行数据暂不可用"
            action={
              <button
                className="aw-text-button"
                onClick={() => void query.refetch()}
              >
                重试
              </button>
            }
          />
        )}
      </div>
    );
  return (
    <Operations
      data={query.data}
      refreshing={query.isFetching}
      error={query.error}
    />
  );
}

function Operations({
  data,
  refreshing,
  error,
}: {
  data: Overview;
  refreshing: boolean;
  error: unknown;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"people" | "schedule">("people");
  const [search, setSearch] = useState("");
  const [pluginStatus, setPluginStatus] = useState("");
  const [feishuStatus, setFeishuStatus] = useState("");
  const [reviewStage, setReviewStage] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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
  const feishuConnected = data.connections.filter(
    (item) => item.feishuConnectionState === "connected",
  ).length;
  const pendingReviews = new Set(
    data.reviewQueue
      .filter((item) => item.review_state === "IN_PROGRESS")
      .map((item) => item.partner_id),
  ).size;
  const modelFailures = data.jobs
    .filter((job) => job.status === "FAILED" || job.status === "RETRY_WAIT")
    .reduce((sum, job) => sum + job.count, 0);
  const openPeriod = selectCurrentOpenPeriod(data.periods);
  const filtered = data.connections.filter(
    (item) =>
      (!pluginStatus || item.connectionState === pluginStatus) &&
      (!feishuStatus || item.feishuConnectionState === feishuStatus) &&
      (!reviewStage || item.reviewProgress.stage === reviewStage) &&
      [item.partnerName, item.partnerEmail, item.deviceName]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  const selected =
    visible.find((item) => item.partnerId === selectedId) ?? visible[0];
  const partner = data.partners.find((item) => item.id === selected?.partnerId);
  const codes = data.bindingCodes.filter(
    (item) =>
      item.partner_id === selected?.partnerId &&
      ["active", "connecting", "claimed"].includes(item.status) &&
      item.code_value,
  );
  const activeBindingCode =
    codes.find((item) => ["active", "connecting"].includes(item.status)) ??
    null;
  const bindingCode = activeBindingCode ?? codes[0] ?? null;
  const recoverableInstanceId =
    selected?.connectionState === "expired" ? null : selected?.pluginInstanceId;
  const resetSelection = () => {
    setPage(1);
    setSelectedId(null);
    setDetailOpen(false);
  };
  const clearFilters = () => {
    setSearch("");
    setPluginStatus("");
    setFeishuStatus("");
    setReviewStage("");
    resetSelection();
  };

  return (
    <div className="page admin-page management-page overview-page">
      <AdminHeader
        title="运行总览"
        icon={LayoutDashboard}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        context={
          openPeriod ? (
            <>
              <span>{openPeriod.period_key}</span>
              <span>下次聚合 {formatFullTime(openPeriod.cutoff_at)}</span>
            </>
          ) : (
            "暂无开放周期"
          )
        }
      >
        <Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
          新增人员
        </Button>
      </AdminHeader>
      <ErrorBanner error={error} />
      <AdminMetrics
        items={[
          {
            label: "插件已连接",
            value: `${connected} / ${data.connections.length}`,
            tone: "success",
            href: "/admin/plugin-logs",
          },
          {
            label: "飞书已连接",
            value: `${feishuConnected} / ${data.connections.length}`,
            tone: "success",
          },
          {
            label: "待审核人员",
            value: pendingReviews,
            tone: "warning",
            href: "/admin/reviews",
          },
          {
            label: "中台任务异常",
            value: modelFailures,
            tone: modelFailures ? "danger" : "",
            href: "/admin/jobs",
          },
        ]}
      />
      <AdminTabs
        label="运行总览视图"
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "people",
            label: "人员管理",
            icon: Users,
            count: data.connections.length,
          },
          { value: "schedule", label: "生成设置", icon: Settings2 },
        ]}
      />
      <div
        id="aw-panel-people"
        role="tabpanel"
        aria-labelledby="aw-tab-people"
        hidden={tab !== "people"}
      >
        <div className="aw-toolbar">
          <AdminSearch
            label="搜索人员"
            placeholder="搜索姓名、邮箱或设备"
            value={search}
            onChange={(value) => {
              setSearch(value);
              resetSelection();
            }}
          />
          <label className="aw-filter">
            <span>插件</span>
            <select
              aria-label="插件连接状态"
              value={pluginStatus}
              onChange={(event) => {
                setPluginStatus(event.target.value);
                resetSelection();
              }}
            >
              <option value="">全部状态</option>
              {Object.entries(statusLabel).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="aw-filter">
            <span>飞书</span>
            <select
              aria-label="飞书连接状态"
              value={feishuStatus}
              onChange={(event) => {
                setFeishuStatus(event.target.value);
                resetSelection();
              }}
            >
              <option value="">全部状态</option>
              {Object.entries(feishuStatusLabel).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="aw-filter">
            <span>审核</span>
            <select
              aria-label="人员审核进度"
              value={reviewStage}
              onChange={(event) => {
                setReviewStage(event.target.value);
                resetSelection();
              }}
            >
              <option value="">全部进度</option>
              {Object.entries(reviewStageLabel).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {(search || pluginStatus || feishuStatus || reviewStage) && (
            <button className="aw-text-button" onClick={clearFilters}>
              <X size={14} />
              重置筛选
            </button>
          )}
        </div>
        <AdminWorkspace
          label="人员详情"
          selectionKey={selected?.partnerId}
          open={detailOpen}
          onBack={() => setDetailOpen(false)}
          list={
            <>
              <div className="aw-section-heading">
                <h2>
                  人员连接状态 <span>{filtered.length}</span>
                </h2>
                <span>每 15 秒更新</span>
              </div>
              <AdminTableScroll
                resetKey={JSON.stringify([
                  currentPage,
                  search,
                  pluginStatus,
                  feishuStatus,
                  reviewStage,
                ])}
              >
                <table className="aw-table aw-person-table">
                  <thead>
                    <tr>
                      <th>人员</th>
                      <th>插件连接</th>
                      <th>飞书连接</th>
                      <th>审核进度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => (
                      <tr
                        key={item.partnerId}
                        className={
                          item.partnerId === selected?.partnerId
                            ? "is-selected"
                            : ""
                        }
                      >
                        <td>
                          <button
                            className="aw-record-button"
                            aria-label={`查看 ${item.partnerName} 的详情`}
                            aria-pressed={
                              item.partnerId === selected?.partnerId
                            }
                            onClick={() => {
                              setSelectedId(item.partnerId);
                              setDetailOpen(true);
                            }}
                          >
                            <strong>{item.partnerName}</strong>
                            <small>{item.partnerEmail}</small>
                          </button>
                        </td>
                        <td>
                          <Badge tone={statusTone[item.connectionState]}>
                            {statusLabel[item.connectionState] ??
                              item.connectionState}
                          </Badge>
                          <small>上传 {formatTime(item.lastUploadAt)}</small>
                        </td>
                        <td>
                          <Badge
                            tone={feishuStatusTone[item.feishuConnectionState]}
                          >
                            {feishuStatusLabel[item.feishuConnectionState] ??
                              item.feishuConnectionState}
                          </Badge>
                          <small>{feishuStatusDetail(item)}</small>
                        </td>
                        <td>
                          <div className="aw-progress">
                            <strong>
                              {item.reviewProgress.reviewed} /{" "}
                              {item.reviewProgress.total}
                            </strong>
                            <progress
                              aria-label={`${item.partnerName} 审核卡片进度`}
                              max={Math.max(1, item.reviewProgress.total)}
                              value={item.reviewProgress.reviewed}
                            />
                          </div>
                          <small>
                            {reviewStageLabel[item.reviewProgress.stage]}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </AdminTableScroll>
              {!visible.length && (
                <EmptyState
                  title={
                    data.connections.length
                      ? "没有符合条件的人员"
                      : "还没有人员"
                  }
                  action={
                    data.connections.length ? (
                      <button className="aw-text-button" onClick={clearFilters}>
                        重置筛选
                      </button>
                    ) : undefined
                  }
                />
              )}
              <AdminPagination
                page={currentPage}
                pageCount={pageCount}
                total={filtered.length}
                onChange={(value) => {
                  setPage(value);
                  setSelectedId(null);
                  setDetailOpen(false);
                }}
              />
            </>
          }
        >
          {selected ? (
            <>
              <header className="aw-detail-header">
                <div>
                  <span className="aw-kicker">人员详情</span>
                  <h2>{selected.partnerName}</h2>
                  <p>{selected.partnerEmail}</p>
                </div>
                <button
                  className="icon-button"
                  title="编辑姓名"
                  aria-label={`编辑 ${selected.partnerName} 的姓名`}
                  disabled={!partner}
                  onClick={() => setEditPartner(partner)}
                >
                  <Pencil size={15} />
                </button>
              </header>
              <section className="aw-detail-section">
                <h3>
                  <Laptop size={16} />
                  设备与连接
                </h3>
                <dl className="aw-meta">
                  <div>
                    <dt>插件设备</dt>
                    <dd>{selected.deviceName ?? "尚未配置"}</dd>
                  </div>
                  <div>
                    <dt>插件版本</dt>
                    <dd>{selected.version ? `v${selected.version}` : "--"}</dd>
                  </div>
                  <div>
                    <dt>最近连接测试</dt>
                    <dd>{formatTime(selected.verifiedAt)}</dd>
                  </div>
                  <div>
                    <dt>最近上传</dt>
                    <dd>{formatTime(selected.lastUploadAt)}</dd>
                  </div>
                  <div className="aw-meta-full">
                    <dt>飞书连接</dt>
                    <dd>
                      <Badge
                        tone={feishuStatusTone[selected.feishuConnectionState]}
                      >
                        {feishuStatusLabel[selected.feishuConnectionState]}
                      </Badge>{" "}
                      · {feishuStatusDetail(selected)}
                    </dd>
                  </div>
                  <div className="aw-meta-full">
                    <dt>绑定码</dt>
                    <dd className="aw-binding-code">
                      {bindingCode ? (
                        <>
                          <code>{bindingCode.code_value}</code>
                          <button
                            className="icon-button"
                            title="复制绑定码"
                            aria-label={`复制 ${selected.partnerName} 的绑定码`}
                            onClick={async () => {
                              await copyText(bindingCode.code_value);
                              setCopiedCodeId(bindingCode.id);
                              window.setTimeout(
                                () => setCopiedCodeId(null),
                                1600,
                              );
                            }}
                          >
                            {copiedCodeId === bindingCode.id ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </>
                      ) : (
                        "暂无绑定码"
                      )}
                    </dd>
                  </div>
                </dl>
              </section>
              <section className="aw-detail-section">
                <h3>
                  <ClipboardCheck size={16} />
                  工作卡片审核{" "}
                  <Badge>
                    {selected.reviewProgress.periodKey ?? "暂无周期"}
                  </Badge>
                </h3>
                <dl className="aw-meta">
                  <div>
                    <dt>当前进度</dt>
                    <dd>
                      {reviewStageLabel[selected.reviewProgress.stage]} ·{" "}
                      {selected.reviewProgress.reviewed} /{" "}
                      {selected.reviewProgress.total}
                    </dd>
                  </div>
                  <div>
                    <dt>卡片明细</dt>
                    <dd>
                      {selected.reviewProgress.pending} 待审 ·{" "}
                      {selected.reviewProgress.approved} 通过 ·{" "}
                      {selected.reviewProgress.excluded} 忽略
                    </dd>
                  </div>
                </dl>
              </section>
              <div className="aw-detail-actions">
                <Button
                  variant="secondary"
                  icon={<ShieldCheck size={15} />}
                  onClick={() => setScopeFor(selected)}
                >
                  采集权限
                </Button>
                <Button
                  variant="secondary"
                  icon={<KeyRound size={15} />}
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
                  title="删除人员"
                  aria-label={`删除 ${selected.partnerName}`}
                  disabled={!partner}
                  onClick={() => setRemovePartner(partner)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </>
          ) : (
            <EmptyState title="暂无人员详情" />
          )}
        </AdminWorkspace>
      </div>
      <div
        id="aw-panel-schedule"
        role="tabpanel"
        aria-labelledby="aw-tab-schedule"
        hidden={tab !== "schedule"}
      >
        <ScheduleSettings team={data.team} openPeriod={openPeriod} />
      </div>
      {createOpen && (
        <CreatePartnerModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void refresh();
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
            void refresh();
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
            void refresh();
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
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-project-scopes", connection.partnerId],
    queryFn: () =>
      api<AdminProjectScope>(
        `/v1/admin/partners/${connection.partnerId}/project-scopes`,
      ),
  });
  const reapproval = useMutation({
    mutationFn: (instance: AdminProjectScope["instances"][number]) =>
      api(
        `/v1/admin/plugin-instances/${instance.id}/project-scopes/reapproval`,
        {
          method: "POST",
          body: JSON.stringify({ baseVersion: instance.policyVersion }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin-project-scopes", connection.partnerId],
      });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
  });
  const data = query.data;

  return (
    <Modal
      title={`${connection.partnerName} 的采集权限`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {query.isLoading ? (
        <div className="scope-loading">
          <RefreshCw className="spin" size={18} />
          <span>正在加载</span>
        </div>
      ) : query.isError ? (
        <ErrorBanner error={query.error} />
      ) : data ? (
        <>
          <ErrorBanner error={reapproval.error} />
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
                    <div className="scope-instance-actions">
                      <Badge
                        tone={instance.initialized ? "success" : "warning"}
                      >
                        {instance.initialized ? "审批已完成" : "等待审批"}
                      </Badge>
                      {instance.initialized && instance.projects.length > 0 && (
                        <Button
                          variant="secondary"
                          icon={<Send size={14} />}
                          loading={
                            reapproval.isPending &&
                            reapproval.variables?.id === instance.id
                          }
                          disabled={reapproval.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                "重新发起后，当前项目的采集权限会立即暂停，用户需要在飞书重新审核。确认继续吗？",
                              )
                            )
                              reapproval.mutate(instance);
                          }}
                        >
                          重新发起审核
                        </Button>
                      )}
                    </div>
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
    defaults.factCutoffTime ?? "17:00",
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
    <section className="aw-section">
      <div className="aw-section-heading">
        <h2>
          <CalendarClock size={17} />
          报告生成计划
        </h2>
        <span>Asia/Shanghai</span>
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
              onChange={(event) => {
                setCutoffDay(event.target.value);
                saveDefaults.reset();
              }}
            >
              {weekdayOptions()}
            </select>
          </Field>
          <Field label="聚合时间">
            <input
              type="time"
              value={cutoffTime}
              onChange={(event) => {
                setCutoffTime(event.target.value);
                saveDefaults.reset();
              }}
            />
          </Field>
        </div>
        <Button
          variant="secondary"
          icon={<Save size={16} />}
          loading={saveDefaults.isPending}
          disabled={!/^\d{2}:\d{2}$/.test(cutoffTime)}
          onClick={() => saveDefaults.mutate()}
        >
          保存生成时间
        </Button>
      </div>
      {saveDefaults.isSuccess && (
        <div className="aw-schedule-status" role="status">
          <Check size={16} />
          生成时间已保存
        </div>
      )}
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
          插件令牌和未使用绑定码会立即失效。历史采集与审核记录仍会保留。
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
