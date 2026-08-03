# 部署与远程连接

## 数据中台

数据中台由 PostgreSQL、`apps/api`、`apps/web` 和 `apps/worker` 组成。生产环境建议将 Web 与 API 放在 HTTPS 反向代理后，API 进程只需监听容器或服务器网卡。

生产环境至少设置：

```dotenv
DATABASE_URL=postgres://<user>:<password>@<postgres-host>:5432/partner_report
API_HOST=0.0.0.0
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

典型启动顺序：

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run build
npm run start -w @partner-report/api
npm run start -w @partner-report/worker
npm run preview -w @partner-report/web -- --host 0.0.0.0
```

前端是静态构建，也可以直接由 Nginx、Caddy 或对象存储托管。部署完成后先检查 `https://<api-host>/health` 返回 `status: "ok"`。

## Partner 设备

用户通过 GitHub Marketplace 安装插件后，在新 Codex 会话中说：

```text
使用 $partner-report-sync 连接 https://report-api.example.com
```

等 Partner 在 Web 确认设备码后，插件把该 API 地址写入本地配置。地址可包含部署前缀，例如 `https://example.com/partner-api`；查询参数、锚点和 URL 内嵌账号密码会被拒绝。

也可以通过环境变量连接：

```bash
PARTNER_REPORT_SERVER_URL=https://report-api.example.com \
  node "<installed-plugin-path>/dist/cli.mjs" connect
```

非本机 HTTP 会被拒绝，因为访问令牌、Fact 和任务结果都需要传输保护。本地开发允许 `http://127.0.0.1:4310`。仅在明确隔离的测试网络里，才可使用 `--allow-insecure-http`。

更换服务器时重新运行 `connect --server <new-url>` 完成新的设备授权。插件只会在新服务器签发凭据后切换保存地址，并清理旧的本地 Token。
