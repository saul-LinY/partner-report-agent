# Partner Report Agent

Partner Report 是一个 Codex Plugin + 数据中台 MVP：官方 Codex Scheduled Task 读取本地 Session，先舍弃闲聊、无价值和项目无关内容，再把有意义的工作整理为 Session Contribution 并立即上传。数据中台按 Partner 跨 Session 聚合工作卡片、完成 Web 审核并生成 Report。Partner 可以在 Codex Scheduled 面板修改运行时间、模型、推理强度和通知策略。

当前不接入飞书和 Monitor。Web 审核使用真实 Fact、Work Item、Snapshot 和 Report Version，不生成演示假数据。

## 职责边界

Plugin：

- 使用 Admin 为 Partner 工作邮箱生成的绑定码连接中台。
- 通过 Codex App Server 读取 `thread/list` 与 `thread/read(includeTurns)`。
- 用最长项目根目录匹配 Session；根目录下任意层级子目录都属于同一项目。
- 只把完整的用户问题和正常 `final_answer` 作为 Session 摘要输入，不维护 Turn 游标。
- 首次运行只采集最近 1 天；后续使用插件本地成功游标和 24 小时重叠窗口筛选候选 Session。
- 由当前 Codex Scheduled Task 一次处理一个 Session；无项目价值的 Session 只保存匿名本地 hash 以防重复提取，有价值的 Session 经脱敏、中文字段和 Schema 校验后立即上传。
- 使用跨运行租约阻止自动和手动采集并发；已接收 Session 继续由中台 `contentHash` 与幂等键防重。任何 Session 读取或提取失败时都不推进成功游标，下一次继续覆盖旧范围。
- 不做跨 Session 聚合，不生成工作卡片或 Report，不安装生命周期 Hook，不运行常驻 Runner。

数据中台：

- 以标准化工作邮箱创建 Partner；一个 Partner 可以拥有多个绑定码和 Plugin Instance。
- 在同一 `partner_id` 下合并多个 Plugin 上传的 Session Contribution，并保持 Tenant/Team/Partner 数据隔离。
- 周期到达截止时间后直接冻结当前贡献并进行跨 Session 聚合，不等待额外采集宽限期。
- 保存真实 Work Item，供 Admin 在 Web 中模拟 Partner 完成第一轮确认和修改。
- 最后一张工作卡片完成审核后，自动冻结不可变 Snapshot 并生成个人 Report 草稿。
- Team Admin 分别配置工作卡片聚合时间和 Team Report 生成时间；Team Report 不因全员提前提交而提前生成。
- 归档工作卡片、个人 Report 和 Team Report，并保留每个个人 Report 版本引用的工作卡片版本。

## 本地启动

需要 Node.js 22 和 Docker Desktop。

