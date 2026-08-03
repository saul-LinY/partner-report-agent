# 远程服务器配置

## 用户侧地址

`connect --server <URL>` 是最高优先级配置；未传时读取 `PARTNER_REPORT_SERVER_URL`。连接成功后，最终地址写入本地 `config.json`，之后 Runner 不依赖环境变量。

允许的示例：

```text
https://report-api.example.com
https://report-api.example.com:8443
https://example.com/partner-api
http://127.0.0.1:4310
```

非本机 HTTP 默认被拒绝，避免 Bearer Token 和结构化工作数据在明文链路上传输。只有明确隔离的测试网络可以在 CLI 中额外传 `--allow-insecure-http`。

## 数据中台要求

服务器 URL 是 API 根地址，Plugin 会在其后追加 `/v1/...` 路径。若地址包含部署前缀，例如 `https://example.com/partner-api`，反向代理需要将 `/partner-api/v1/...` 转发到 Partner Report API。

数据中台至少需要提供：

- 设备授权开始、轮询和 Token 刷新接口
- 当前 Plugin 策略与项目范围接口
- Session Fact Batch 幂等接收接口
- Plugin 心跳接口
- Agent Job 查询、租约、完成和失败接口

设备授权响应中的 `verificationUri` 应指向 Partner 实际可访问的 HTTPS Web 页面。API 反向代理必须保留 `Authorization`、`Idempotency-Key`、`X-Job-Lease` 和 `X-Request-Id` 请求头。

生产环境建议：

- API 和确认页面都使用有效的 HTTPS 证书。
- 仅公开 Web/API 入口，不公开 PostgreSQL。
- 限制单请求 Body 大小并保留幂等键。
- 日志对 Authorization、Cookie、设备码和刷新 Token 做脱敏。
- 更换域名或服务器后要求 Partner 重新绑定，不迁移旧 Token 到新域名。
