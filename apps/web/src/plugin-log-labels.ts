export type PluginExecutionGrouping = "invocation" | "run" | "legacy";

const commandLabels: Record<string, string> = {
  legacy: "历史未分组日志",
  collection: "采集批次",
  "collect-start": "启动采集",
  "collect-next": "读取并分析会话",
  "collect-review": "检查采集结果",
  "collect-submit": "上传贡献",
  "collect-defer": "暂缓采集",
  "collect-skip": "跳过会话",
  "project-description-submit": "生成项目说明",
  "connectivity-test": "连接检查",
  status: "状态检查",
  "project-scope-sync": "同步项目权限",
};

export function pluginCommandLabel(command: string) {
  return commandLabels[command] ?? command;
}

export function pluginExecutionLabel(execution: {
  grouping: PluginExecutionGrouping;
  command: string;
}) {
  if (execution.grouping === "run") return "定时采集";
  if (execution.grouping === "legacy") return "历史未分组日志";
  return pluginCommandLabel(execution.command);
}

export function pluginExecutionKindLabel(grouping: PluginExecutionGrouping) {
  if (grouping === "run") return "本次定时采集";
  if (grouping === "legacy") return "历史日志";
  return "本次插件命令";
}

const stageLabels: Record<string, string> = {
  collect_start: "启动采集",
  collect_next: "读取并分析会话",
  collect_review: "检查采集结果",
  collect_submit: "上传贡献",
  collection: "采集会话",
  upload: "上传贡献",
  sync: "同步状态",
  validation: "校验数据",
  codex_app_server: "连接 Codex",
  codex_thread_list: "读取 Codex 会话列表",
};

export function pluginStageLabel(stage: string) {
  return stageLabels[stage] ?? stage;
}
