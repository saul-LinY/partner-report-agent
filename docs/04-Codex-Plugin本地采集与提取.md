# 04 Codex Plugin 本地采集与提取

> 对应 PRD：6.1、7.1 至 7.3、9.2、9.8、FR-02、FR-03、15、19、AC-02、AC-02A、AC-03。
>
> 前置依赖：01、02、03。

## 1. 目标

在 Partner 本地可靠发现授权范围内的 Codex Session，按 Turn 增量读取，并只用用户提问和模型最终回复提取结构化事实。推理过程、commentary、命令、工具调用、文件变化和代码细节不进入提取模型上下文。

Plugin 的正确性来源是“Hook 快速标记 + 2 小时静默窗口 + Local Runner 自动处理 + 周期补偿扫描 + Cursor 幂等处理”，不能依赖 `SessionEnd` 恰好触发，也不要求 Partner 日常手动运行 Skill。

## 2. Plugin 包结构

```text
partner-report-plugin/
  .codex-plugin/plugin.json
  .agents/plugins/marketplace.json
  hooks/hooks.json
  hooks/stop.*
  hooks/session_end.*
  skills/report-sync/SKILL.md
  bin/report-sync
  bin/report-runner
  config/schema.json
  migrations/
```

Manifest 固定唯一名称和 SemVer。Hook 变更会触发重新信任，应在发布说明中显式标注。

## 3. 本地组件

| 组件                | 职责                                                           |
| ------------------- | -------------------------------------------------------------- |
| Hook Writer         | 将最小事件原子写入 Outbox，不做网络或 LLM 工作                 |
| Activity Store      | 按 Session 聚合最后活动时间、静默截止、最新 Turn 和处理状态    |
| Local Runner        | 每 5 分钟检查静默窗口并提取/同步；按需执行周聚合和报告远程任务 |
| App Server Reader   | 使用稳定线程 API 列表和读取 Session/Turn                       |
| Scanner             | 对比线程列表、Outbox 和 Cursor，发现遗漏和截止快照             |
| Scope Filter        | 应用时间、项目路径、显式排除和授权规则                         |
| Incremental Planner | 计算待处理 Turn 范围和内容哈希                                 |
| Local Extractor     | 相关性分类、Fact 提取和增量状态更新                            |
| Privacy Guard       | 敏感扫描、代码/工具输出过滤、Evidence 截断                     |
| Local Validator     | Schema、引用和完成证据检查                                     |
| Sync Client         | 批量上传并只在服务端确认后推进同步状态                         |
| Local Store         | Outbox、Cursor、配置、任务租约和失败记录                       |

## 4. Hook 设计

### 4.1 Stop Hook

输入只取：`session_id`、`turn_id`、`cwd`、事件时间。除追加最小事件外，原子 upsert Session 活动状态：

```json
{
  "event_type": "TURN_STOPPED",
  "session_id": "thr_456",
  "turn_id": "turn_025",
  "cwd": "/workspace/payment-service",
  "observed_at": "..."
}
```

```text
state = DIRTY
last_activity_at = observed_at
quiet_until = observed_at + 120 minutes
latest_turn_id = turn_id
generation = generation + 1
```

要求：

- 单次本地事务或原子追加，目标耗时低于 100 ms。
- 重复事件由唯一键 `(session_id, turn_id, event_type)` 去重。
- 成功时按 Hook 协议静默退出，不返回阻断决策。
- 本地存储不可用时只记录最小安全错误，不输出聊天内容。

### 4.2 SessionEnd Hook

写入 `SESSION_END_OBSERVED`，但仍等待 2 小时静默窗口。不得：

- 把它解释为永久结束。
- 依赖 `reason` 区分结束原因。
- 在 Hook 内读取完整线程或执行提取。
- 假设它覆盖 Subagent。

## 5. Local Store

推荐使用支持事务和唯一索引的嵌入式数据库。至少包含：

```text
outbox_event(id, type, session_id, turn_id, cwd, observed_at, state, attempts)
session_activity(session_id, latest_turn_id, last_activity_at, quiet_until,
                 processing_state, generation, last_event_type)
session_cursor(session_id, last_seen_turn_id, last_processed_turn_id,
               last_activity_at, content_hash, processing_state, sync_status)
extraction_batch(id, session_id, from_turn, to_turn, extractor_version,
                 source_hash, state, error_code)
pending_payload(id, batch_id, schema_version, encrypted_payload, state)
local_job(id, job_type, state, lease_until, attempts, next_run_at)
runner_state(last_started_at, last_completed_at, last_error_code, owner, lease_until)
```

本地数据库迁移必须支持旧 Plugin 升级；写到一半崩溃后，重启能从最后一个已提交事务恢复。

已消费 Hook 保留 7 天；已同步任务、完成批次、完成租约和临时输入/结果文件默认保留 30 天。清理只删除已完成数据，待同步、待重试和执行中的记录必须保留。保留天数可由 `PARTNER_REPORT_LOCAL_RETENTION_DAYS` 调整。

## 6. 静默触发与扫描算法

Runner 默认每 5 分钟执行一次调度周期。普通 Session 只有满足 `now >= last_activity_at + 120 minutes` 才进入提取；任何新 Turn 都顺延截止时间。Admin 强制重扫、明确的立即同步请求和超过最大滞留时间的任务可以绕过静默窗口。

这里的 120 分钟只决定“某个会话什么时候提取”。Runner 提取并同步 Fact 后不会立刻聚合。项目聚合由数据中台在周周期 `cutoff_at` 到达后另行创建一次远程任务。

提取前冻结 `from_turn_id/to_turn_id/source_hash/activity_generation`。执行期间若 Hook 把 generation 推进，当前任务完成后只推进到冻结 Cursor，Session 继续保持 `DIRTY`。

