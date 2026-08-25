# Partner Report Agent

Partner Report 在本机采集获准项目中的有效 Codex Session，并通过飞书完成项目采集授权、连接恢复和每周工作卡片审核。

## 使用流程

1. 管理员创建用户并提供中台地址和个人绑定码。
2. 用户安装插件，在 Codex 中使用 `$partner-report-sync` 完成绑定。
3. 首次绑定会幂等创建官方每日定时采集任务，并立即开始首次项目发现。
4. 系统按工作邮箱直接私发项目权限卡，不增加单独的飞书连接确认；用户允许或拒绝采集，未允许的项目不会读取 Session 内容。
5. 插件每天上传获准项目中的有效 Session，并在本地保留采集状态和诊断信息。
6. 每周为有有效数据的项目生成工作卡片，用户直接在飞书逐项接受或忽略；接受结果进入团队报告汇总。

产品不提供个人周报，也不要求用户安装额外桌面应用。历史工作卡片和审核快照由服务端保存，用于审计和团队汇总。

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
飞书应用配置和投递机制见 [飞书审核接入](docs/FEISHU.md)。

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
