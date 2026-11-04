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

生产环境必须显式设置 `NODE_ENV=production` 和 `DATABASE_URL`。缺少 `DATABASE_URL` 时 API、Worker 和数据库迁移会拒绝启动，避免误连开发机的 `localhost:54329`。App 只访问公开 HTTPS API，不直接连接 PostgreSQL；API 将通知事件持久化，App 拉取后调用 macOS 系统通知并回传回执。生产环境不启用本机管理员账号别名。

## 可信局域网联调

临时局域网联调时，API 和 Web 进程监听中台 Mac 的局域网地址，公开 URL 使用同一个地址。以下示例使用当前中台地址 `172.20.10.14`：

```dotenv
API_HOST=0.0.0.0
API_PORT=4310
WEB_ORIGIN=http://172.20.10.14:4311
VITE_API_URL=http://172.20.10.14:4310
SESSION_COOKIE_SECURE=false
```

局域网 IP 改变后，更新两个公开 URL 并重启 API、Web。Docker Compose 只把 PostgreSQL 发布到 `127.0.0.1:54329`，不得为了设备连接而开放数据库端口。

macOS App 的服务地址由构建配置 `WEEKLY_REPORT_SERVICE_URL` 固定，生产地址要求 HTTPS，见 [macOS App 说明](../apps/macos/README.md)。局域网 HTTP 只用于同一可信、隔离的测试网络，跨网段、共享办公网络或长期运行时必须使用 HTTPS。

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

用户安装 macOS App，输入名字和管理员提供的绑定码完成绑定，之后由 App 采集并上传会话。打包、安装和更新见 [macOS App 说明](../apps/macos/README.md)。

更换服务器时，修改 `project.yml` 的 `WEEKLY_REPORT_SERVICE_URL` 并重新构建 App；切换地址后需要重新绑定。
