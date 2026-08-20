# Partner Report 插件配置教程

整个配置大约需要 3 分钟。开始前，请向团队管理员获取：

- **数据中台地址**，例如 `https://report-api.example.com`
- **绑定码**，例如 `PR-XXXX-XXXX`

> 绑定码属于敏感凭证，请勿转发给他人。

## 1. 安装插件

打开终端，依次执行：

```bash
codex plugin marketplace add saul-LinY/partner-report-agent
npm run plugin:install
```

使用下面的命令确认插件已安装：

```bash
codex plugin list
```

安装脚本只授权 `partner-report` 插件自带的 MCP 工具自动运行，不会把整个 Codex 改成完全访问，也不会改变用户当前的全局权限模式。旧版升级时，它会把 Keychain 中的插件凭据一次性迁移到 `~/.partner-report-data/secrets.json`；之后定时任务不再访问 Keychain。

列表中出现 `partner-report` 后，重启 Codex，并新建一个对话。以后升级仍运行 `npm run plugin:install`，普通兼容升级不需要重新绑定或重新授权。

定时任务请在 Codex/ChatGPT 桌面端的 Scheduled 中创建和管理，VS Code 插件只用于开发和普通会话测试。首次创建任务前，先在桌面端新对话中手动运行一次 `$partner-report-sync`，确认 MCP 连接、项目权限和上传链路正常。需要读取本机 Session 的定时任务运行时，电脑必须开机且桌面端保持运行。

## 2. 连接 Partner Report

在新对话中发送：

```text
使用 $partner-report-sync 连接 Partner Report。
数据中台地址是：http://172.20.10.14:4310
绑定码是：PR-XXXX-XXXX
```

Codex 会通过插件 MCP 自动完成连接测试，并创建每日采集任务。安装脚本完成后，后续定时采集不应再出现 CLI、目录写入或 Keychain 的二次确认。

## 3. 确认身份和项目范围

打开工作邮箱对应的飞书账号，按提示完成：

1. 确认本人身份。
2. 勾选允许采集的项目。
3. 提交项目范围。

未允许的项目不会读取对话内容。以后发现新项目时，飞书会再次通知你确认。

## 4. 检查定时任务

打开 Codex 的 **Scheduled（定时任务）**，确认存在：

```text
Partner Report daily collection
```

默认每天北京时间 14:30 运行。你可以修改运行时间、模型、推理强度和通知方式，请不要修改任务 Prompt。

## 完成后怎么用

插件会按计划自动同步，不需要每天手动操作。想立即检查时，可以在新对话中说：

```text
使用 $partner-report-sync 检查连接和采集状态。
```

常用操作也可以直接用自然语言描述，例如：

- `查看目前允许采集的项目`
- `不要采集 xxx 项目`
- `立即采集一次`

## 常见问题

**连接失败**  
先确认中台地址完整且以 `https://` 开头，再让 Codex 重新检查连接。绑定成功后通常不需要重新申请绑定码。

**没有收到飞书通知**  
确认飞书登录邮箱与管理员登记的工作邮箱一致；仍未收到时，请管理员检查飞书应用可用范围。

**定时任务没有运行**  
在 Scheduled 中确认任务已启用，并检查通知或最近一次运行结果。

**换了中台地址**  
直接告诉 Codex“把 Partner Report 中台地址改为新地址”，不要删除插件或本地配置。

## 数据说明

插件只上传经过筛选和校验的中文项目贡献摘要。原始对话、本机绝对路径和 Codex Session 原始标识不会上传；未授权项目也不会被读取。
