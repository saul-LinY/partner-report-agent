export const DEFAULT_COLLECTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_COLLECTION_REASONING_EFFORT = "medium";

export const SCHEDULED_COLLECTION_PROMPT = [
  "使用 $partner-report-sync 采集当前 Partner Report 周期内符合条件的 Codex Session。",
  "本任务必须完整执行采集和终态审查两个阶段，任何阶段都不得提前收尾。",
  "严格按照 Skill 调用 partner-report MCP 工具，不得运行 CLI 或 shell；每次只读取和处理一个 Session。",
  "读取失败、提取失败、未决策或覆盖差集不为空时都不得结束本轮；必须继续 collect_next 修复。只有宿主运行时间硬上限到达时才能 collect_defer，并由下一次运行从未推进的成功游标重扫同一窗口，绝不能用 EXTRACT_FAILED 清空队列。",
  "首次运行固定从当前周的周一 00:00（北京时间）开始采集；后续使用插件本地成功游标和重叠扫描窗口确定增量范围。以 Session 最近一组完整问答的时间是否落在窗口内判定候选；旧 Session 新增完整问答后也作为一个新版本候选，并将该 Session 全部完整问答作为一个整体只交给模型一次。",
  "用户输入绑定码即确认插件后续扫描、读取、价值判断和上传行为；定时任务运行途中不得停下来等待任何项目授权，也不得发送项目审批卡。",
  "绑定成功后通过 thread/list 只读取 Codex 状态数据库中的元数据，按最近 7 天有实际活动且未归档的 Session 工作目录归并项目；每个真实项目至少 1 个 Session 即可登记并自动允许。绑定阶段不调用 thread/read，首次定时运行再从当周周一 00:00 开始读取。",
  "本地项目范围文件缺失、损坏或不属于当前插件实例时，从中台重建并继续；历史 pending 项目和后续发现的新项目都按绑定授权自动转为 allowed，不得等待用户。用户主动设为 denied 的项目以及本地 Session/路径排除项继续生效。",
  "Session 队列清空后检查每个允许项目的整体描述。只读取本机项目说明文件、项目清单和顶层目录生成语义指纹；中台没有描述或语义指纹变化时才生成约 150 字中文候选描述，未变化则复用。描述 Job 失败不得阻断其他项目或新项目扫描。",
  "候选项目必须先过滤系统任务、官方自动化、Codex 临时目录、系统临时目录和已归档 Session；按工作目录归并，同一 Git 仓库的 worktree 合并为一个范围单元，同名但不同仓库分别处理。主动拒绝的项目视为排除项，禁止读取和上传。project-scope.json 的本地 allowed/denied 修改会在采集前提交中台，按版本校验成功后才生效；冲突时先同步。",
  "采集顺序固定为临时环境过滤、绑定授权范围确认、Session 内容价值判断，任一步未通过都不得进入下一步。",
  "先判断整个 Session 是否包含对映射项目有意义的实际工作；舍弃闲聊、无关话题、低价值往返，以及没有明确成果、进展、决策、阻塞或下一步的 Session。",
  "所有提取指令以及上传的标题、摘要和贡献正文必须使用中文，并采用通俗、精简、直接的表达，避免术语堆砌、重复背景和流程套话。",
  "只写入 Skill 要求且通过校验的 SessionExtractionResult，并只上传 SessionContribution。",
  "Schema、中文或安全校验失败必须修正同一 Job 的结构化结果且最多三次；只有同一 Job 连续三次真实失败后才能按 MCP 返回的安全原因码使用 EXTRACT_FAILED，禁止批量 collect_skip。",
  "不得上传原始对话、绝对路径、Codex Session 原始标识、推理、工具调用、命令、文件改动或凭据。",
  "automation memory 只记录运行时间、完成或失败状态、聚合计数和安全错误码；不得记录 Session 内容、Fact、证据、端点或标识，防重以稳定用户目录中的本地 accepted/ignored 哈希记录和中台哈希为准。",
  "运行清单由插件以仅当前用户可读写的权限保存在稳定本地目录；任务中断时下一次运行先恢复同周期未完成队列。周期已经切换时放弃旧运行清单并按成功游标重新扫描候选 Session，由中台按上传成功时当前开放周期归档，不标记迟到或补采。",
  "MCP 返回 started、job、validation_failed、uploaded、ignored、skipped、deferred、project_description_job、project_description_validation_failed、project_description_uploaded、project_description_skipped、coverage_repair_required、review_required、review_failed 或任何 nextTool 时都属于非终态，必须立即调用对应工具，不得总结、标记完成或结束任务。",
  "队列处理完后必须执行终态覆盖审查：重新列举固定时间窗口内所有允许项目的非临时 Session，逐一核对是否已经明确上传、忽略、命中缓存或判定不符合窗口；发现漏项就追加处理，再重新列举检查，直到差集和 unresolvedReadFailures 都为空。",
  "collect_review 必须把 coverageComplete、failedRead、failedExtract、deferred、skipped 和 notProcessed 作为硬门槛；只有返回 completed、checkpointAdvanced 为 true 且没有 nextTool 时才允许收尾，其他情况必须继续修复，绝不能记录成功。",
  "最终只返回安全的中文聚合摘要。",
].join(" ");

export const SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=16;BYMINUTE=0",
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
  installationOwner: "plugin_connect",
  createIfMissing: true,
  preserveExistingTask: true,
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
