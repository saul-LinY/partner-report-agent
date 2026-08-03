# 10 团队报告渲染与 Monitor 交付

> 当前状态：后续路线，2026-08-03 的交付不接入 Monitor、飞书消息或 PDF。

> 对应 PRD：9.7、10 FR-11/FR-11A/FR-12、11.10、13.2、14.6、AC-10A。
>
> 前置依赖：03、09。

## 1. 目标

把不可变 Team Report 版本渲染为飞书精简正文和一致的 PDF 文件，并幂等发送到 Team Admin 配置的 Monitor 单聊或群聊。Monitor 端无安装、无登录、无审核、无修改和无个人数据下钻。

## 2. 状态机

实施状态：

```text
TEAM_DRAFT -> READY_FOR_DELIVERY -> RENDERING
-> ARTIFACT_READY -> DELIVERING -> DELIVERED
```

失败：`RENDER_FAILED`、`UPLOAD_FAILED`、`MESSAGE_FAILED`、`DELIVERY_FAILED`。重试从最近成功的持久化步骤继续。

不实现 PRD 13.2 的 `MONITOR_REVIEW`；该命名与产品角色定义冲突。

## 3. 输出内容

### 3.1 飞书正文

包含：Team、周期、报告版本、本期摘要、关键成果、项目变化、每位 Partner 的高层工作任务进度、风险与阻塞、下一步、Monitor Actions 和 Coverage 提示。

正文遵守平台长度限制，超限时按稳定优先级裁剪表达，不裁掉风险、行动和 Coverage。完整内容始终在 PDF。

### 3.2 基础可视化

MVP：

- 项目状态矩阵。
- 上期到本期变化表。
- 关键成果列表。
- 阻塞和跨团队依赖列表。
- Monitor 行动列表。
- 提交和数据覆盖状态。

不展示排名、消息数量或无数据基础的完成率图表。

### 3.3 PDF

PDF 固定包含封面元信息、摘要、项目区、独立工作、周期变化、风险/依赖、下一步/行动和 Coverage。页眉/页脚显示 Team、周期、版本和生成时间。

## 4. 渲染契约

渲染器输入是固定 `TeamReport` JSON 和 `template_version`。输出 Artifact：

```text
artifact_id
team_report_id + report_version
format=pdf
file_name
storage_key
checksum
size
renderer_version
created_at
```

相同 Report checksum + template + renderer version 生成相同 artifact identity。PDF 中内容与飞书正文必须来自同一 Report 版本。

## 5. PDF 质量

- 中文字体嵌入或使用部署环境稳定可用字体，避免替换和乱码。
- 表格可跨页，标题不孤立，长项目名/URL 自动换行。
- 空章节不留下破碎布局。
- 页码、版本和 Coverage 标记清晰。
- 对 0、1、多个项目以及长风险列表做视觉回归。
- PDF 生成后解析页数、文本和关键元数据，并渲染页面截图做自动/人工 QA。

## 6. 交付编排

飞书文件上传与消息发送通常是多步调用，“一次性交付”按 exactly-once effect 实现：

1. 锁定 Team Report 版本和 MonitorTarget 配置快照。
2. 生成/复用 Artifact。
3. 上传文件并持久化 `file_key`。
4. 使用稳定 delivery idempotency key 发送一条含正文和附件的消息。
5. 持久化 `message_id` 后标记 `DELIVERED`。

去重键：`tenant_id + team_report_id + report_version + target_id`。

若外部 API 不支持原生幂等，需要发送前后查询/业务去重、外部请求 ID 和人工对账工具共同保证不产生多条成功消息。

## 7. DeliveryAttempt

每次尝试追加记录：

```text
delivery_id, attempt_no, target_type/id snapshot
report/artifact version, idempotency_key
file_key, message_id
state, started_at, finished_at
error_class, retryable, next_retry_at
```

只有消息与附件都确认成功才标 `DELIVERED`。文件已上传但消息失败时复用 file key；禁止每次重试重新制造无界孤儿文件。

## 8. 无交互和权限

交付消息：

- 不含按钮、表单或回调 Action。
- 不含个人 Report、Evidence、Session 链接、命令、代码操作明细、消息数量或个人排名。
- 不暴露 Partner 提交明细，除非 PRD 明确要求的“未提交成员”在最终模板中经业务确认可展示；默认只展示数量和 Coverage。
- 只发送至 Admin 配置并验证过的目标。
- Monitor 回复不触发 Report Agent 工作流。

## 9. 重试与人工补跑

- 网络、限流、5xx 指数退避并遵守服务端重试提示。
- 权限、无效目标、超大文件等不可重试错误进入告警。
- Admin 可对同一 `delivery_id` 补跑，不创建新成功消息。
- 新 Report 版本需要新的明确 Deliver 操作。
- 对账任务检查 `DELIVERING` 超时、缺 message_id 和外部状态不一致。

## 10. 测试

- 飞书正文和 PDF 版本/checksum 一致。
- 中文、长文本、跨页表格、空数据和多个项目视觉回归。
- 文件上传成功但消息失败、响应丢失、限流和 Worker 崩溃。
- 重复 Deliver/补跑只产生一条成功消息。
- 无效 MonitorTarget 和跨租户目标被拒绝。
- 消息无交互按钮、个人链接和 Evidence。
- Monitor 回复不会创建审核或重新生成任务。
- 交付成功前 Team Report 不标 `DELIVERED`。

## 11. 指标与审计

指标：渲染耗时/失败、PDF 大小/页数、上传失败、消息成功率、重试次数、交付延迟、对账不一致。

审计：模板/渲染器版本、Artifact checksum、Target 配置快照、每次 DeliveryAttempt、file key、message ID、最终状态和人工补跑人。

## 12. 验收与退出标准

- Monitor 收到可直接阅读的精简正文和相同版本 PDF。
- 消息中不存在审核、修改、追问或个人数据下钻入口。
- 失败自动重试；同一报告版本和目标最终只有一次成功交付效果。
- 消息/附件均成功后才标记 `DELIVERED`。
- PDF 通过内容校验和桌面/移动端飞书打开验证。
- 满足 AC-10A。
