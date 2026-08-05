export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";

export const SCHEDULED_COLLECTION_PROMPT = [
  "使用 $partner-report-sync 采集当前 Partner Report 周期内符合条件的 Codex Session。",
  "严格按照 Skill 调用插件 CLI，每次只读取和处理一个 Session。",
  "首次运行只采集最近 1 天；后续由插件本地成功游标、重叠窗口和内容哈希自动确定增量范围。",
  "先判断整个 Session 是否包含对映射项目有意义的实际工作；舍弃闲聊、无关话题、低价值往返，以及没有明确成果、进展、决策、阻塞或下一步的 Session。",
  "所有提取指令以及上传的标题、摘要和贡献正文必须使用中文。",
  "只写入 Skill 要求且通过校验的 SessionExtractionResult，并只上传 SessionContribution。",
  "不得上传原始对话、绝对路径、Codex Session 原始标识、推理、工具调用、命令、文件改动或凭据。",
  "automation memory 只记录运行时间、完成或失败状态、聚合计数和安全错误码；不得记录 Session 内容、Fact、证据、端点或标识，防重以插件本地状态和中台哈希为准。",
  "持续执行到 CLI 返回 completed，然后只返回安全的中文聚合摘要。",
].join(" ");

export const SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=30",
    timezone: "Asia/Shanghai",
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "failures_only",
  prompt: SCHEDULED_COLLECTION_PROMPT,
} as const;
