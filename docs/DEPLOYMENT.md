# 部署与远程连接

## 数据中台

数据中台由 PostgreSQL、`apps/api`、`apps/web` 和 `apps/worker` 组成。生产环境建议将 Web 与 API 放在 HTTPS 反向代理后，API 进程只需监听容器或服务器网卡。

生产环境至少设置：

```dotenv
NODE_ENV=production
DATABASE_URL=postgres://<user>:<password>@<postgres-host>:5432/partner_report
API_HOST=172.20.10.14
API_PORT=4310
WEB_ORIGIN=https://report.example.com
VITE_API_URL=https://report-api.example.com
SESSION_COOKIE_SECURE=true
BOOTSTRAP_ADMIN_EMAIL=<admin-email>
BOOTSTRAP_ADMIN_PASSWORD=<strong-unique-password>
BOOTSTRAP_DISPLAY_NAME=<admin-name>
BOOTSTRAP_TEAM_NAME=<team-name>
PLUGIN_MIN_VERSION=0.1.0
```

`VITE_API_URL` 是构建 Web 前端时写入浏览器包的公开 API 地址。`WEB_ORIGIN` 是用户实际打开的 Web 地址，同时用于 CORS、设备确认链接和邀请链接。两者不要以 `/` 结尾。防火墙只需向 Partner 设备开放 API 的 HTTPS 入口；PostgreSQL 不应暴露到公网。

生产环境必须显式设置 `NODE_ENV=production` 和 `DATABASE_URL`。缺少 `DATABASE_URL` 时 API、Worker 和数据库迁移会拒绝启动，避免误连开发机的 `localhost:54329`。插件和 macOS 应用只访问公开 HTTPS API，不直接连接 PostgreSQL。

## 可信局域网联调

临时局域网联调时，API 和 Web 进程监听中台 Mac 的局域网地址，公开 URL 使用同一个地址。以下示例使用当前中台地址 `172.20.10.14`：

```dotenv
API_HOST=0.0.0.0
API_PORT=4310
WEB_ORIGIN=http://172.20.10.14:4311
VITE_API_URL=http://172.20.10.14:4310
SESSION_COOKIE_SECURE=false
PARTNER_REPORT_SERVER_URL=http://172.20.10.14:4310
```

局域网 IP 改变后，更新三个公开 URL 并重启 API、Web。Docker Compose 只把 PostgreSQL 发布到 `127.0.0.1:54329`，不得为了插件连接而开放数据库端口。

Partner 设备连接局域网 HTTP 时必须明确接受明文传输风险。正常用户流程应在 Codex 对话中由 `partner-report` MCP 的 `connect` 工具完成；下面的 CLI 仅用于部署排障：

```bash
node "<installed-plugin-path>/dist/cli.mjs" connect \
  --server http://172.20.10.14:4310 \
  --binding-code PR-XXXX-XXXX \
  --allow-insecure-http
```

这种方式只用于同一可信、隔离的测试局域网。跨网段、共享办公网络或长期运行时必须使用 HTTPS。

典型启动顺序：

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run build
npm run start -w @partner-report/api
npm run start -w @partner-report/worker
npm run preview -w @partner-report/web -- --host 172.20.10.14
```

前端是静态构建，也可以直接由 Nginx、Caddy 或对象存储托管。部署完成后先检查 `https://<api-host>/health` 返回 `status: "ok"`。

## Partner 设备

用户通过 Marketplace 安装或升级插件时，统一运行仓库中的安装脚本：

```bash
npm run plugin:install
```

该脚本先刷新 Git Marketplace，再幂等执行插件安装，并通过 Codex 配置接口只设置：

```toml
[plugins."partner-report".mcp_servers."partner-report"]
enabled = true
default_tools_approval_mode = "approve"
```

它不修改全局权限模式。升级时插件名和 MCP Server 名保持不变，因此原授权继续有效；脚本仍会复核配置，并把旧 Keychain Token 一次性迁移到稳定 `0600` 文件。完成后重启 Codex 桌面端，在新会话中先手动验证一次。需要读取本机 Session 的定时任务运行时，电脑必须开机且桌面端保持运行。在新会话中说：

```text
使用 $partner-report-sync 连接 https://report-api.example.com
```

等 Partner 在 Web 确认设备码后，插件把该 API 地址写入本地配置。地址可包含部署前缀，例如 `https://example.com/partner-api`；查询参数、锚点和 URL 内嵌账号密码会被拒绝。

也可以通过环境变量连接：

```bash
PARTNER_REPORT_SERVER_URL=https://report-api.example.com \
  node "<installed-plugin-path>/dist/cli.mjs" connect
```

非本机 HTTP 会被拒绝，因为访问令牌、Fact 和任务结果都需要传输保护。本机开发允许回环 HTTP；仅在明确隔离的测试网络里，才可使用 `--allow-insecure-http`。

更换服务器时重新运行 `connect --server <new-url>` 完成新的设备授权。插件只会在新服务器签发凭据后切换保存地址，并清理旧的本地 Token。
