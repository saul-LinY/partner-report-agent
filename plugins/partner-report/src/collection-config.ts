export const DEFAULT_COLLECTION_MODEL = "gpt-5.6";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";

export const SCHEDULED_COLLECTION_PROMPT = [
  "使用 $partner-report-sync 采集当前 Partner Report 周期内符合条件的 Codex Session。",
  "本任务必须完整执行采集和终态审查两个阶段，任何阶段都不得提前收尾。",
  "严格按照 Skill 调用插件 CLI，每次只读取和处理一个 Session。",
  "接近运行时间上限时停止领取新 Job；当前 Job 无法完成时使用 collect-defer，保留队列到下一次运行，绝不能用 EXTRACT_FAILED 清空队列。",
  "首次运行只采集最近 1 天；后续由插件本地成功游标、重叠窗口和内容哈希自动确定增量范围。",
  "插件绑定命令负责项目发现：绑定成功后只读取 thread/list 元数据，按最近 7 天新建且未归档的 Session 工作目录归并项目并发送飞书项目范围卡；每个真实项目至少 1 个 Session 即可登记；绑定命令在卡片投递完成或进入审批等待后结束，不读取 thread/read。",
  "插件激活命令的本地项目权限文件缺失、损坏或不属于当前插件实例时，先从中台同步已审批权限；中台仍有 pending 项目时只重新发送项目范围审核提醒并结束，本次不得读取或上传 Session。",
  "首次授权完成后的日常运行必须先按现有权限完成全部 Session 提取和上传；已有授权队列清空后才重新读取 thread/list 元数据扫描新项目。发现新项目时登记并发送飞书范围卡，卡片确认送达后等待用户审批 30 分钟；及时允许则把新项目本周期 Session 追加到当前队列，拒绝或超时则正常结束且保持中台状态，稍后允许时由下一次运行补采本周期。",
  "已有授权项目的 Session 队列清空后、扫描新项目之前，检查每个已授权项目的整体描述。只读取本机项目说明文件、项目清单和顶层目录生成语义指纹；中台没有描述或语义指纹变化时才生成约 150 字中文候选描述，未变化则复用。描述 Job 失败不得阻断其他项目或新项目扫描。",
  "候选项目必须先过滤系统任务、官方自动化、Codex 临时目录、系统临时目录和已归档 Session；按工作目录归并，同一 Git 仓库的 worktree 合并为一个权限单元，同名但不同仓库分别处理。未选定、待审批或拒绝的项目一律视为临时会话，禁止读取和上传。project-scope.json 的本地 allowed/denied 修改会在采集前提交中台，按版本校验成功后才生效；冲突时停止采集并要求先同步。",
  "采集顺序固定为临时环境过滤、项目人工授权、Session 内容价值判断，任一步未通过都不得进入下一步。",
  "先判断整个 Session 是否包含对映射项目有意义的实际工作；舍弃闲聊、无关话题、低价值往返，以及没有明确成果、进展、决策、阻塞或下一步的 Session。",
  "所有提取指令以及上传的标题、摘要和贡献正文必须使用中文，并采用通俗、精简、直接的表达，避免术语堆砌、重复背景和流程套话。",
  "只写入 Skill 要求且通过校验的 SessionExtractionResult，并只上传 SessionContribution。",
  "Schema、中文或安全校验失败必须在同一个结果文件内修正且最多三次；只有同一 Job 连续三次真实失败后才能按 CLI 返回的安全原因码使用 EXTRACT_FAILED，禁止批量 collect-skip。",
  "不得上传原始对话、绝对路径、Codex Session 原始标识、推理、工具调用、命令、文件改动或凭据。",
  "automation memory 只记录运行时间、完成或失败状态、聚合计数和安全错误码；不得记录 Session 内容、Fact、证据、端点或标识，防重以稳定用户目录中的本地 accepted/ignored 哈希记录和中台哈希为准。",
  "CLI 返回 started、job、validation_failed、uploaded、ignored、skipped、deferred、project_description_job、project_description_validation_failed、project_description_uploaded、project_description_skipped、review_required、project_scope_card_delivery_pending、project_scope_end_scan_card_waiting、project_scope_approval_waiting、project_scope_approved 或任何 nextCommand 时都属于非终态，必须立即执行对应的下一步，不得总结、标记完成或结束任务。",
  "project_scope_card_delivery_pending 必须持续执行 project-scope-card-wait；只有 CLI 观察到飞书卡片版本已成功投递后才会返回 project_scope_approval_required。",
  "project_scope_end_scan_card_waiting、project_scope_approval_waiting 和 project_scope_approved 属于同一个日常 Run，必须执行各自返回的 collect-next，不得改用 project-scope-card-wait。",
  "CLI 返回 project_scope_approval_required 且没有 nextCommand 时，表示项目范围卡已确认发送，是正常等待终态；不得绕过权限继续采集。",
  "CLI 返回 project_scope_no_candidates 且没有 nextCommand 时，表示过滤后没有可审批项目，是零读取、零上传的正常终态；不得等待一张不会生成的卡片。",
  "队列完整处理或因时间预算安全延后后必须执行 collect-review；审查必须区分 deferred、failedExtract 和 notProcessed，只有该命令返回 completed 且没有 nextCommand 时才允许收尾。",
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

export const SCHEDULED_COLLECTION_TASK_POLICY = {
  automaticCheck: false,
  automaticRepair: false,
  createIfMissing: true,
  customPromptAllowed: true,
  promptUpdateTrigger: "explicit_user_request_only",
  promptUpdateFields: ["prompt"],
  fullResetTrigger: "explicit_user_request_only",
  fullResetFields: [
    "destination",
    "project",
    "schedule",
    "model",
    "reasoningEffort",
    "notifications",
    "prompt",
  ],
  preserveTaskIdentity: true,
} as const;
