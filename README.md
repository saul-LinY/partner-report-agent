# Partner Report Agent

Partner Report 在本机采集获准项目中的有效 Codex Session，并把项目采集权限和每周工作卡片统一交给 macOS“工作看板”应用处理。

## 使用流程

1. 管理员创建用户并提供中台地址和个人绑定码。
2. 用户安装插件，在 Codex 中使用 `$partner-report-sync` 完成绑定。
3. 首次绑定会幂等创建官方每日定时采集任务，用户不需要维护运行时间。
4. 用户在“工作看板”的“采集权限”页批量允许或拒绝项目；未允许的项目不会读取 Session 内容。
5. 插件每天上传有效 Session，桌面中尺寸组件展示当前 Mac 的采集状态、上传数量、下次运行和周一至周日统计。
6. 每周为有有效数据的项目生成一张新工作卡片。用户在应用中确认、忽略，或通过自然语言生成新版本并对照修改前后内容。

应用不提供个人周报功能。历史周卡片在服务端保留，但应用默认只展示最新一期。

## 安装插件

```bash
codex plugin marketplace add saul-LinY/partner-report-agent
npm run plugin:install
codex plugin list
```

重启 Codex 后在新对话中发送：

```text
使用 $partner-report-sync 连接 Partner Report。
数据中台地址是：https://report-api.example.com
绑定码是：PR-XXXX-XXXX
```

详细步骤见 [插件安装与绑定](docs/PLUGIN_SETUP.md)。Google 登录服务配置见 [Google 登录配置](docs/GOOGLE_AUTH.md)。

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

macOS 工程位于 `apps/macos/PartnerReportWidget`，使用 XcodeGen 生成：

```bash
cd apps/macos/PartnerReportWidget
xcodegen generate
xcodebuild -project PartnerReportDesktop.xcodeproj -scheme PartnerReport CODE_SIGNING_ALLOWED=NO build
```
