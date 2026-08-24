# Partner Report 插件安装与绑定

开始前，从团队管理员处获取数据中台地址和本人专用绑定码。绑定码属于个人凭证，不应转发或多人共用。

## 1. 安装

```bash
codex plugin marketplace add saul-LinY/partner-report-agent
npm run plugin:install
codex plugin list
```

安装脚本只配置插件自带 MCP，不会修改 Codex 的全局权限模式。安装后重启 Codex。

## 2. 绑定

在新的 Codex 对话中发送：

```text
使用 $partner-report-sync 连接 Partner Report。
数据中台地址：https://report-api.example.com
绑定码：PR-XXXX-XXXX
```

首次绑定会自动初始化一个每日采集任务，并立即开始首次项目发现。相同任务已经存在时会直接复用，用户不需要在 Scheduled 页面维护它。

## 3. 设置项目权限

插件首次发现项目后，系统会按管理员登记的工作邮箱直接私发项目权限卡，不增加单独的飞书连接确认步骤：

1. 为新发现的项目选择“允许采集”或“不采集”。
2. 需要时直接修改旧项目权限。
3. 在同一张卡片一次提交全部选择。

待审批或拒绝的项目不会读取 Session 内容；过期卡片会提示使用最新版本。

## 4. 查看采集状态

采集任务按计划在 Codex 中运行。需要查看或排查状态时，在 Codex 中使用 `$partner-report-sync` 检查连接和采集状态；管理员可在 Web 管理端查看脱敏诊断日志。

每周工作卡片会私发到已确认的飞书账号，只提供“接受”和“忽略”。连接凭据失效时，插件发起恢复申请，用户在飞书确认后插件自动领取新凭据。
