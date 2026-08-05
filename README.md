# Partner Report Agent

Partner Report 是一个 Codex Plugin + 数据中台 MVP：官方 Codex Scheduled Task 读取本地 Session，先舍弃闲聊、无价值和项目无关内容，再把有意义的工作整理为 Session Contribution 并立即上传。数据中台按 Partner 跨 Session 聚合工作卡片、完成 Web 审核并生成 Report。Partner 可以在 Codex Scheduled 面板修改运行时间、模型、推理强度和通知策略。

当前不接入飞书和 Monitor。Web 审核使用真实 Fact、Work Item、Snapshot 和 Report Version，不生成演示假数据。

## 职责边界

Plugin：

- 使用 Admin 为 Partner 工作邮箱生成的绑定码连接中台。
- 通过 Codex App Server 读取 `thread/list` 与 `thread/read(includeTurns)`。
- 用最长项目根目录匹配 Session；根目录下任意层级子目录都属于同一项目。
- 只把完整的用户问题和正常 `final_answer` 作为 Session 摘要输入，不维护 Turn 游标。
- 首次运行只采集最近 3 天；后续使用插件本地成功游标和 24 小时重叠窗口筛选候选 Session。
- 由当前 Codex Scheduled Task 一次处理一个 Session；无项目价值的 Session 只保存匿名本地 hash 以防重复提取，有价值的 Session 经脱敏、中文字段和 Schema 校验后立即上传。
- 使用跨运行租约阻止自动和手动采集并发；已接收 Session 继续由中台 `contentHash` 与幂等键防重。任何 Session 读取或提取失败时都不推进成功游标，下一次继续覆盖旧范围。
- 不做跨 Session 聚合，不生成工作卡片或 Report，不安装生命周期 Hook，不运行常驻 Runner。

数据中台：

- 以标准化工作邮箱创建 Partner；一个 Partner 可以拥有多个绑定码和 Plugin Instance。
- 在同一 `partner_id` 下合并多个 Plugin 上传的 Session Contribution，并保持 Tenant/Team/Partner 数据隔离。
- 周期到达截止时间后直接冻结当前贡献并进行跨 Session 聚合，不等待额外采集宽限期。
- 保存真实 Work Item，供 Admin 在 Web 中模拟 Partner 完成第一轮确认和修改。
- 基于确认后的不可变 Snapshot 调用模型生成 Report，供第二轮确认、重新生成和锁定。

## 本地启动

需要 Node.js 22 和 Docker Desktop。

```bash
npm ci
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Web：`http://127.0.0.1:4311`

API：`http://127.0.0.1:4310`

默认本地账号：

```text
saul@laien.io
123456
```

中台模型任务使用 OpenAI-compatible Responses API。服务机密只放在本机 `.env`：

```bash
MODEL_API_BASE_URL=http://127.0.0.1:11434
MODEL_API_KEY=...
MODEL_REASONING_EFFORT=low
```

Admin 可在运行总览中为 Team 选择允许的模型。没有 `MODEL_API_KEY` 时，真实 Fact 仍会保存，但中台生成任务会明确标记为 `MODEL_NOT_CONFIGURED`，不会伪造结果。

## 从 GitHub 安装 Plugin

仓库包含 Codex Marketplace 清单、Plugin Manifest、Skill、JSON Schema 和已构建 CLI。添加 Marketplace：

```bash
codex plugin marketplace add saul-LinY/partner-report-agent --ref main
```

然后在 Codex 桌面端打开 `/plugins`，从 `Partner Report Marketplace` 安装 `Partner Report`，并新建会话。

Plugin 不提供模型配置。首次创建 Codex 定时任务时默认使用 `gpt-5.6-sol`、`medium` 推理；之后 Codex Scheduled 面板是运行时间、模型、推理强度和通知策略的唯一配置来源。定时任务当前选择的模型直接完成 Session 级 Fact 提取，Plugin 不会再启动或指定另一个模型。跨 Session 聚合和 Report 生成仍使用 Admin 在中台选择的模型。

