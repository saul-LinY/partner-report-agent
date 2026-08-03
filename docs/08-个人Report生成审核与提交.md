# 08 个人 Report 生成、审核与提交

> 当前状态：个人周报生成和数据中台二审已经进入主链路；飞书审核、团队聚合和 Monitor 交付仍是后续路线。

> 对应 PRD：9.4、10 FR-08、11.7、12.5/12.6、13.1、14.5、16.4、AC-08。
>
> 前置依赖：06、07。

## 1. 目标

只基于 Partner 已确认的 Work Item Snapshot 生成个人 Report，支持表达层调整和版本化审核，并在提交后形成团队聚合可依赖的不可变结构化输入。

## 2. 生成前置条件

生成请求必须同时满足：

- Work Item Review 状态为 `ITEMS_APPROVED`。
- 存在当前 Review 版本对应的不可变 Snapshot。
- 无待处理 Re-analysis、Change Preview 或敏感删除任务。
- Coverage Snapshot 已固定。
- 报告模板、周期、Partner 偏好和语言配置可用。

不满足时返回具体守卫错误，不能用未确认 Draft 兜底。

## 3. 生成器输入边界

允许读取：

- Approved Work Item Snapshot。
- 本期模板和 Team 配置。
- Partner 本期侧重点。
- Partner 长期表达偏好。
- 上期已提交报告的结构化状态。

禁止读取：

- 原始 Session/transcript。
- 未确认 Fact 或被排除事项。
- 其他 Partner 的 Report。
- 消息数量、Token 数量等绩效代理指标。

## 4. 输出模型

除 PRD `IndividualReport` 字段外，增加：

```text
template_version
generator_version
source_snapshot_checksum
sections[]
fact_claims[] -> work_item_snapshot_id / partner_supplied_fact_id
quality_results[]
preferences_snapshot
coverage_snapshot_id
```

正文和结构化字段一起版本化。团队聚合读取结构化字段，不重新解析最终 Markdown/PDF 文本。

## 5. 默认结构

1. 本期摘要。
2. 关键成果。
3. 按项目组织的工作事项进展。
4. 风险与阻塞。
5. 下一期重点。
6. 需要 Monitor 协调或决策的事项。
7. 数据覆盖提示。

生成器可以压缩表达，但不能丢弃 Partner 标记重点、未解除阻塞、Monitor Action 或 Coverage Warning。

## 6. 质量检查

采用确定性检查优先、模型检查补充：

- 每个“完成”Claim 有完成状态来源。
- 每个数字/百分比可映射到 Fact 或 Partner 补充。
- 不把 discussion/planned/awaiting_validation 改写为 completed。
- 没有重复 Work Item。
- 未解决 Blocker 包含影响；需要帮助时有明确 Action。
- Partner 重点事项已出现。
- 被排除/敏感内容没有泄露。
- Coverage Warning 与 Snapshot 一致。
- Report Claim 与来源 Work Item 状态一致。

质量检查失败时生成任务进入 `GENERATION_FAILED` 或“需人工检查”，不得发送看似可提交的卡片。

## 7. 审核与修改

Report 审核卡支持：

- 确认提交。
- 调整长度、语言、项目顺序、侧重点、技术细节和面向对象。
- 返回 Work Item。
- 查看完整 Report。

表达修改创建新生成请求和新版本，输入 Snapshot 不变。若 Partner 指出事实错误，必须回到 Work Item Review；修正并重新批准后创建新 Snapshot 和 Report 版本。

自然语言如“不要强调排查过程，重点写结果”只修改本期偏好；只有 Partner 明确选择长期范围时才更新长期偏好。

## 8. 版本与状态

```text
REPORT_DRAFT -> REPORT_REVIEW -> SUBMITTED -> LOCKED
```

- 每次 regenerate 生成新版本，旧版本只读。
- Submit 使用 `base_version`，防止旧卡片提交过期 Report。
- Submit 事务中写入 approved_at、提交人、Snapshot/模板/生成器版本和 checksum。
- 截止前撤回时创建新审核版本，不把已提交行原地改回 Draft。
- 团队聚合开始后按 Policy 决定是否允许撤回；MVP 推荐锁定并由 Admin 显式重跑周期。

## 9. API 与任务

- `POST /v1/individual-reports/generate`
- `POST /v1/individual-reports/{id}/regenerate`
- `POST /v1/individual-reports/{id}/submit`
- `POST /v1/individual-reports/{id}/withdraw`（仅策略允许时）
- `GET /v1/reports/{id}/versions`

生成/重生成异步执行，幂等键包含 Snapshot、模板、偏好和生成器版本。完全相同输入可以复用结果。

## 10. 测试

- 未完成事项审核时禁止生成。
- 输入严格限制为 Snapshot；用哨兵数据验证不会读未确认 Fact。
- 七个默认章节、空章节和超长内容的稳定渲染。
- 完成状态、数字、Blocker、重点和 Coverage 的质量规则。
- 表达修改不改变事实；事实修改强制返回事项层。
- 重复 generate/submit、旧版本提交和并发修改。
- Submit 后 Snapshot/Report 不可变。
- 敏感/排除内容不会因上期报告或长期偏好重新出现。

## 11. 指标与审计

指标：生成耗时/失败、质量规则失败、Report 修改次数、事实退回率、审核时长、按时提交率、Token/成本。

审计：生成输入版本、Prompt/模型版本、质量结果、每次表达变更、事实层退回、提交/撤回/锁定。

## 12. 验收与退出标准

- 只有全部必要事项通过后才能生成 Report。
- Report 中所有 Claim 可追溯到 Work Item Snapshot。
- 表达调整和事实修正走不同路径。
- Partner 确认后生成不可变提交版本，旧卡片不能提交过期版本。
- Coverage Warning 清晰展示。
- 满足 AC-08，产出团队聚合可直接读取的结构化 Report。
