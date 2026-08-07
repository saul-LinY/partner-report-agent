export const DEFAULT_COLLECTION_MODEL = "gpt-5.5";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "low";

export const SCHEDULED_COLLECTION_PROMPT = [
  "使用 $partner-report-sync 采集当前 Partner Report 周期内符合条件的 Codex Session。",
  "本任务必须完整执行采集和终态审查两个阶段，任何阶段都不得提前收尾。",
  "严格按照 Skill 调用插件 CLI，每次只读取和处理一个 Session。",
  "首次运行只采集最近 1 天；后续由插件本地成功游标、重叠窗口和内容哈希自动确定增量范围。",
  "插件绑定命令负责首次项目发现：绑定成功后只读取 thread/list 元数据，按当前月白名单和最近 7 天活动窗口登记项目并发送飞书项目范围卡；绑定命令在卡片投递完成或进入审批等待后结束，不读取 thread/read。",
  "插件激活命令的本地项目权限文件缺失、损坏或不属于当前插件实例时，先从中台同步已审批权限；中台仍有 pending 项目时只重新发送项目范围审核提醒并结束，本次不得读取或上传 Session。",
  "候选项目必须先过滤系统任务、官方自动化、Codex 临时目录和系统临时目录；首次项目范围卡只在已登记项目根目录白名单内纳入最近 7 天有已知 Session 活动的项目，白名单外目录不进入首次审批；后续运行按原有逻辑发现新增项目。同一 Git 仓库的 worktree 合并为一个权限单元，首次白名单项目即使只有 1 个 Session 也可进入审批，后续新增项目仍按归并后超过 1 个 Session 保留。",
  "采集顺序固定为临时环境过滤、项目人工授权、Session 内容价值判断，任一步未通过都不得进入下一步。",
  "先判断整个 Session 是否包含对映射项目有意义的实际工作；舍弃闲聊、无关话题、低价值往返，以及没有明确成果、进展、决策、阻塞或下一步的 Session。",
  "所有提取指令以及上传的标题、摘要和贡献正文必须使用中文。",
  "只写入 Skill 要求且通过校验的 SessionExtractionResult，并只上传 SessionContribution。",
  "不得上传原始对话、绝对路径、Codex Session 原始标识、推理、工具调用、命令、文件改动或凭据。",
  "automation memory 只记录运行时间、完成或失败状态、聚合计数和安全错误码；不得记录 Session 内容、Fact、证据、端点或标识，防重以稳定用户目录中的本地 accepted/ignored 哈希记录和中台哈希为准。",
  "CLI 返回 started、job、uploaded、ignored、skipped、review_required、project_scope_card_delivery_pending 或任何 nextCommand 时都属于非终态，必须立即执行对应的下一步，不得总结、标记完成或结束任务。",
  "project_scope_card_delivery_pending 必须持续执行 project-scope-card-wait；只有 CLI 观察到飞书卡片版本已成功投递后才会返回 project_scope_approval_required。",
  "CLI 返回 project_scope_approval_required 且没有 nextCommand 时，表示项目范围卡已确认发送，是正常等待终态；不得绕过权限继续采集。",
  "CLI 返回 project_scope_no_candidates 且没有 nextCommand 时，表示过滤后没有可审批项目，是零读取、零上传的正常终态；不得等待一张不会生成的卡片。",
  "队列清空后必须执行 collect-review；只有该审查命令返回 completed 且没有 nextCommand 时才允许收尾。",
  "收尾前再次核对最后一次 CLI 结果：checkpointAdvanced 为 true 才记录成功；为 false 时记录失败或部分运行并保留重试警告，绝不能记录成功。",
  "最终只返回安全的中文聚合摘要。",
].join(" ");

export const SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=14;BYMINUTE=30",
    timezone: "Asia/Shanghai",
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "all_runs",
  prompt: SCHEDULED_COLLECTION_PROMPT,
} as const;
