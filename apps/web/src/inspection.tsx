import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCw,
  ScanSearch,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
import {
  AdminFilterBar,
  AdminMetrics,
  WorkspaceHeader,
} from "./admin-workspace.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Modal,
  SuccessBanner,
} from "./components.js";
import {
  DetailList,
  collectorCodeLabels,
  errorCodeLabel,
  formatTime,
  jobStatusLabel,
  jobTypeMeta,
} from "./monitoring-common.js";
import "./monitoring.css";

type Chain = "app" | "system" | "pipeline";
type FindingSeverity = "warning" | "critical";
type AnalysisStatus = "none" | "queued" | "running" | "completed" | "failed";

type FindingJob = {
  id: string;
  type: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
};

type FindingAnalysis = {
  summary: string;
  likelyCause: string;
  impact: string;
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  relatedChain: Chain;
};

type Finding = {
  id: string;
  chain: Chain;
  rule: string;
  severity: FindingSeverity;
  partnerId: string | null;
  partnerName: string | null;
  subject: string;
  title: string;
  evidence: {
    eventIds?: string[];
    codes?: string[];
    counts?: Record<string, number>;
    timestamps?: Record<string, string>;
    jobIds?: string[];
    uploadId?: string;
    deviceId?: string;
    executionId?: string;
    partnerId?: string;
  };
  status: "open" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrences: number;
  analysis: FindingAnalysis | null;
  analysisStatus: AnalysisStatus;
  analysisError: { code: string; message: string } | null;
  jobs: FindingJob[];
};

type InspectionRun = {
  id: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string | null;
  openedCount: number;
  resolvedCount: number;
  openCount: number;
  error: string | null;
};

type Inspection = {
  checkedAt: string;
  running: boolean;
  modelConfigured: boolean;
  lastRun: InspectionRun | null;
  summary: {
    open: Record<Chain, Record<FindingSeverity, number>>;
    openTotal: number;
    resolvedTotal: number;
  };
  members: Array<{ id: string; name: string }>;
  findings: Finding[];
};

const chainLabel: Record<Chain, string> = {
  app: "App 链路",
  system: "系统链路",
  pipeline: "处理链路",
};

const severityText: Record<FindingSeverity, string> = {
  warning: "需关注",
  critical: "异常",
};

const analysisStatusLabel: Record<AnalysisStatus, string> = {
  none: "未研判",
  queued: "排队",
  running: "分析中",
  completed: "完成",
  failed: "失败",
};

const confidenceLabel = { high: "高", medium: "中", low: "低" };

const evidenceCountLabel: Record<string, string> = {
  events: "相关事件数",
  errors: "错误数",
  jobs: "相关任务数",
  failed: "失败数",
  retrying: "等待重试数",
  pending: "待处理数",
  expired: "租约过期数",
  notifications: "未投递通知数",
  sessions: "会话数",
};

const analysisPending = (status: AnalysisStatus) =>
  status === "queued" || status === "running";

const jobActionable = (job: FindingJob) =>
  job.status === "FAILED" || job.status === "RETRY_WAIT";

