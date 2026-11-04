# Weekly Report

团队周报系统（仓库名 `partner-report-agent`）。成员在 macOS App 里绑定身份、确认哪些项目可以被采集；App 把获准项目的会话包和运行日志上传到中台；中台用云端模型分析会话、生成工作卡片，成员审核后汇总成团队周报。所有提醒都由 App 调用 macOS 系统通知，中台保存排队记录和 App 回执。

数据只通过 macOS App 采集，不再提供 Codex 插件。

## 组成

| 目录                                | 内容                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/macos`                        | 原生 macOS App（SwiftUI），负责绑定、扫描、隐私标红、上传、通知和卡片审核，经 Sparkle 自动更新 |
| `apps/api`                          | 中台接口（Fastify）：采集、审核、管理、监控                                                    |
| `apps/worker`                       | 后台任务：会话分析、卡片生成、周报汇总、巡检                                                   |
| `apps/web`                          | 管理端网页（React）：成员总览、审核队列、报告归档、用户日志、系统日志、异常巡检                |
| `packages/contracts`、`packages/db` | 共享的数据契约、数据库结构与迁移                                                               |

## 使用流程

1. 管理员创建用户并提供中台地址和个人绑定码。
2. 用户安装 App，输入名字和绑定码，不需要邮箱。
3. App 拉取已有项目权限，用户可修改允许与拒绝的项目，新用户初始为空。
4. 用户选择对应的本机项目目录后，App 仅扫描、导入已授权项目最近一个月的会话。
5. App 按采集周期打包上传获准项目会话，并上传运行日志；中台监控实际上传结果。
6. App 拉取中台通知并调用 macOS 系统通知。已生成的工作卡片可在 App 审核，审核结果用于团队汇总。

完整会话包接收后自动进入会话分析；工作卡片在每期截止时间之后统一生成（每个周期每个项目一次），之后进入项目成果整合；本人审核后形成不可变快照，并按团队周期汇总周报。管理端“监控与排障”提供用户日志、系统日志和异常巡检，任务失败的重试入口在异常巡检。启动、恢复和验收见 [完整处理流水线](docs/APP_PIPELINE_OPERATIONS.md)。

### 隐私

上传前，App 会在本机把密钥、令牌、口令、邮箱、手机号、IP 地址、网址和本机路径替换成「[已隐藏]」，中台入库前用同一套规则再检查一遍。在 App 的「项目会话」里这些内容标红，点击顶部的“已标红 N 处”可以从上到下逐处查看；成员也可以自己增减标红。详见 App 内的「隐私说明」页和 [隐私脱敏](docs/PRIVACY_REDACTION.md)。

## 模型

中台只使用云端模型网关，不使用本机模型。网关需要提供 OpenAI 兼容的 `/v1/responses`，在 `.env` 里配置 `MODEL_API_BASE_URL` 和 `MODEL_API_KEY`（见 `.env.example`）。

团队可选模型及降级顺序在 `packages/contracts/src/models.ts`：`deepseek-v4.1-flash:cloud`（默认）、`deepseek-v4-pro:cloud`、`glm-5.2:cloud`、`kimi-k2.6:cloud`、`kimi-k2.7-code:cloud`、`minimax-m3:cloud`。某个模型失败时自动换下一个；密钥失效、额度耗尽、未配置这类所有模型共有的错误不降级。思考等级默认 `none`。细节见 [完整处理流水线](docs/APP_PIPELINE_OPERATIONS.md)。

## 本地运行

```bash
npm install
npm run db:migrate          # 需要先设置 DATABASE_URL
npm run db:seed             # 创建管理员和团队
npm run dev                 # API、Web、Worker 一起启动
```

联调 App 用的本机环境（API 4314、Web 4313）：

```bash
npm run app:services -- start     # 也支持 status / restart api|worker / stop
```

该脚本必须能读到 `MODEL_API_BASE_URL`，没配置会直接报错。部署见 [部署与远程连接](docs/DEPLOYMENT.md)，Google 登录见 [Google 登录配置](docs/GOOGLE_AUTH.md)，App 工作流与本机验证见 [App 采集工作流](docs/APP_COLLECTION_WORKFLOW.md)。

## 安装与发布 App

安装、打包、签名与自动更新见 [macOS App 说明](apps/macos/README.md)。发布新版本的顺序：

1. 递增 `apps/macos/project.yml` 里的 `MARKETING_VERSION` 和 `CURRENT_PROJECT_VERSION`。
2. 运行 `apps/macos/scripts/prepare-update.sh`，构建 Release、校验签名、打 ZIP 并生成已签名的 appcast。
3. 先把 ZIP 发布为 GitHub Release `macos-v<版本>`（`--latest=false`），再把生成的 appcast 复制到 `apps/macos/appcast.xml`，提交并推送 main。顺序不能反，否则更新源会指向还不存在的下载包。

## 开发验证

```bash
npm run typecheck
npm test                    # 单元测试；需要数据库的集成测试默认跳过
npm run build
```

数据库集成测试要用独立的测试库，避免正在运行的 Worker 领走测试任务：

```bash
DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<test-db> npm run db:migrate
RUN_DB_TESTS=1 DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<test-db> npx vitest run --no-file-parallelism
```

网页端的浏览器回归（Playwright，使用隔离的接口数据，不连真实服务）：

```bash
npx playwright install chromium
npm run test:e2e -w @partner-report/web        # 全部
npm run test:monitoring -w @partner-report/web # 用户日志、系统日志、异常巡检
npm run test:admin -w @partner-report/web      # 总览、审核队列、贡献预览、报告归档
```

测试启动本地 4312 端口；截图与失败追踪保存在 `apps/web/test-results/`。

macOS App 的原生测试：

```bash
cd apps/macos
xcodebuild test -project WeeklyReport.xcodeproj -scheme WeeklyReport -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```

改了 `project.yml` 或增删 Swift 文件后，先运行 `xcodegen generate --spec project.yml --project .` 重新生成工程。
