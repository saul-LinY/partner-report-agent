export type PluginExecutionEvent = {
  id: string;
  invocation_id: string | null;
  run_id: string | null;
  sequence: number | null;
  command: string | null;
  event_type: string | null;
  level: "debug" | "info" | "warning" | "error";
  stage: string;
  event_code: string;
  message: string;
  retryable: boolean;
  duration_ms: number | null;
  details: Record<string, unknown>;
  occurred_at: string | Date;
};

export type PluginExecutionDiagnosis = {
  severity: "normal" | "warning" | "critical" | "unknown";
  state: "completed" | "failed" | "running" | "interrupted" | "warning";
  title: string;
  cause: string;
  action: string;
  failedStage: string | null;
  evidenceCode: string | null;
  retryable: boolean;
};

const stageLabels: Record<string, string> = {
  collection: "采集汇总",
  collect_start: "启动采集",
  collect_next: "读取会话",
  collect_review: "检查采集结果",
  collect_submit: "上传贡献",
  project_description_submit: "生成项目说明",
  connectivity_test: "连接检查",
  status: "状态检查",
  project_scope_sync: "同步项目权限",
};

export function pluginStageLabel(stage: string) {
  return stageLabels[stage] ?? stage.replaceAll("_", "-");
}

function failureGuidance(event: PluginExecutionEvent) {
  const detailCode =
    typeof event.details.errorCode === "string" ? event.details.errorCode : "";
  const signal =
    `${event.event_code} ${detailCode} ${event.message}`.toUpperCase();
  if (/REFRESH_TOKEN|ACCESS_TOKEN|AUTH|UNAUTHORIZED|FORBIDDEN/.test(signal))
    return {
      cause: "插件与中台的登录凭证已失效，命令无法继续调用接口。",
      action: "让用户重新连接插件；如果仍失败，再检查插件实例是否被停用。",
    };
  if (/PERMISSION|PROJECT_SCOPE|SENSITIVE_EGRESS/.test(signal))
    return {
      cause: "插件在项目授权或数据出站检查时被拦截。",
      action: "检查该用户的项目采集权限，以及失败项目是否仍在允许范围内。",
    };
  if (/EXTRACT|MODEL|VALIDATION|SCHEMA|INVALID.*OUTPUT/.test(signal))
    return {
      cause: "模型提取结果没有通过插件要求的格式或语义检查。",
      action:
        "重点查看本次运行的结果事件、失败代码和重试次数，确认模型是否按插件协议返回。",
    };
  if (/THREAD|SESSION|APP_SERVER|LOCAL_AGENT|CODEX/.test(signal))
    return {
      cause: "插件没有成功读取本地 Codex 会话，问题发生在本地会话访问链路。",
      action:
        "检查 Codex 是否在运行、会话是否仍存在，以及插件是否有权读取对应项目。",
    };
  if (/TIMEOUT|NETWORK|HTTP|SYNC|UPLOAD|ECONN|RATE_LIMIT/.test(signal))
    return {
      cause: "插件与外部服务通信失败，可能是网络、中台接口或限流问题。",
      action: event.retryable
        ? "这是可重试错误，先重新执行；若连续出现，再按请求编号查询中台接口日志。"
        : "按请求编号查询中台接口日志，并检查插件连接配置。",
    };
  if (/LOCAL_STORAGE|ENOSPC|EACCES|ENOENT|FILE|DISK/.test(signal))
    return {
      cause: "插件读写本地状态文件失败。",
      action: "检查插件数据目录权限、剩余磁盘空间和本地状态文件是否损坏。",
    };
  return {
    cause: `命令在“${pluginStageLabel(event.stage)}”阶段返回了未处理错误。`,
    action: "展开失败事件，结合错误代码、请求编号和上下文计数继续排查。",
  };
}

