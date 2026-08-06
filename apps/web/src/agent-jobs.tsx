import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Laptop,
  RefreshCw,
  RotateCw,
  Trash2,
  UserRound,
} from "lucide-react";
import { Link } from "wouter";
import { api } from "./api.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Modal,
  SuccessBanner,
} from "./components.js";

type AgentJob = {
  id: string;
  partner_id: string | null;
  plugin_instance_id: string | null;
  partner_name: string | null;
  plugin_device_name: string | null;
  type: string;
  status: "FAILED" | "RETRY_WAIT";
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

const jobTypeMeta: Record<string, { label: string; stage: string }> = {
  AGGREGATE_WORK_ITEMS: {
    label: "工作卡聚合",
    stage: "中台模型正在把 Session Fact 聚合为项目工作卡",
  },
  GENERATE_INDIVIDUAL_REPORT: {
    label: "个人报告生成",
    stage: "中台模型正在从已审核工作卡生成个人报告",
  },
  REGENERATE_INDIVIDUAL_REPORT: {
    label: "个人报告重新生成",
    stage: "中台模型正在根据审核意见修订个人报告",
  },
  GENERATE_TEAM_REPORT: {
    label: "团队报告生成",
    stage: "中台模型正在汇总已锁定的个人报告",
  },
  REGENERATE_TEAM_REPORT: {
    label: "团队报告重新生成",
    stage: "中台模型正在重新汇总团队报告",
  },
  RESCAN_SESSIONS: {
    label: "本地会话扫描",
    stage: "Codex 插件正在重新扫描本地 Session",
  },
  REANALYZE_SESSIONS: {
    label: "本地会话重新分析",
    stage: "Codex 插件正在重新提取本地 Session 贡献",
  },
};

const errorCodeLabel: Record<string, string> = {
  MODEL_NOT_CONFIGURED: "中台模型尚未配置",
  CENTRAL_GENERATION_FAILED: "中台模型生成失败",
  LEASE_EXHAUSTED: "任务租约多次过期",
};

export function AgentJobsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clearJob, setClearJob] = useState<AgentJob | null>(null);
  const query = useQuery({
    queryKey: ["admin-agent-jobs", "exceptions"],
    queryFn: async () => {
      const [failed, retryWait] = await Promise.all([
        api<AgentJob[]>("/v1/admin/agent-jobs?status=FAILED"),
        api<AgentJob[]>("/v1/admin/agent-jobs?status=RETRY_WAIT"),
      ]);
      return [...failed, ...retryWait].sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    },
    refetchInterval: 15_000,
  });
  const jobs = query.data ?? [];
  useEffect(() => {
    if (!selectedId && jobs[0]) setSelectedId(jobs[0].id);
    if (selectedId && !jobs.some((job) => job.id === selectedId))
      setSelectedId(jobs[0]?.id ?? null);
  }, [jobs, selectedId]);
  const selected = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );
  const retry = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/admin/agent-jobs/${id}/retry`, { method: "POST" }),
    onSuccess: async () => {
      setSuccess("任务已重新入队，等待执行。");
      setSelectedId(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["admin-agent-jobs", "exceptions"],
        }),
        queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
      ]);
    },
  });
  const clear = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/admin/agent-jobs/${id}/clear`, { method: "POST" }),
    onSuccess: async () => {
      setSuccess("异常任务已清除，任务记录已保留。");
      setClearJob(null);
      setSelectedId(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["admin-agent-jobs", "exceptions"],
        }),
        queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
      ]);
    },
  });

  return (
    <div className="page admin-page agent-jobs-page">
      <header className="page-header agent-jobs-header">
        <div>
          <span className="eyebrow">ADMIN OPERATIONS</span>
          <h1>异常任务</h1>
          <p>定位中台或 Codex 插件的失败环节，并手动重新入队</p>
        </div>
        <div className="header-actions">
          <Link className="button button-ghost" href="/admin">
            <ArrowLeft size={16} />
            <span>返回总览</span>
          </Link>
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} />}
            loading={query.isFetching}
            onClick={() => query.refetch()}
          >
            刷新
          </Button>
        </div>
      </header>

      {success && <SuccessBanner>{success}</SuccessBanner>}
      <ErrorBanner error={query.error ?? retry.error ?? clear.error} />

      {!query.isLoading && jobs.length === 0 ? (
        <EmptyState title="当前没有失败或等待重试的任务" />
      ) : (
        <div className="agent-jobs-layout">
          <section className="agent-job-list" aria-label="异常任务列表">
            <div className="agent-job-list-heading">
              <strong>异常任务</strong>
              <span>{jobs.length} 条</span>
            </div>
            {query.isLoading ? (
              <div className="page-loading">
                <RefreshCw className="spin" />
                加载任务
              </div>
            ) : (
              jobs.map((job) => {
                const meta = jobTypeMeta[job.type];
                return (
                  <button
                    className={`agent-job-row ${selectedId === job.id ? "selected" : ""}`}
                    key={job.id}
                    onClick={() => {
                      setSelectedId(job.id);
                      setSuccess(null);
                    }}
                  >
                    <span className="agent-job-alert">
                      <AlertTriangle size={17} />
                    </span>
                    <span className="agent-job-row-copy">
                      <strong>{meta?.label ?? job.type}</strong>
                      <small>{job.partner_name ?? "团队级任务"}</small>
                    </span>
                    <Badge
                      tone={job.status === "FAILED" ? "danger" : "warning"}
                    >
                      {job.status === "FAILED" ? "已失败" : "等待重试"}
                    </Badge>
                  </button>
                );
              })
            )}
          </section>

          <section className="agent-job-detail" aria-label="任务阻塞详情">
            {selected ? (
              <AgentJobDetail
                job={selected}
                retrying={retry.isPending}
                onRetry={() => retry.mutate(selected.id)}
                onClear={() => setClearJob(selected)}
              />
            ) : (
              <EmptyState title="选择一条任务查看阻塞详情" />
            )}
          </section>
        </div>
      )}
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

