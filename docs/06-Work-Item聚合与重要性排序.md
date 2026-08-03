# 06 Work Item 聚合与重要性排序

> 对应 PRD：9.3、12.4、FR-04、FR-05、NFR-03、AC-03、AC-04。
>
> 前置依赖：02、05。

## 1. 目标

把一整个周周期内的 Session Fact 按项目和总体任务进展聚合为项目卡片，并把结果送入 Partner 数据中台的一审。只有项目卡片审核通过并形成不可变 Snapshot 后，才能生成个人周报。

## 2. 输入与输出

输入：指定 `tenant + partner + period` 下当前可用的 Session Fact revision、项目配置、上一周期 Work Item、Partner 历史修正。

输出：

```text
WorkItemDraft[]
  stable work_item_id
  project assignment + confidence
  title
  fact_ids
  timeline events
  previous/current status
  actions/outcomes/impact/decisions/blockers/next_steps
  importance components
  merge confidence and rationale codes
  review status + version
```

当前中台通过 `GET /v1/reviews/{id}` 读取同一 Partner、同一周周期的项目卡片。页面展示标题、状态、总体摘要、结果、阻塞和下一步，不展示命令、代码文件或消息数量。

当前执行分工：一周内中心服务只保存事实。到 `cutoff_at` 后，中央 Worker 关闭旧周期、开启新周期，并以 `weekly-aggregate:{partner_id}:{period_id}` 为幂等键创建一次 `AGGREGATE_WORK_ITEMS` 任务。Partner 设备上的 Runner 领取任务，在隔离的只读临时 Codex Session 中完成聚合，再把结构化项目卡片提交中心服务并开启一审。

## 3. 聚合流水线

```text
normalize facts
-> exact-link grouping
-> candidate generation
-> pair scoring
-> constrained clustering
-> timeline reconstruction
-> deduplication
-> importance scoring
-> quality validation
```

### 3.1 精确关联优先

优先依据：既有 `work_item_id`、外部 Issue/PR/任务 ID、Partner 已确认的 merge/split 历史、明确 `project_id`。

精确冲突时不自动合并，生成低置信度候选供审核。

### 3.2 语义候选

特征包括项目/别名、目标对象、模块与技术词、时间接近、状态连续性和标题语义。必须设置候选召回上限，禁止全量两两比较导致成本失控。

### 3.3 受约束聚类

硬约束：

- Partner 明确拆分过的 Fact 不能自动重新合并。
- 不同明确项目 ID 默认不能合并。
- 状态/时间线明显冲突时降低置信度。
- 独立工作不能为提高聚合率强行归入项目。

低于自动阈值的候选保持独立，并附带“可能重复”提示。

## 4. 稳定 Work Item ID

ID 不能由本期标题直接 hash 得出。建议策略：

1. 命中历史已确认项时沿用 ID。
2. 命中稳定外部任务 ID 时在 tenant/partner 作用域映射到已有 ID。
3. 新事项创建随机内部 ID，并保存首次来源。
4. 合并产生主 ID 和 alias/tombstone 映射；拆分保留原项历史并创建新 ID。

所有 ID 决策写入 lineage，支持跨周期比较和审计。

## 5. 时间线与状态

事实按实际发生时间排序，同时间使用 Session/Turn 顺序稳定排序。状态枚举：

```text
discussion
planned
in_progress
awaiting_validation
completed
blocked
cancelled
```

状态机校验防止无来源跳转。`completed` 必须有 evidence 或 Partner supplied fact。Blocker 需保留出现、持续、解除事件，不能只保留当前文本。

重复 Actions/Outcomes 以规范化文本和来源重合度去重，但来源引用不得丢失。

## 6. 项目归属

优先级：显式 `project_id` -> 外部 ID 映射 -> 精确别名 -> 高置信度语义 -> 独立工作。

输出同时保存 `project_id`、confidence 和 assignment method。低置信度不落入公共项目，Partner 可以在审核中修正并让该修正成为后续特征。

## 7. 重要性排序

实现 PRD 建议维度，但保存分项而非黑盒总分：

```text
outcome
impact
status_change
decision
blocker
monitor_action
partner_emphasis
repetition_penalty
```

规则：

- 分数只决定审核/报告排序，不对 Partner 展示数值或用于绩效。
- Partner 明确重点可影响排序，但不能覆盖事实状态。
- 缺少 Outcomes 的纯讨论不应因消息长而得高分。
- 阻塞和需要行动可高优先，但不得误表述为成果。

## 8. Partner 修正反馈

以下修正进入显式规则或评测数据：

- merge/split。
- 项目归属修改。
- 排除非工作内容。
- 状态修正。
- 标题和重点修正。

长期偏好与本期修正分开。任何自动学习/阈值调整先离线评测，不直接在线改变历史结果。

## 9. Snapshot

当所有必要事项通过审核时，创建不可变 `WorkItemSnapshot`：

- 保存 Work Item 完整结构、version 和 fact revision 引用。
- 保存 Partner supplied facts 和审批人/时间。
- 保存 Coverage Snapshot ID。
- 后续 Fact 到达不修改 Snapshot；重新打开审核并创建新版本。

## 10. 评测

数据集至少覆盖：同项跨 Session、多项同 Session、相似标题不同项目、状态逆转、重复讨论、独立工作和 Partner 已拆分样本。

指标：

- 聚类 pair precision/recall、B-cubed 或等价 cluster 指标。
- 误合并率作为高优先风险指标。
- 项目归属准确率和低置信度校准。
- 状态时间线准确率。
- 完成证据覆盖率。
- Partner merge/split、项目和状态修正率。

阈值由 Phase 0 基准和试点共同确定，并版本化记录。

## 11. 测试

- 精确 ID 命中优先于语义结果。
- 跨项目相似标题不误合并。
- 低置信度保持独立。
- Session 恢复后的新 Fact 更新原状态链。
- merge/split lineage 和稳定 ID。
- 完成状态无证据时降级/报错。
- 同一输入和版本产生确定性输出。
- Partner 历史修正生效但不跨租户/跨 Partner 泄漏。

## 12. 验收与退出标准

- 多 Session 同一任务能聚合为一项，不确定事项不强并。
- Work Item 可追溯到完整 Fact 集和时间线。
- 稳定 ID 支持后续周期比较，合并/拆分 lineage 可解释。
- 排序不使用消息数量，不暴露绩效分数。
- 聚类和状态评测达到 Phase 0 冻结阈值。
- 满足 AC-03、AC-04，并能创建审核所需 Draft。
