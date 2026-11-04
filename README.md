# Partner Report Agent

Partner Report 通过 macOS App 绑定用户、确认项目采集权限，并上传获准项目的会话包和运行日志。所有消息均由 App 调用 macOS 系统通知，中台保存排队记录及 App 回执。

## 使用流程

1. 管理员创建用户并提供中台地址和个人绑定码。
2. 用户安装 App，输入名字和绑定码，不需要邮箱。
3. App 拉取已有项目权限，用户可修改允许与拒绝的项目，新用户初始为空。
4. 用户选择对应的本机项目目录后，App 仅扫描、导入已授权项目最近一个月的会话。
5. App 按采集周期打包上传获准项目会话，并上传运行日志；中台监控实际上传结果。
6. App 拉取中台通知并调用 macOS 系统通知。已生成的工作卡片可在 App 审核，审核结果用于团队汇总。

完整会话包接收后自动进入会话分析；工作卡片在每期截止时间之后统一生成（每个周期每个项目一次），之后进入项目成果整合；本人审核后形成不可变快照，并按团队周期汇总周报。管理端“监控与排障”提供用户日志、系统日志和异常巡检，任务失败的重试入口在异常巡检。启动、恢复和验收见 [完整处理流水线](docs/APP_PIPELINE_OPERATIONS.md)。

## 安装插件

```bash
codex plugin marketplace add saul-LinY/partner-report-agent
npm run plugin:install
codex plugin list
```

安装命令会构建插件、刷新 Codex cachebuster，并校验缓存中的运行产物与仓库一致。

重启 Codex 后在新对话中发送：

```text
使用 $partner-report-sync 连接 Partner Report。
数据中台地址是：https://report-api.example.com
绑定码是：PR-XXXX-XXXX
```

详细步骤见 [插件安装与绑定](docs/PLUGIN_SETUP.md)。Google 登录服务配置见 [Google 登录配置](docs/GOOGLE_AUTH.md)。
App 工作流与本机验证见 [App 采集工作流](docs/APP_COLLECTION_WORKFLOW.md)。

## 开发验证

```bash
npm install
npm run typecheck
npm test
npm run build
```

需要数据库集成测试时：

```bash
npm run db:migrate
RUN_DB_TESTS=1 npm test
```

用户日志、系统日志和异常巡检页面的浏览器回归使用隔离的接口数据，覆盖成员隔离、查询、研判和不同屏宽：

```bash
npx playwright install chromium
npm run test:monitoring -w @partner-report/web
```

测试启动本地 4312 端口；截图与失败追踪保存在 `apps/web/test-results/`。

运行总览、审核队列、贡献预览和报告归档的回归测试：

```bash
npm run test:admin -w @partner-report/web
# 管理页面与监控页面的全部浏览器回归
npm run test:e2e -w @partner-report/web
```