在 Admin Web 中先创建 Partner，再生成绑定码。随后在 Codex 中说：

```text
使用 $partner-report-sync，把数据中台 https://report-api.example.com 和绑定码 PR-XXXX-XXXX 连接起来。
```

绑定成功即按文档中的采集范围默认启用，不再要求单独确认上传授权。Plugin 只读取合格的完整 Turn，只向当前绑定中台上传校验后的结构化 Fact，并继续执行敏感信息过滤和 Session 排除规则。

绑定成功后，`$partner-report-sync` 会立即检查 Codex 桌面端的同名 Scheduled task。若不存在则按以下默认值创建；若已存在则保留用户修改过的时间、时区、模型、推理强度、通知、运行位置和项目设置：

```text
名称：Partner Report daily collection
运行于：新聊天
项目：无
时间：每天 13:30
时区：Asia/Shanghai（北京时间）
模型：gpt-5.6-sol
推理强度：medium
通知：仅失败提醒
Prompt：由 Plugin CLI 返回，包含采集边界、数据最小化规则和 automation memory 最小化规则
```

Scheduled tasks 仍由 Codex 官方界面管理；Skill 只负责首次创建默认任务，并在安全契约升级时只修复 Prompt，不覆盖用户在面板中的时间、模型等配置。Plugin CLI 不写私有调度器。定时运行依赖电脑开机且 Codex 桌面应用运行。

Scheduled Task 会使用任务级 `memory.md` 延续运行上下文，它不是按 Session 生成。Plugin Prompt 只允许其中保存运行时间、完成/失败/中断状态、聚合计数和安全错误码，禁止写入 Session 内容、Fact、证据、hash、端点或标识。memory 只用于运行摘要；自动与手动采集共享的防重和成功游标以 Plugin 本地 `collection-state.json` 及中台状态为准。

Plugin 的 Session 提取指令使用中文，并在上传前强制校验 `title`、`summary` 和 `contributions[].text` 包含中文。JSON 字段名和状态枚举保留英文，以维持 API/Schema 兼容。

手动验证：

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" status
使用 $partner-report-sync 运行一次 collect-start，并只返回安全的中文摘要。
```

macOS 默认把 Access/Refresh Token 存入 Keychain。只有显式设置 `PARTNER_REPORT_ALLOW_FILE_TOKENS=1` 才允许文件凭据回退。

## 数据流

```text
Codex Scheduled task（默认每天北京时间 13:30、新聊天、无项目；面板可修改）
  -> 当前任务选择的模型与推理强度
  -> 首次最近 3 天，后续按本地成功游标增量扫描
  -> 本地租约阻止自动与手动并发采集
  -> 过滤为完整 user question + final_answer Turn
  -> 已接收或已忽略且 hash 未变化的 Session 直接跳过
  -> 当前 Scheduled 会话逐 Session 生成中文贡献，Plugin 逐个校验
  -> HTTPS 幂等上传，完整成功后推进本地运行游标
  -> 中台按 Partner 冻结本周期 Fact
  -> 中台模型跨 Session 聚合 Work Item
  -> Admin Web 模拟 Partner 第一次审核和修改
  -> 冻结 Work Item Snapshot
  -> 中台模型生成个人 Report
  -> Admin Web 模拟 Partner 第二次审核并锁定
```

## 验证

```bash
npm run typecheck
npm test
RUN_DB_TESTS=1 npm test
npm run build
```

核心目录：

- `plugins/partner-report`：可安装 Plugin、Skill、CLI 和结构化 Schema
- `apps/api`：身份、绑定、Fact、审核、报告 API
- `apps/worker`：周截止调度与中台模型任务
- `apps/web`：精简 Admin 管理和两轮真实数据审核
- `packages/contracts`：共享 Zod/JSON Schema
- `packages/db`：PostgreSQL Schema、迁移和周五周期算法

部署环境变量见 [`.env.example`](.env.example)，产品边界见 [`docs/PRD.md`](docs/PRD.md)。