```bash
npm ci
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

当前这台中台 Mac 的局域网入口：

```text
Web：http://172.20.10.14:4311
API：http://172.20.10.14:4310
```

API 和 Web 监听所有网卡，PostgreSQL 仅监听本机回环地址。局域网 IP 变化后，需要同步更新根目录 `.env` 中的 `WEB_ORIGIN`、`VITE_API_URL` 和 `PARTNER_REPORT_SERVER_URL`，再重启服务。同事设备必须与中台处于同一可信局域网；macOS 防火墙需要允许 Node 接收入站连接。

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

Plugin 不提供模型配置。首次创建 Codex 定时任务时默认使用 `gpt-5.5`、`low` 推理；之后 Codex Scheduled 面板是运行时间、模型、推理强度和通知策略的唯一配置来源。定时任务当前选择的模型直接完成 Session 级 Fact 提取，Plugin 不会再启动或指定另一个模型。跨 Session 聚合和 Report 生成仍使用 Admin 在中台选择的模型。

在 Admin Web 中先创建 Partner，再生成绑定码。随后在 Codex 中说：

```text
使用 $partner-report-sync，把数据中台 https://report-api.example.com 和绑定码 PR-XXXX-XXXX 连接起来。
```

绑定成功后先通过飞书确认审核身份和项目采集范围。Plugin 只用 `thread/list` 发现候选项目；项目获准前不调用 `thread/read`、不交给模型，也不上传 Session 内容。首次允许立即生效，后续新增项目汇总审批并从下个周期生效。Plugin 继续执行敏感信息过滤和 Session 排除规则。

当前局域网测试环境使用 HTTP。同事连接时需要明确说明这是可信测试局域网，由 Skill 在连接命令中显式追加 `--allow-insecure-http`。例如：

```text
使用 $partner-report-sync，把可信测试局域网的数据中台 http://172.20.10.14:4310 和绑定码 PR-XXXX-XXXX 连接起来，允许局域网 HTTP。
```

HTTP 会明文传输访问令牌和贡献数据，只适合隔离的临时测试网络；跨网络或长期使用应按部署文档配置 HTTPS。

绑定成功后，`$partner-report-sync` 会立即检查 Codex 桌面端的同名 Scheduled task。若不存在则按以下默认值创建；若已存在则保留用户修改过的时间、时区、模型、推理强度、通知、运行位置和项目设置：

```text
名称：Partner Report daily collection
运行于：新聊天
项目：无
时间：每天 14:30
时区：Asia/Shanghai（北京时间）
模型：gpt-5.5
推理强度：low
通知：所有运行
Prompt：由 Plugin CLI 返回，包含采集边界、数据最小化规则、automation memory 最小化规则和终态审查要求
```

Scheduled tasks 仍由 Codex 官方界面管理；Skill 只负责首次创建默认任务，并在安全契约升级时只修复 Prompt，不覆盖用户在面板中的时间、模型等配置。Plugin CLI 不写私有调度器。定时运行依赖电脑开机且 Codex 桌面应用运行。

Scheduled Task 会使用任务级 `memory.md` 延续运行上下文，它不是按 Session 生成。Plugin Prompt 只允许其中保存运行时间、完成/失败/中断状态、聚合计数和安全错误码，禁止写入 Session 内容、Fact、证据、hash、端点或标识。memory 只用于运行摘要；自动与手动采集共享的防重和成功游标以用户稳定目录 `~/.partner-report-data/collection-state.json` 及中台状态为准。项目权限执行状态、匿名键盐值和本机根目录映射保存在同目录的 `project-scope.json`，中台保存版本化的正式规则；正常插件更新或缓存替换不会删除这些文件。若升级后的第一次采集发现权限文件缺失、损坏或不属于当前插件实例，CLI 不会用中台旧权限直接恢复，而会废止旧匿名项目映射、重新发送飞书首次审批卡，并在读取 Session 内容前结束本次运行。审批后下一次定时运行会自动采集，也可以在普通 Session 中说“继续采集”立即发起一次新的运行。

Plugin 的 Session 提取指令使用中文，并在上传前强制校验 `title`、`summary` 和 `contributions[].text` 包含中文。JSON 字段名和状态枚举保留英文，以维持 API/Schema 兼容。

手动验证：

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" status
使用 $partner-report-sync 运行一次 collect-start，并只返回安全的中文摘要。
```

macOS 默认把 Access/Refresh Token 存入 Keychain。只有显式设置 `PARTNER_REPORT_ALLOW_FILE_TOKENS=1` 才允许文件凭据回退。CLI 会把旧版运行时 `PLUGIN_DATA` 中的持久文件迁移到稳定用户目录，不迁移临时 Run 或租约文件。

## 数据流

```text
Codex Scheduled task（默认每天北京时间 14:30、新聊天、无项目；面板可修改）
  -> 当前任务选择的模型与推理强度
  -> 首次最近 1 天，后续按本地成功游标增量扫描
  -> 本地租约阻止自动与手动并发采集
  -> 检查本地项目权限文件；缺失或无效时按当前周期元数据登记候选项目并等待飞书审批
  -> 过滤为完整 user question + final_answer Turn
  -> 仅按完整问答生成稳定内容 hash，不受标题或项目登记状态变化影响
  -> 合并本地 accepted/ignored ledger 与中台状态，已处理且内容未变化的 Session 在模型前直接跳过
  -> 当前 Scheduled 会话逐 Session 生成中文贡献，Plugin 逐个校验
  -> HTTPS 幂等上传，队列清空后执行独立终态审查
  -> 审查确认无剩余 Job 且无失败后推进本地运行游标
  -> 中台按 Partner 冻结本周期 Fact
  -> 中台模型跨 Session 聚合 Work Item
  -> Admin Web 模拟 Partner 第一次审核和修改
  -> 最后一张卡片审核后自动冻结 Work Item Snapshot
  -> 中台模型自动生成个人 Report
  -> Admin Web 模拟 Partner 第二次审核并锁定
  -> 到 Team 配置时间后基于届时已锁定版本生成 Team Report
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
