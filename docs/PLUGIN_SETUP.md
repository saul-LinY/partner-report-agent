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

首次绑定会自动初始化一个每日采集任务。相同任务已经存在时会直接复用，用户不需要在 Scheduled 页面维护它。

## 3. 设置项目权限

打开 macOS“工作看板”应用，在“采集权限”页面：

1. 为新发现的项目选择“允许采集”或“不采集”。
2. 需要时直接修改旧项目权限。
3. 一次保存全部改动。

待审批或拒绝的项目不会读取 Session 内容。应用与插件使用同一中台权限版本，过期修改会提示刷新后重试。

## 4. 查看采集状态

桌面添加“工作看板”中尺寸组件。组件会显示当前 Mac 的采集状态、最近完成时间、本次上传数、下次运行，以及周一至周日每日有效 Session 数。

复杂操作全部在应用内完成：项目权限位于“采集权限”，最新一周工作卡片位于“工作卡片”，连接恢复和采集健康信息位于“设置”。
