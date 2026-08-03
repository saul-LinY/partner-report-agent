# Partner Report Codex Plugin

Partner Report 在本机增量读取符合策略的 Codex 会话，只提取“用户任务 + 模型最终回复”形成结构化进展，并同步到你配置的数据中台。普通运行只累计本周 Fact；周截止后才执行项目聚合、Partner 一审、周报生成和 Partner 二审。

本仓库是可直接安装的 Codex Marketplace 发布包，包含 Plugin Manifest、Skill、Hook、Runner、独立可执行 bundle、JSON Schema、源码和契约包。数据中台服务端不在此公开安装包内。

## 安装

需要 Codex 和 Node.js 22.13 或更高版本。按照 Codex 官方 Marketplace 流程执行：

```bash
codex plugin marketplace add saul615/partner-report-agent --ref main
codex plugin add partner-report@partner-report-marketplace
```

安装后新开一个 Codex 会话，让新 Skill 和 Hook 生效。

## 连接数据中台

在新会话中直接告诉插件服务器地址：

```text
使用 $partner-report-sync 连接 https://report-api.example.com
```

插件会返回设备验证码与确认页面。Partner 在 Web 中批准后，CLI 才会保存服务器地址和新服务器签发的凭据，并启动单实例 Runner。

也可以在启动 Codex 前设置默认地址：

```bash
export PARTNER_REPORT_SERVER_URL=https://report-api.example.com
```

地址支持端口和部署前缀，例如 `https://example.com:8443/partner-api`。远程服务器默认必须使用 HTTPS；本机开发允许 `http://127.0.0.1:4310`。查询参数、锚点和 URL 内嵌账号密码会被拒绝。

绑定后的规范化地址保存在 Plugin 数据目录的 `config.json`。Runner 的以下通信全部复用该地址：

- 获取 Team、项目、周期和静默时间策略
- 上传结构化 Fact Batch
- 发送设备与 Runner 健康状态
- 租用周项目聚合或周报生成任务
- 提交结构化项目卡片与周报结果

数据中台迁移到新地址时，重新执行连接，让新服务器签发新凭据。不要手工修改 `config.json` 后把旧 Token 发往另一台服务器。

更多地址规则和服务端入口见 [远程服务器配置](docs/REMOTE_SERVER.md)。

## 本地工作方式

```text
Stop / SessionEnd Hook
  -> 只写本地活动标记，不联网、不调用模型
  -> Session 静默达到 Team 策略（默认 120 分钟）
  -> Runner 读取 Session ID 与新 Turn ID
  -> 只保留用户提问和 assistant final_answer
  -> 本地 Codex 临时会话提取结构化进展
  -> 校验、脱敏、幂等上传到已绑定的数据中台
  -> 一周截止后才处理聚合与周报任务
```

Hook 不会读取 `transcript_path`，失败也不会阻断正常 Codex 会话。后台 `codex exec` 使用只读、临时 Session，并禁用 Hook，避免后台处理再次触发采集。

## 本地数据与隐私

- SQLite、Cursor、待同步批次和临时任务保存在 Codex 提供的 Plugin 数据目录；升级插件会复用该目录。
- macOS Token 默认存入 Keychain。其他平台使用权限为 `0600` 的本地凭据文件；macOS 只有显式设置 `PARTNER_REPORT_ALLOW_FILE_TOKENS=1` 才允许文件 fallback。
- 上传内容是经过 Schema 校验的结构化工作 Fact、心跳和任务结果，不上传推理、commentary、命令、工具调用、文件变更或完整聊天。
- 已完成本地记录默认保留 30 天，已消费 Hook 默认保留 7 天；待同步和待重试数据不会自动删除。

## 从源码验证

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`plugins/partner-report/dist/cli.mjs` 已提交，因此 Codex 从 GitHub 安装后无需运行 `npm install` 或构建步骤。

## 更新

```bash
codex plugin marketplace upgrade partner-report-marketplace
codex plugin add partner-report@partner-report-marketplace
```

更新完成后新开一个 Codex 会话。版本更新会继续使用已保存的 Plugin Instance、服务器地址和本地状态；只有服务器地址变化或绑定被撤销时才需要重新连接。
