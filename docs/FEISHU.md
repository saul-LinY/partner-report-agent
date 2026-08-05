# 飞书审核接入

数据中台通过企业自建应用机器人，把项目工作卡片和个人报告私发给对应 Partner。API 进程负责飞书长连接、回调 Inbox 和 Outbox 投递；模型生成仍由 Worker 执行。

## 飞书侧配置

应用需要发布可用版本，并开启机器人能力。应用身份至少需要以下权限：

- `im:message:send_as_bot`
- `cardkit:card:read`
- `cardkit:card:write`

事件与回调使用长连接模式，并订阅 `card.action.trigger`。当前实现不依赖通讯录读取权限：首次绑定卡按 Partner 工作邮箱私发，用户确认后记录回调中的 `open_id`，后续审核只向该 `open_id` 投递。

## 服务配置

在部署环境配置：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REVIEW_DELIVERY_ENABLED=true
```

两个变量必须同时存在。只配置其中一个时 API 会拒绝启动，避免出现看似启用但无法接收回调的状态。Secret 只保存在环境变量中，不写入数据库、日志或卡片。

仅验证身份绑定链路时，可以临时设置 `FEISHU_REVIEW_DELIVERY_ENABLED=false`。此模式不会消费审核 Outbox、补发项目卡片或处理报告审核按钮；生产环境应保持默认的 `true`。

应用数据库迁移：

```bash
npm run db:migrate
```

API 正常启动后会自动建立飞书长连接，并消费尚未投递的审核事件：

```bash
npm run start -w @partner-report/api
```

`GET /health` 的 `feishu.phase` 会区分 `disabled`、`start_requested`、`callback_verified` 和 `stopped`。SDK 的 `start()` 返回只代表已请求启动；只有收到真实卡片回调后才会进入 `callback_verified`，同时记录 `lastCallbackAt`。SDK 错误会进入 API 日志，但 Secret、Token、Authorization 和请求正文会被脱敏。

## 首次绑定

可以按 Partner 工作邮箱发送一次身份确认卡：

```bash
npm run feishu:bind -w @partner-report/api -- --email user@example.com
```

邮箱必须在 `partners` 中唯一匹配一个 `active` 记录。有效期内重复执行命令不会重复发送同一张绑定卡；未确认卡片满 13 天后会作废并续发，以避开飞书卡片 14 天交互期限。Partner 邮箱变更时旧卡会立即失效并发送新卡。用户点击确认后，系统以 `deliveryId + messageId + appId` 校验回调，并将该 Partner 与操作人的 `open_id` 绑定。

## 投递与幂等

- 审核内容在身份确认前不会直接发送，只发送绑定卡。
- 每个回调先写入 `feishu_inbox_events`，用飞书 `event_id` 去重。
- 每条消息写入 `feishu_deliveries`；发送时用 delivery ID 作为飞书幂等 UUID。
- 同一审核对象只维护一条投递记录，`domain_version` 只在飞书发送或更新成功后单调推进；在途的新事件不会被提前确认。
- 项目卡片决策和报告提交使用数据库版本号做并发控制，飞书与 Web 共用同一组领域命令。
- 个人报告在卡片容量允许时展示全文；超长报告只展示明确标注的节选、移除提交按钮，并通过 `WEB_ORIGIN` 提供受登录保护的完整报告入口。
- 用户通过 Web 操作后，领域 Outbox 会更新同一张飞书卡片。

生产环境只运行一个长连接客户端即可。飞书长连接采用集群消费语义；多实例同时连接时，同一回调只会随机投递给其中一个实例。