export function diagnosePluginExecution(
  events: PluginExecutionEvent[],
  now = new Date(),
): PluginExecutionDiagnosis {
  if (events.length === 0)
    return {
      severity: "unknown",
      state: "interrupted",
      title: "没有收到可分析的日志",
      cause: "中台没有收到这次命令的过程或结果事件。",
      action: "确认插件已升级并能访问日志上传接口。",
      failedStage: null,
      evidenceCode: null,
      retryable: false,
    };

  const ordered = [...events].sort(
    (left, right) =>
      new Date(left.occurred_at).getTime() -
        new Date(right.occurred_at).getTime() ||
      (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const failure = [...ordered]
    .reverse()
    .find((event) => event.level === "error");
  if (failure) {
    const guidance = failureGuidance(failure);
    return {
      severity: "critical",
      state: "failed",
      title: `在“${pluginStageLabel(failure.stage)}”阶段失败`,
      ...guidance,
      failedStage: failure.stage,
      evidenceCode:
        typeof failure.details.errorCode === "string"
          ? failure.details.errorCode
          : failure.event_code,
      retryable: failure.retryable,
    };
  }

  const latest = ordered.at(-1)!;
  const completed = ordered.some(
    (event) => event.event_code === "command.completed",
  );
  const warning = [...ordered]
    .reverse()
    .find((event) => event.level === "warning");
  if (warning)
    return {
      severity: "warning",
      state: "warning",
      title: completed
        ? "命令已完成，但存在需要关注的情况"
        : "命令等待继续处理",
      cause:
        typeof warning.details.reason === "string"
          ? `${warning.message}（${warning.details.reason}）`
          : warning.message,
      action: warning.retryable
        ? "可以重新执行这一步；若持续出现，再展开警告事件查看上下文。"
        : "展开警告事件，确认是否需要用户补充操作。",
      failedStage: warning.stage,
      evidenceCode: warning.event_code,
      retryable: warning.retryable,
    };

  if (completed)
    return {
      severity: "normal",
      state: "completed",
      title: "本次命令运行正常",
      cause: "插件已上传开始、过程结果和完成事件，没有发现错误或警告。",
      action: "无需处理。",
      failedStage: null,
      evidenceCode: latest.event_code,
      retryable: false,
    };

  const idleMs = now.getTime() - new Date(latest.occurred_at).getTime();
  if (idleMs >= 10 * 60_000)
    return {
      severity: "critical",
      state: "interrupted",
      title: `命令停在“${pluginStageLabel(latest.stage)}”阶段`,
      cause: "已经超过 10 分钟没有收到完成或失败事件，进程可能被中断。",
      action:
        "确认用户电脑上的 Codex 和插件进程是否仍在运行，然后重新执行该命令。",
      failedStage: latest.stage,
      evidenceCode: latest.event_code,
      retryable: true,
    };

  return {
    severity: "normal",
    state: "running",
    title: `正在执行“${pluginStageLabel(latest.stage)}”`,
    cause: "已收到运行过程日志，暂未发现错误。",
    action: "等待插件上传最终结果。",
    failedStage: null,
    evidenceCode: latest.event_code,
    retryable: false,
  };
}

export function groupPluginExecutions(
  events: PluginExecutionEvent[],
  now = new Date(),
) {
  const groups = new Map<string, PluginExecutionEvent[]>();
  for (const event of events) {
    const key = event.invocation_id
      ? `invocation:${event.invocation_id}`
      : event.run_id
        ? `run:${event.run_id}`
        : "legacy";
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()]
    .map(([executionId, groupedEvents]) => {
      const ordered = [...groupedEvents].sort(
        (left, right) =>
          new Date(left.occurred_at).getTime() -
            new Date(right.occurred_at).getTime() ||
          (left.sequence ?? 0) - (right.sequence ?? 0),
      );
      const first = ordered[0]!;
      const last = ordered.at(-1)!;
      const explicitDuration = [...ordered]
        .reverse()
        .find((event) => event.event_code === "command.completed")?.duration_ms;
      const diagnosis: PluginExecutionDiagnosis =
        executionId === "legacy"
          ? {
              severity: "unknown",
              state: "warning",
              title: "旧版日志无法按单次命令区分",
              cause:
                "这些事件没有上传命令执行 ID，中台只能把它们放在同一个历史分组中。",
              action: "插件升级后，新产生的日志会自动按每次命令分开。",
              failedStage: null,
              evidenceCode: null,
              retryable: false,
            }
          : diagnosePluginExecution(ordered, now);
      return {
        executionId,
        invocationId: first.invocation_id,
        runId: ordered.find((event) => event.run_id)?.run_id ?? null,
        command:
          executionId === "legacy"
            ? "legacy"
            : (ordered.find((event) => event.command)?.command ??
              first.stage ??
              "plugin"),
        startedAt: new Date(first.occurred_at).toISOString(),
        lastEventAt: new Date(last.occurred_at).toISOString(),
        durationMs:
          explicitDuration ??
          Math.max(
            0,
            new Date(last.occurred_at).getTime() -
              new Date(first.occurred_at).getTime(),
          ),
        eventCount: ordered.length,
        errorCount: ordered.filter((event) => event.level === "error").length,
        warningCount: ordered.filter((event) => event.level === "warning")
          .length,
        diagnosis,
        events: ordered,
      };
    })
    .sort(
      (left, right) =>
        new Date(right.lastEventAt).getTime() -
        new Date(left.lastEventAt).getTime(),
    );
}