每次 Runner、补偿或截止扫描：

1. 获取本地锁，避免同一实例并发扫描。
2. 读取未消费 Outbox，但不立刻删除。
3. 分页调用 `thread/list`，建立可见 Session 清单。
4. 合并 Hook 线索与线程清单，标记 Hook 遗漏。
5. 依据授权范围过滤；排除原因结构化记录。
6. 对候选 Session 调用 `thread/read(includeTurns)`。
7. 用 Session ID 找到该会话的 Cursor：无 Cursor 表示新会话，有 Cursor 表示历史会话；再从 `last_processed_turn_id` 后计算增量并校验旧游标仍存在。
8. 对未到静默截止的 Session 标记 `QUIET_WAIT`；对到期对象生成提取批次，并通过 Codex 官方非交互执行入口在只读、临时 Session 中完成本地提取。
9. 持久化待上传 Payload。
10. 上传确认后推进 Cursor 和 Outbox 状态；失败则保留并退避。

若游标 Turn 消失、历史被改写或源哈希异常，不能静默跳过。标记 `CURSOR_INVALID`，按策略对可读范围重建并让服务端使用新 source revision 去重。

## 7. 授权与过滤

过滤顺序：显式 Session 排除 -> 路径排除 -> 路径包含 -> 项目映射 -> 周期时间 -> 工作相关性。

规则：

- 排除优先于包含。
- 符号链接和大小写归一化后再匹配路径，防止目录逃逸。
- 未明确授权的路径默认不读。
- 时间范围依据 Turn 发生时间，而不是文件修改时间。
- 被排除 Session 不上传标题、摘要或 Evidence，只上传匿名计数所需状态。

## 8. 增量提取流水线

```text
Turn ID boundary selection
-> keep userPrompt + assistantFinal only
-> relevance classification
-> work event extraction
-> merge with previous Session facts
-> status transition validation
-> privacy guard
-> schema validation
```

每个输入 Turn 固定为：

```json
{
  "id": "turn_025",
  "status": "completed",
  "userPrompt": "完成项目进展页",
  "assistantFinal": "项目进展页已完成并通过测试"
}
```

`assistantFinal` 只接受 `agentMessage.phase = final_answer`。没有最终回复时字段为 `null`，不能把中间进度或思考过程当作任务结果。Turn ID 即使没有有效文本也保留，用于可靠推进历史会话边界。

`SessionWorkFact v1` 包含 PRD 12.3 字段，并补充：

- `source_revision`、`from_turn_id`、`to_turn_id`。
- `evidence[].turn_id`，便于本地追溯和去重。
- `fact_origin = ai_extracted`。
- `completion_support = evidence | uncertain`。
- `redaction_summary`，只记录类别和数量，不记录命中的秘密正文。

增量输入允许读取同 Session 上次的结构化 Fact，用于状态链连续性，但不能把旧自然语言摘要当成新增证据。

## 9. 隐私与敏感扫描

上传前执行：

- Secret/Token/私钥和环境变量模式扫描。
- 推理、commentary、源代码、命令输出、工具调用、堆栈和文件变化在构造模型输入前直接丢弃。
- Partner 自定义敏感词和项目排除。
- Evidence 白名单字段、长度上限和最小必要截取。
- Prompt injection 内容按数据对待，不能改变提取器系统约束。

敏感命中时可删除 excerpt 或排除 Fact；不得在日志中打印原值。原始 Session 和本地缓存按操作系统权限最小化保护。

## 10. Coverage 本地统计

每次扫描产生：

```text
discovered
readable
extracted
failed_read
failed_extract
excluded
pending_sync
active_at_cutoff
hook_missed
```

计数必须能从 Session 明细状态重算。历史关闭、Session 删除、设备/应用离线作为 Warning 原因上传。

## 11. 测试

- Hook 重复、并发、超时、未信任和本地存储只读。
- 连续新 Turn 反复顺延 2 小时静默截止，不产生重复提取任务。
- 提取中出现新 Turn 时固定边界正确，完成后仍保留 DIRTY。
- Runner 单实例租约、崩溃恢复、5 分钟心跳和电脑休眠后补跑。
- Scheduled Scan 发现没有 Hook 事件的 Session。
- 已处理至 Turn 20 后只提取 21 至 25。
- 新 Session 读取全部 Turn；历史 Session 通过 Session ID 找 Cursor，并通过 Turn ID 跳过旧 Turn。
- commentary、命令和文件变化不进入输入；只有 `final_answer` 可作为模型结果。
- SessionEnd 后恢复，仍使用同一 Session 状态链。
- 截止时活跃 Session 进入快照。
- Cursor 丢失、Turn 回滚、Session 删除和历史关闭。
- include/exclude 路径、符号链接和未授权目录。
- 敏感样本、大段代码、工具输出和 Prompt injection。
- 进程在写 Outbox、提取、上传前后各阶段崩溃并恢复。
- 50 个 Session 在目标设备完成增量同步的基准。

## 12. 验收与退出标准

- 发现、读取、提取、失败和排除数一致且可解释。
- Hook 缺失时扫描仍可发现 Session；Hook 失败不影响 Codex 主流程。
- 连续 120 分钟无新 Turn 后无需 Partner 操作即可开始提取；活跃 Session 不被过早拆分。
- 同一 Session 增量处理不重复旧 Fact。
- 每个“完成”Fact 有 Evidence 或 `uncertain`。
- 未授权/敏感内容不出本地边界。
- Pending Payload 在网络失败后可恢复，成功前不错误推进同步 Cursor。
- 满足 AC-02、AC-02A、AC-03 的本地部分。
