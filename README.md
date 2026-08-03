# Partner Report Agent

Partner Report 是一个 Codex Plugin + 数据中台 MVP：Plugin 每周五 13:00 从配置的项目目录中读取本地 Codex Session，只处理完整的一问一答，并上传结构化 Fact；数据中台再按 Partner 跨 Session 聚合工作卡片、完成第一次 Web 模拟审核、生成个人 Report，并完成第二次 Web 模拟审核。

当前不接入飞书和 Monitor。Web 审核使用真实 Fact、Work Item、Snapshot 和 Report Version，不生成演示假数据。

## 职责边界

Plugin：

- 使用 Admin 为 Partner 工作邮箱生成的绑定码连接中台。
- 通过 Codex App Server 读取 `thread/list` 与 `thread/read(includeTurns)`。
- 用最长项目根目录匹配 Session；根目录下任意层级子目录都属于同一项目。
- 只保留非空用户问题和正常 `final_answer`。正在回答、中断、取消或失败的 Turn 不处理、不推进游标。
- 在本机用隔离的 `codex exec` 将单个 Session 提取成结构化 Fact，并做脱敏、Schema 校验和幂等上传。
- 不做跨 Session 聚合，不生成工作卡片或 Report，不安装生命周期 Hook，不运行常驻 Runner。

数据中台：

- 以标准化工作邮箱创建 Partner；一个 Partner 可以拥有多个绑定码和 Plugin Instance。
- 在同一 `partner_id` 下合并多个 Plugin 上传的 Fact，并保持 Tenant/Team/Partner 数据隔离。
- 周期结束且采集完成或宽限期结束后，调用 OpenAI Responses API 做跨 Session 聚合。
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
codex plugin marketplace add saul615/partner-report-agent --ref v0.2.0
```

然后在 Codex 桌面端打开 `/plugins`，从 `Partner Report Marketplace` 安装 `Partner Report`，并新建会话。

在 Admin Web 中先创建 Partner，再生成绑定码。随后在 Codex 中说：

```text
使用 $partner-report-sync，把数据中台 https://report-api.example.com 和绑定码 PR-XXXX-XXXX 连接起来。
```

绑定完成后，在 Codex 桌面端或 Web 的 Scheduled tasks 中创建项目级任务：

```text
名称：Partner Report weekly collection
时间：Team 时区每周五 13:00
Prompt：Use $partner-report-sync to run weekly-collect and return only the safe collection summary.
```

Scheduled tasks 由 Codex 官方界面管理，CLI/IDE 目前不提供创建入口。定时运行依赖电脑开机且 Codex 桌面应用运行。

手动验证：

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" status
node "<PLUGIN_PATH>/dist/cli.mjs" weekly-collect
```

macOS 默认把 Access/Refresh Token 存入 Keychain。只有显式设置 `PARTNER_REPORT_ALLOW_FILE_TOKENS=1` 才允许文件凭据回退。

## 数据流

```text
Codex Scheduled task（周五 13:00）
  -> 项目根目录与子目录 Session 扫描
  -> 过滤为完整 user question + final_answer Turn
  -> Plugin 本地逐 Session 提取结构化 Fact
  -> HTTPS 幂等上传并推进 Complete Turn Cursor
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
