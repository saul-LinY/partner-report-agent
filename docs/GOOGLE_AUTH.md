# Google 登录配置

本项目保留原有邮箱密码登录，并使用 Google Identity Services（GIS）重定向模式提供 Google 登录。Google 官方按钮将签名 ID Token 直接 `POST` 到 API，API 使用 Google 官方库验证身份后创建数据库 Session。此模式只需要 Client ID，不需要 Google Client Secret。

## 账号与权限策略

- Google 登录不会自动创建 Team、membership、Partner 或角色。
- Google 邮箱必须匹配一个已有的 `active` 用户，且该用户已有 membership。首次成功登录会在 `external_identities` 中绑定 Google `sub`。
- 角色始终从 `memberships.roles` 读取，不接受前端或 Google 提交的角色。
- `GOOGLE_ALLOWED_DOMAIN` 和 `GOOGLE_ALLOWED_EMAILS` 都为空时，允许任意 Google 域名，但用户仍必须已在应用中预置。
- 配置任一限制后，邮箱列表或 Workspace 域名匹配其一即可。Workspace 域名同时校验邮箱后缀和 Google `hd` 声明。
- 管理页面和管理 API 要求 `admin`；Partner 页面和写接口要求 `partner`。Plugin API 继续使用独立的 Plugin Access Token。

## 环境变量

```env
GOOGLE_CLIENT_ID=360156811535-vui327cl8rb6onbi9i0nnedufcj5v2hv.apps.googleusercontent.com
GOOGLE_REDIRECT_URI=http://localhost:4310/auth/google/callback
GOOGLE_ALLOWED_DOMAIN=
GOOGLE_ALLOWED_EMAILS=
SESSION_SECRET=
AUTH_COOKIE_SECURE=false
WEB_ORIGIN=http://localhost:4311
VITE_API_URL=http://localhost:4310
```

`SESSION_SECRET` 至少 32 个字符，建议用密码管理器生成 32 字节以上的随机值。不要在日志、前端变量、源码或 Git 中保存 `SESSION_SECRET`、ID Token 或 Cookie。

## 本地开发

Google 只允许 HTTPS 登录地址；唯一 HTTP 例外是 `localhost`。真实 Google 登录不能使用 `http://172.20.10.14` 这类局域网 IP。

1. 在 Google Cloud Console 添加 Authorized JavaScript origin：`http://localhost:4311`。
2. 添加 Authorized redirect URI：`http://localhost:4310/auth/google/callback`。
3. 在已被 Git 忽略的 `.env` 中填写 Client ID 和 Session Secret，不需要 Client Secret。
4. 设置 `AUTH_COOKIE_SECURE=false`，启动 `npm run dev`。
5. 必须从 `http://localhost:4311` 打开 Web 应用进行 Google 登录。

## 生产部署

示例外部地址为 `https://example.com`，Google Cloud Console 中配置：

```text
Authorized JavaScript origins:
https://example.com

Authorized redirect URIs:
https://example.com/auth/google/callback
```

生产环境变量：

```env
GOOGLE_CLIENT_ID=360156811535-vui327cl8rb6onbi9i0nnedufcj5v2hv.apps.googleusercontent.com
GOOGLE_REDIRECT_URI=https://example.com/auth/google/callback
SESSION_SECRET=<secret-manager-random-value-at-least-32-characters>
AUTH_COOKIE_SECURE=true
WEB_ORIGIN=https://example.com
```

Redirect URI 必须逐字符匹配，协议、域名、端口、路径以及末尾斜杠都不能不同。环境变量中的 Client ID 必须属于配置该 Redirect URI 的 Web OAuth Client。

反向代理必须允许 `POST /auth/google/callback`，保留 `Host`，并设置 `X-Forwarded-Proto` 和 `X-Forwarded-Host`：

```nginx
location /auth/ {
    proxy_pass http://api:4310;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

应用使用显式 `GOOGLE_REDIRECT_URI` 作为实际外部回调地址。生产必须显式设置 `AUTH_COOKIE_SECURE=true`。

## 路由与安全行为

| 路由                         | 行为                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `GET /login`                 | 跳转到 Web 登录页并保留安全的本地 `next`                           |
| `GET /auth/google`           | 创建签名 state/nonce 事务并返回 GIS 按钮配置                       |
| `POST /auth/google/callback` | 校验双提交 CSRF、state、nonce 和 ID Token，创建 Session 并一次跳转 |
| `GET /auth/me`               | 返回当前用户和服务端角色，未登录返回 401                           |
| `POST /auth/logout`          | 撤销数据库 Session 并清除 Cookie                                   |

Google 回调先比较 Cookie 与表单中的 `g_csrf_token`，再验证签名事务 state、ID Token 签名、issuer、audience、expiration、issued-at、nonce、`email_verified`、email 和 `sub`。`next` 只接受站内相对地址，外部 URL 会回退到 `/admin`。错误不会自动重新发起登录，避免无限重定向。

正式 Session Cookie 为 `HttpOnly`、`SameSite=Lax`、`Path=/`，生产为 `Secure`，有效期 14 天。OAuth 临时 Cookie 为短期、签名、`HttpOnly`、`SameSite=None`、`Secure`，用于接收 Google 的跨站 POST。数据库只保存随机 Session Token 的 SHA-256 哈希。