function AgentJobDetail({
  job,
  retrying,
  onRetry,
  onClear,
}: {
  job: AgentJob;
  retrying: boolean;
  onRetry: () => void;
  onClear: () => void;
}) {
  const meta = jobTypeMeta[job.type];
  const errorTitle = job.error_code
    ? (errorCodeLabel[job.error_code] ?? job.error_code)
    : "未提供错误码";
  return (
    <>
      <div className="agent-job-detail-header">
        <div>
          <span className="eyebrow">BLOCKED AT</span>
          <h2>{meta?.label ?? job.type}</h2>
          <p>{meta?.stage ?? "任务执行过程中发生异常"}</p>
        </div>
        <Badge tone={job.status === "FAILED" ? "danger" : "warning"}>
          {job.status === "FAILED" ? "已失败" : "等待重试"}
        </Badge>
      </div>

      <div className="agent-job-context">
        <JobContext
          icon={<UserRound size={16} />}
          label="影响人员"
          value={job.partner_name ?? "团队级任务"}
        />
        <JobContext
          icon={<Laptop size={16} />}
          label="执行设备"
          value={job.plugin_device_name ?? "中台 Worker"}
        />
        <JobContext
          icon={<RotateCw size={16} />}
          label="累计尝试"
          value={`${job.attempt_count} / ${job.max_attempts}`}
        />
        <JobContext
          icon={<Clock3 size={16} />}
          label="最后异常"
          value={formatFullTime(job.updated_at)}
        />
      </div>

      <div className="agent-job-error">
        <span>阻塞原因</span>
        <strong>{errorTitle}</strong>
        <p>{job.error_message?.trim() || "任务未返回更详细的错误信息。"}</p>
        {job.error_code && <code>{job.error_code}</code>}
      </div>

      <div className="agent-job-technical">
        <span>任务 ID</span>
        <code>{job.id}</code>
        <span>任务类型</span>
        <code>{job.type}</code>
        <span>首次创建</span>
        <strong>{formatFullTime(job.created_at)}</strong>
      </div>

      <div className="agent-job-detail-actions">
        <div className="agent-job-detail-action-buttons">
          <Button
            icon={<RotateCw size={16} />}
            loading={retrying}
            onClick={onRetry}
          >
            手动重试
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 size={16} />}
            disabled={retrying}
            onClick={onClear}
          >
            清除异常
          </Button>
        </div>
        <span>重新入队后保留累计尝试次数，并开放至少 3 次执行机会。</span>
      </div>
    </>
  );
}

function JobContext({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function formatFullTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
  });
}