export function InspectionPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [chain, setChain] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [clearJob, setClearJob] = useState<FindingJob | null>(null);

  const params = new URLSearchParams({ status });
  if (chain) params.set("chain", chain);
  if (partnerId) params.set("partnerId", partnerId);
  const query = useQuery({
    queryKey: ["admin-inspection", status, chain, partnerId],
    queryFn: () => api<Inspection>(`/v1/admin/inspection?${params}`),
    placeholderData: (previous) => previous,
    refetchInterval: (current) =>
      current.state.data?.running ||
      current.state.data?.findings.some((item) =>
        analysisPending(item.analysisStatus),
      )
        ? 5_000
        : 15_000,
  });
  const data = query.data;
  const findings = data?.findings ?? [];
  const selected =
    findings.find((item) => item.id === selectedId) ?? findings[0] ?? null;

  useEffect(() => {
    setSuccess(null);
  }, [selected?.id]);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-inspection"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
    ]);
  const run = useMutation({
    mutationFn: () =>
      api("/v1/admin/inspection/run", { method: "POST" }),
    onSuccess: async () => {
      setSuccess("巡检已完成。");
      await invalidate();
    },
    onError: () => setSuccess(null),
  });
  const analyze = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/admin/inspection/findings/${id}/analyze`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/admin/agent-jobs/${id}/retry`, { method: "POST" }),
    onSuccess: async () => {
      setSuccess("任务已重新入队，等待执行。");
      await invalidate();
    },
  });
  const clear = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/admin/agent-jobs/${id}/clear`, { method: "POST" }),
    onSuccess: async () => {
      setSuccess("异常任务已清除，任务记录已保留。");
      setClearJob(null);
      await invalidate();
    },
  });

  const open = data?.summary.open;
  const chainTotal = (key: Chain) =>
    open ? open[key].warning + open[key].critical : 0;

  return (
    <div className="page admin-page management-page monitoring-page">
      <WorkspaceHeader
        title="异常巡检"
        icon={ScanSearch}
        context="定时巡检 App、系统与处理链路，汇总异常并给出研判"
      >
        <div className="sm-refresh-time">
          <span>
            {data?.running
              ? "巡检进行中"
              : data?.lastRun
                ? `上次巡检 ${formatTime(data.lastRun.finishedAt ?? data.lastRun.startedAt)}`
                : data
                  ? "尚未巡检"
                  : "等待巡检状态"}
          </span>
        </div>
        <Button
          icon={<Play size={16} />}
          loading={run.isPending || Boolean(data?.running)}
          onClick={() => run.mutate()}
        >
          立即巡检
        </Button>
        <button
          className="icon-button"
          title="刷新异常巡检"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} className={query.isFetching ? "spin" : ""} />
        </button>
      </WorkspaceHeader>
      {success && <SuccessBanner>{success}</SuccessBanner>}
      <ErrorBanner
        error={
          query.error ?? run.error ?? analyze.error ?? retry.error ?? clear.error
        }
      />
      {data?.lastRun?.error && (
        <ErrorBanner error={`上次巡检未完成：${data.lastRun.error}`} />
      )}
      <AdminMetrics
        items={[
          {
            label: "未处理异常",
            value: data?.summary.openTotal ?? 0,
            tone: data?.summary.openTotal ? "danger" : "success",
          },
          ...(["app", "system", "pipeline"] as const).map((key) => ({
            label: chainLabel[key],
            value: open
              ? `${chainTotal(key)}（异常 ${open[key].critical} · 需关注 ${open[key].warning}）`
              : 0,
            ...(open && open[key].critical > 0
              ? { tone: "danger" }
              : open && open[key].warning > 0
                ? { tone: "warning" }
                : {}),
          })),
        ]}
      />
      <section className="aw-view sm-view">
        <AdminFilterBar label="巡检筛选">
          <label className="aw-filter">
            <span>状态</span>
            <select
              aria-label="巡检状态"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "open" | "resolved");
                setSelectedId(null);
                setMobileDetail(false);
              }}
            >
              <option value="open">未处理</option>
              <option value="resolved">已恢复</option>
            </select>
          </label>
          <label className="aw-filter">
            <span>链路</span>
            <select
              aria-label="巡检链路"
              value={chain}
              onChange={(event) => {
                setChain(event.target.value);
                setSelectedId(null);
                setMobileDetail(false);
              }}
            >
              <option value="">全部链路</option>
              {(Object.keys(chainLabel) as Chain[]).map((key) => (
                <option key={key} value={key}>
                  {chainLabel[key]}
                </option>
              ))}
            </select>
          </label>
          <label className="aw-filter">
            <span>成员</span>
            <select
              aria-label="巡检成员"
              value={partnerId}
              onChange={(event) => {
                setPartnerId(event.target.value);
                setSelectedId(null);
                setMobileDetail(false);
              }}
            >
              <option value="">全部成员</option>
              {data?.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        </AdminFilterBar>
        <div
          className={`sm-log-workspace ${mobileDetail ? "sm-show-detail" : ""}`}
        >
          <div className="sm-records" aria-label="异常列表">
            <div className="sm-section-heading">
              <h2>
                异常发现 <span>{findings.length}</span>
              </h2>
              <span>
                {data?.lastRun
                  ? `上次新增 ${data.lastRun.openedCount} · 恢复 ${data.lastRun.resolvedCount}`
                  : ""}
              </span>
            </div>
            <div className="sm-record-scroll">
              {findings.length ? (
                <ul className="sm-finding-list">
                  {findings.map((finding) => (
                    <li
                      key={finding.id}
                      className={
                        finding.id === selected?.id ? "is-selected" : ""
                      }
                    >
                      <button
                        className="sm-finding-button"
                        aria-pressed={finding.id === selected?.id}
                        onClick={() => {
                          setSelectedId(finding.id);
                          setMobileDetail(true);
                        }}
                      >
                        <span className="sm-record-title">
                          <span className="sm-source-tag">
                            {chainLabel[finding.chain]}
                          </span>
                          <strong>{finding.title}</strong>
                        </span>
                        <span className="sm-record-subject">
                          {finding.partnerName ?? finding.subject}
                        </span>
                        <span className="sm-finding-meta">
                          <Badge
                            tone={
                              finding.severity === "critical"
                                ? "danger"
                                : "warning"
                            }
                          >
                            {severityText[finding.severity]}
                          </Badge>
                          <small>
                            最近 {formatTime(finding.lastSeenAt)} · 出现{" "}
                            {finding.occurrences} 次
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : query.isLoading ? (
                <div className="sm-loading" role="status">
                  <LoaderCircle size={18} className="spin" />
                  加载巡检结果
                </div>
              ) : (
                <EmptyState
                  title={
                    query.isError
                      ? "巡检结果暂时无法加载"
                      : status === "open"
                        ? "当前没有未处理的异常"
                        : "没有已恢复的异常"
                  }
                />
              )}
            </div>
          </div>
          <section className="sm-detail" aria-label="异常详情">
            <button
              className="sm-text-button sm-back"
              onClick={() => setMobileDetail(false)}
            >
              <ArrowLeft size={15} />
              返回异常列表
            </button>
            {selected ? (
              <FindingDetail
                finding={selected}
                modelConfigured={data?.modelConfigured ?? false}
                analyzing={analyze.isPending}
                retrying={retry.isPending}
                onAnalyze={() => analyze.mutate(selected.id)}
                onRetry={(job) => retry.mutate(job.id)}
                onClear={setClearJob}
              />
            ) : (
              <EmptyState
                title={query.isLoading ? "等待巡检结果" : "选择一条异常查看详情"}
              />
            )}
          </section>
        </div>
      </section>
      {clearJob && (
        <Modal
          title="清除异常任务"
          onClose={() => !clear.isPending && setClearJob(null)}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={clear.isPending}
                onClick={() => setClearJob(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                icon={<Trash2 size={16} />}
                loading={clear.isPending}
                onClick={() => clear.mutate(clearJob.id)}
              >
                确认清除
              </Button>
            </>
          }
        >
          <p className="modal-copy">
            {`“${jobTypeMeta[clearJob.type]?.label ?? clearJob.type}”将从异常任务中移除，任务记录和错误信息仍会保留在审计链路中。`}
          </p>
        </Modal>
      )}
    </div>
  );
}

function FindingDetail({
  finding,
  modelConfigured,
  analyzing,
  retrying,
  onAnalyze,
  onRetry,
  onClear,
}: {
  finding: Finding;
  modelConfigured: boolean;
  analyzing: boolean;
  retrying: boolean;
  onAnalyze: () => void;
  onRetry: (job: FindingJob) => void;
  onClear: (job: FindingJob) => void;
}) {
  const { evidence, analysis } = finding;
  const memberId = finding.partnerId ?? evidence.partnerId;
  const pending = analysisPending(finding.analysisStatus);
  const evidenceEntries: Array<[string, React.ReactNode]> = [
    ...(evidence.codes?.length
      ? ([
          [
            "事件代码",
            evidence.codes
              .map((code) => collectorCodeLabels[code] ?? code)
              .join("、"),
          ],
        ] as Array<[string, React.ReactNode]>)
      : []),
    ...Object.entries(evidence.counts ?? {}).map(
      ([key, value]) =>
        [evidenceCountLabel[key] ?? key, String(value)] as [string, string],
    ),
    ...Object.entries(evidence.timestamps ?? {}).map(
      ([key, value]) =>
        [key, formatTime(value)] as [string, string],
    ),
    ...(evidence.eventIds?.length
      ? ([["关联日志", `${evidence.eventIds.length} 条`]] as Array<
          [string, React.ReactNode]
        >)
      : []),
    ...(evidence.uploadId
      ? ([["关联上传", <code key="u">{evidence.uploadId}</code>]] as Array<
          [string, React.ReactNode]
        >)
      : []),
    ...(evidence.deviceId
      ? ([["关联设备", <code key="d">{evidence.deviceId}</code>]] as Array<
          [string, React.ReactNode]
        >)
      : []),
  ];
  return (
    <>
      <header className="sm-detail-header">
        <div>
          <span className="sm-kicker">
            {chainLabel[finding.chain]} · {finding.rule}
          </span>
          <h2>{finding.title}</h2>
        </div>
        <Badge tone={finding.severity === "critical" ? "danger" : "warning"}>
          {finding.status === "resolved"
            ? "已恢复"
            : severityText[finding.severity]}
        </Badge>
      </header>
      <dl className="sm-meta">
        <div>
          <dt>对象</dt>
          <dd>{finding.partnerName ?? finding.subject}</dd>
        </div>
        <div>
          <dt>出现次数</dt>
          <dd>{finding.occurrences}</dd>
        </div>
        <div>
          <dt>首次发现</dt>
          <dd>{formatTime(finding.firstSeenAt)}</dd>
        </div>
        <div>
          <dt>最近发现</dt>
          <dd>{formatTime(finding.lastSeenAt)}</dd>
        </div>
        {finding.resolvedAt && (
          <div>
            <dt>恢复时间</dt>
            <dd>{formatTime(finding.resolvedAt)}</dd>
          </div>
        )}
      </dl>
      <section aria-label="异常证据">
        <div className="sm-section-heading">
          <h3>
            <AlertTriangle size={16} />
            证据
          </h3>
        </div>
        {evidenceEntries.length ? (
          <DetailList entries={evidenceEntries} />
        ) : (
          <p className="sm-job-hint">没有附带更多证据。</p>
        )}
        <p className="sm-evidence-links">
          {finding.chain === "app" && memberId && (
            <Link href={`/admin/user-logs?partnerId=${memberId}`}>
              <ExternalLink size={13} />
              查看该成员的用户日志
            </Link>
          )}
          {evidence.executionId && (
            <Link
              href={`/admin/system-logs?executionId=${encodeURIComponent(evidence.executionId)}`}
            >
              <ExternalLink size={13} />
              查看任务运行记录
            </Link>
          )}
        </p>
      </section>
      <section className="sm-analysis" aria-label="AI 研判">
        <div className="sm-section-heading">
          <h3>
            <Sparkles size={16} />
            AI 研判
          </h3>
          <button
            className="sm-analysis-button"
            disabled={analyzing || pending || !modelConfigured}
            onClick={onAnalyze}
          >
            {analyzing || pending ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {finding.analysisStatus === "none" ? "开始研判" : "重新研判"}
          </button>
        </div>
        <div className="sm-analysis-body">
          <p>
            状态：<strong>{analysisStatusLabel[finding.analysisStatus]}</strong>
            {!modelConfigured && "（未配置模型，无法研判）"}
          </p>
          {finding.analysisStatus === "failed" && (
            <p role="alert">
              {finding.analysisError?.message ??
                finding.analysisError?.code ??
                "研判失败，请重试。"}
            </p>
          )}
          {analysis && finding.analysisStatus === "completed" && (
            <>
              <strong>{analysis.summary}</strong>
              <dl>
                <div>
                  <dt>可能原因</dt>
                  <dd>{analysis.likelyCause}</dd>
                </div>
                <div>
                  <dt>影响范围</dt>
                  <dd>{analysis.impact}</dd>
                </div>
                <div>
                  <dt>关联链路</dt>
                  <dd>{chainLabel[analysis.relatedChain]}</dd>
                </div>
              </dl>
              <h4>建议处理</h4>
              <ol>
                {analysis.recommendedActions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ol>
              <small>可信度：{confidenceLabel[analysis.confidence]}</small>
            </>
          )}
        </div>
      </section>
      {finding.jobs.length > 0 && (
        <section className="sm-jobs" aria-label="关联任务">
          <div className="sm-section-heading">
            <h3>
              <RotateCw size={16} />
              关联任务 <span>{finding.jobs.length}</span>
            </h3>
          </div>
          <ul className="sm-job-list">
            {finding.jobs.map((job) => (
              <li key={job.id}>
                <div className="sm-job-head">
                  <strong>{jobTypeMeta[job.type]?.label ?? job.type}</strong>
                  <Badge
                    tone={
                      job.status === "FAILED"
                        ? "danger"
                        : job.status === "COMPLETED"
                          ? "success"
                          : "warning"
                    }
                  >
                    {jobStatusLabel[job.status] ?? job.status}
                  </Badge>
                </div>
                <DetailList
                  entries={[
                    [
                      "错误",
                      job.errorCode
                        ? (errorCodeLabel[job.errorCode] ?? job.errorCode)
                        : "未提供错误码",
                    ],
                    [
                      "错误信息",
                      job.errorMessage?.trim() || "任务未返回更详细的错误信息。",
                    ],
                    ["累计尝试", `${job.attemptCount} / ${job.maxAttempts}`],
                    [
                      "下次重试",
                      formatTime(job.nextRetryAt, undefined, "无计划"),
                    ],
                    ["任务 ID", <code key="id">{job.id}</code>],
                  ]}
                />
                {jobActionable(job) ? (
                  <div className="sm-job-actions">
                    <Button
                      icon={<RotateCw size={16} />}
                      loading={retrying}
                      onClick={() => onRetry(job)}
                    >
                      手动重试
                    </Button>
                    <Button
                      variant="danger"
                      icon={<Trash2 size={16} />}
                      disabled={retrying}
                      onClick={() => onClear(job)}
                    >
                      清除异常
                    </Button>
                    <span>重新入队后保留累计尝试次数，并开放至少 3 次执行机会。</span>
                  </div>
                ) : (
                  <p className="sm-job-hint">
                    <CheckCircle2 size={13} />
                    该任务当前不处于失败或等待重试状态，无需手动处理。
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
