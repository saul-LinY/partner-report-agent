# Partner Report Agent

面向单人实测的 Partner + Admin 周报 MVP。Plugin 在一周内持续从本机 Codex Session 增量提取“用户任务 + 模型最终结果”并同步结构化 Fact；只有到周周期截止后，数据中台才统一创建项目聚合任务。聚合结果先由 Partner 在数据中台审核项目卡片，一审通过后才生成个人周报，再由 Partner 在数据中台二次审核。飞书、团队 Report、Monitor 和 PDF 暂不进入当前主链路。

## 当前边界

- 一个 Tenant、一个 Team、一个同时具有 `admin` 与 `partner` Role 的本地账号。
- 中心数据使用 PostgreSQL；Plugin 的 Outbox、Cursor、任务和待同步 Payload 使用 `PLUGIN_DATA` 下的 SQLite。
- Plugin 本地提取任务只保存每个 Turn 的 `turn_id`、用户提问和 `final_answer`；推理、commentary、命令、工具调用、文件变化和完整聊天均不进入提取输入，也不上传中心服务。
- AI 事实提取、周项目聚合和个人周报生成由 Plugin 的本地 Runner 通过官方 `codex exec` 在本机完成，不需要额外 OpenAI API Key。
- 已同步任务、完成批次和临时工作文件默认保留 30 天，已消费 Hook 保留 7 天；待同步与待重试数据不会被自动清理。
- 所有业务实体和 API 查询均带 Tenant、Team、Partner 边界；已包含跨 Tenant 权限集成测试。
- `ExternalIdentity(provider, external_subject)`、统一 Review Command 和 Transactional Outbox 已为飞书与多人扩展预留。

## 启动

需要 Node.js 22、Docker Desktop 和本机 Codex CLI。

```bash
npm install
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

打开 `http://127.0.0.1:4311`。本地初始化账号：

```text
admin@local.test
ChangeMe-Partner-Report-2026!
```

API 健康检查为 `http://127.0.0.1:4310/health`。生产或共享环境必须覆盖示例密码，并启用安全 Cookie 与受控数据库凭据。

## Plugin

Repo 内 Plugin 位于 `plugins/partner-report`，包含标准 Manifest、`Stop`/`SessionEnd` Hook、Skill、CLI、本地 Runner 和版本化 JSON Schema。

```bash
npm run build -w @partner-report/plugin
```

仓库包含 `.agents/plugins/marketplace.json`，发布到 GitHub 后可通过 Codex 官方 Plugin 命令安装：

```bash
codex plugin marketplace add saul615/partner-report-agent --ref main
codex plugin add partner-report@partner-report-marketplace
```

安装后新开一个 Codex 会话，并告诉插件数据中台 API 地址，例如：“使用 `$partner-report-sync` 连接 `https://report-api.example.com`”。远程地址必须使用 HTTPS；本机开发可以使用 `http://127.0.0.1:4310`。也可以在启动 Codex 前设置 `PARTNER_REPORT_SERVER_URL`，CLI 会在未传 `--server` 时读取它：

```bash
export PARTNER_REPORT_SERVER_URL=https://report-api.example.com
```

绑定成功后，规范化的地址会保存在 Plugin 数据目录的 `config.json` 中；Runner 的心跳、Fact Batch、周任务租约和任务结果都发往该地址。服务器 URL 变更时必须重新执行连接，让新服务器签发新凭据，不能直接修改 `config.json` 后复用旧 Token。

绑定成功会启动单实例 Runner；之后 Hook 只记录 Session 活动，连续 120 分钟没有新 Turn 时 Runner 自动提取并同步，每 5 分钟发送健康心跳。普通同步只累计本周 Fact，不生成项目卡片或周报。Plugin 升级继续使用原来的 `PLUGIN_DATA`、Plugin Instance、中台地址和 Keychain 凭据，不重新绑定；如果新版本修改了 Hook 命令，Codex 可能要求重新确认 Hook 信任：

```bash
codex plugin marketplace upgrade partner-report-marketplace
```

Token 在 macOS 默认写入 Keychain，只有显式设置 `PARTNER_REPORT_ALLOW_FILE_TOKENS=1` 时才允许文件 fallback。立即执行一次完整链路可在 Codex 中要求 `$partner-report-sync` 立即同步；正常使用不需要手动触发。

服务器部署与环境变量说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 数据流

```text
Stop / SessionEnd Hook -> 本地活动时间 + quiet_until
  -> Local Runner（5 分钟心跳；默认等待 120 分钟静默）
  -> Codex App Server thread/list + thread/read(includeTurns)
  -> Session ID 判断新/历史会话，Turn ID 跳过已处理范围
  -> 只保留用户提问 + 模型 final_answer
  -> 本地脱敏与 SessionWorkFactV1 校验
  -> 幂等 Fact Batch 同步并推进本地 Cursor
  -> 数据中台在本周持续接收并保存 Fact
  -> 周周期 cutoff_at 到达（中央 Worker，只触发一次）
  -> AGGREGATE_WORK_ITEMS 租约任务
  -> Runner 按项目生成项目卡片
  -> Partner 在数据中台一审项目卡片
  -> 一审通过后创建 GENERATE_INDIVIDUAL_REPORT 任务
  -> Runner 生成个人周报
  -> Partner 在数据中台二审周报并确认
```

Hook 只向本地 SQLite 写活动时间和扫描提示，不联网、不执行 AI、不读取 `transcript_path`，失败也不会阻断 Codex。后台 `codex exec` 使用只读 Sandbox、临时 Session、忽略用户配置与规则并禁用 Hook，避免后台处理被再次采集。

## 验证

```bash
npm test
RUN_DB_TESTS=1 npx vitest run apps/api/src/authorization.integration.test.ts apps/worker/src/weekly.integration.test.ts
npm run typecheck
npm run build
```

历史单人验收曾处理 138 个 Session 候选：3 个符合路径、项目和周期策略并生成 6 个 Fact，135 个被策略排除，读取与提取失败均为 0。当前版本新增了“仅用户提问 + 最终回复”的输入约束、Session/Turn 增量测试、周截止幂等调度，以及数据中台项目卡片一审和周报二审。

数据库隐私断言会检查中心 Schema 不存在 transcript 字段、已知原始 Prompt 不存在于 Fact Payload、审计元数据不包含 Token/密码/Transcript 键；Admin Plugin Fleet 响应也不会返回 Token hash。

## 目录

- `apps/api`: Fastify API、状态机、权限和审计
- `apps/web`: Partner/Admin React 工作区
- `apps/worker`: 周截止调度、租约、授权和过期数据维护
- `packages/contracts`: Zod 契约与 Plugin JSON Schema 生成
- `packages/db`: Drizzle Schema、迁移、种子和周期算法
- `plugins/partner-report`: Codex Plugin、Hook、Skill、CLI 和 SQLite 状态

设计依据保留在 `docs/PRD.md` 与 `docs/00` 至 `docs/12` 阶段文档中。
