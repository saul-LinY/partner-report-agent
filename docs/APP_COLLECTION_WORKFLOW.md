# App 绑定、权限与完整会话采集

## 用户流程

首次启动依次为名字和绑定码绑定、自动发现本机项目文件夹并确认权限、最近一个月会话正文扫描、主界面。系统地址由 `apps/macos/project.yml` 的 `WEEKLY_REPORT_SERVICE_URL` 固定，当前为本地 `http://127.0.0.1:4314`，App 不提供地址输入框；上线时修改构建配置并重新构建。邮箱不参与 App 绑定；中台既有成员邮箱字段仍保留用于 Web 账号。

绑定码和中台成员名字必须同时匹配。绑定复用该成员已有权限实例，但 App 使用独立设备凭据，不覆盖仍在使用的旧插件 Token。没有历史实例的新成员创建独立采集权限容器，初始项目列表为空。撤销绑定码或停用成员后 App 的请求会失效，客户端回到绑定页并停止读取。

历史权限不保存本机路径。权限页自动扫描最近一个月的会话元数据，发现项目根目录，用规范路径生成的匿名 scopeKey 精确匹配历史权限，不按项目名匹配或要求逐个选择文件夹。新发现的项目只登记项目名、标识和候选会话数量，默认待确认；未知标识不能继承同名项目的授权。本机未发现的历史项目显示“本机未发现，暂不扫描”，不阻塞继续。刷新会重新发现目录、拉取权限，并显示加载、更新时间和错误状态。允许／拒绝通过中台版本校验提交；与其他设备冲突时刷新，不重放旧决定。审批页不加载会话标题、提问或回复，点击“继续”后仍需点击“开始扫描会话”才导入获准正文。

首次导入范围是点击扫描时往前一个自然月。后续上传范围是中台当前开放采集周期的开始到本次打包时间。按来源最后修改时间归属周期，发送该会话全部可解析的提问和正式回复，不截取“贡献”或新增消息；只有提问的会话也会发送。归档、子任务及跨项目读取限制继续由既有发现器和 Rust Reader 执行。定位元数据扫描不等于未授权正文导入。

## 上传协议

- `POST /v1/collector/bindings/claim`：绑定码、名字、设备与版本，返回独立 Token、设备标识和已有项目权限。Token 仅存 macOS Keychain。
- `GET /v1/collector/project-scope`：当前权限及当前采集周期。
- `POST /v1/collector/project-scope/candidates`：只登记项目名与匿名 scopeKey，不发送文件夹路径或会话正文。
- `POST /v1/collector/project-scope/decisions`：携带 baseVersion 的允许／拒绝修改。
- `GET /v1/collector/personal-data[?month=YYYY-MM]`：只读返回绑定成员自己的「成员详情页」数据，与管理端同一套计算（`packages/contracts/src/member-overview.ts`）：四项汇总、项目卡片（状态、简介、阶段、卡点）、近 90 天逐分钟会话活跃度、所选月份的项目日历与每日进展。成员只取自绑定 Token，不接受成员参数（多余参数返回 400），也不返回其他成员的数据；`month` 不能是未来月份。
- `POST /v1/collector/uploads`：固定批次 UUID、周期时间窗、权限版本、会话数、每个分包的 SHA-256 清单。
- `POST /v1/collector/uploads/:id/parts`：序号、SHA-256、完整会话数组 JSON 的 Base64。常规目标 2 MiB；单个会话超过 16 MiB 时明确报错，不静默截断。分包解码上限 16 MiB，路由请求上限 24 MiB；反向代理也需要相应放行。
- `POST /v1/collector/uploads/:id/complete`：核验所有分包、总数、全批次会话 ID 唯一性与最新授权，返回整批回执。缺包或权限变化时不能完成。
- `POST /v1/collector/logs`：只接收严格白名单事件，客户端时间与服务器到达时间独立保存，事件 UUID 去重。
- `GET /v1/admin/user-logs`：仅本租户／团队管理员可见，每位拥有有效采集设备的成员一条，含设备、App 版本、在线状态（最近日志到达不超过 5 分钟）、最近上传、窗口内错误数和严重度。
- `GET /v1/admin/user-logs/:partnerId?date=&level=&stage=&deviceId=`：只返回该成员的设备状态（`client_state`）、按时间倒序的日志事件（最多 1000 条，默认最近 24 小时，`date` 按团队时区自然日）和上传批次及处理阶段。成员之间不混排。

权限行与上传行采用一致的事务加锁顺序。清单、分包和完成请求都支持重复提交；不同内容不能复用同一批次。收到整批回执前不更新已上传状态。当前采集周期没有配置时明确报错，不生成虚构周期。

完整会话保存在 `collector_upload_parts.sessions`；上传前 App 会隐藏其中的密钥、令牌、口令、邮箱、手机号、IP 地址、网址、本机路径和成员自己标记的内容，服务端入库前对自动规则再处理一遍，规则见 [隐私信息隐藏](PRIVACY_REDACTION.md)；只有关联 `collector_uploads.status='completed'` 的批次才可作为完整输入读取。完成整包核验的同一事务会为会话内容版本登记 `EXTRACT_COLLECTOR_SESSION` 任务，Worker 提取带来源和日期的贡献后写入 `session_facts`，再按项目生成待审核卡片。旧的贡献上传接口继续兼容。接收成功、分析完成和审核完成分别记录，不能互相替代。运行、重试和验收方法见 [完整处理流水线](APP_PIPELINE_OPERATIONS.md)。另有一条独立的项目简介流程：Worker 按项目时间顺序读取预处理后保留的会话，滚动生成面向非技术读者的简介，并写入项目说明，见 [项目简介](PROJECT_PROFILES.md)。

## 日志与隐私

日志事件包含事件 ID、发生时间、阶段（`app`、`binding`、`permissions`、`discovery`、`scan`、`upload`、`heartbeat`、`notification`、`review`）、级别、固定事件码、批次 ID、会话计数，以及可选的严格白名单 `details`：`appVersion`、`osVersion`、`durationMs`、`httpStatus`、`apiErrorCode`（大写错误码）、`errorDomain`、`errorCode`、`errorKind`（network/auth/policy/server/storage/size/read/unknown）、`message`（仅 App 自身错误类型的固定中文说明，最多 300 字）、`projectCount`、`sessionCount`、`failedSessionCount`、`partIndex`、`partCount`、`bytes`、`windowStart`、`windowEnd`、`periodKey`、`policyVersion`、`agent`、`retryAttempt`。未知字段整批拒绝。服务器写入前对 `message` 和其余文本字段执行凭据与用户目录脱敏，`message` 存入 `collector_logs.message`，其余存入 `details`。

新增事件码：`APP_LAUNCHED`、`DISCOVERY_STARTED/COMPLETED/FAILED`、`POLICY_SYNC_FAILED`、`SESSION_READ_FAILED`（只含失败计数）、`UPLOAD_QUEUED`（进入待传队列）、`UPLOAD_PART_SENT/FAILED`、`NOTIFICATION_RECEIPT_FAILED`、`REVIEW_ACTION_FAILED`。上传故障区分网络、认证、权限／前置条件、服务端、存储与超大包，不上传原始异常字符串、文件路径或会话正文。服务器使用真实到达时间判断在线状态，超过五分钟无日志标记需关注，超过三十分钟标记严重；扫描或上传错误标记异常；超过十五分钟未推进的分包批次标记需关注。

本机 `WeeklyReportLocal/state.json` 保存绑定元数据、权限、已导入会话与待发送日志；`collector-outbox.json` 保存可重试的完整包。目录 0700，文件 0600。绑定码不落盘，Token 仅入 Keychain。正式地址要求 HTTPS，开发只允许 localhost／127.0.0.1／::1 使用 HTTP。服务不接受跨源重定向。

定时上传在 App 运行期间按本机时区每天／每周执行，离线待传包即使关闭自动上传也会重试。完全退出后不会执行定时任务。撤销授权会清除对应本机缓存并作废旧待传包，不删除用户此前合法上传的中台历史包。

标题刷新按分块字节查找换行，不重复扫描累积的大行，也不逐行搬移整个缓冲区。Claude 标题只在来源指纹、会话文件或标题索引变化后重新读取；缓存仅在整份文件通过项目和会话身份校验且读取期间文件未变化后建立。撤销项目授权时清除缓存。没有自定义标题但校验成功的文件也可跳过重复读取，读取失败和不完整文件不能缓存为成功。

2026-11-03 本机 Release 对比：同一份来源快照含 162 个来源，优化前后均返回 95 个原生标题。单次标题读取的用户态 CPU 时间从 6.67 秒降至 0.84 秒；通过 AppStore 连续刷新时，优化后首次为 0.83 秒，未变化的后续刷新为 0.09 秒。这是标题刷新阶段的测量，不代表整次上传的耗时。131 项原生测试通过，覆盖跨块大行、无末尾换行、不完整文件、迁移越界和标题索引更新。

## 系统通知

### 后台常驻与登录恢复

首次绑定后，通过 `SMAppService.agent` 注册用户级 LaunchAgent，嵌入在 App 的 `Contents/Library/LaunchAgents`，守护程序位于 `Contents/Helpers`。登录后系统自动启动守护程序；采集进程不存在时每 3 秒检查并以 `--background-service` 无窗口模式启动 App。关闭窗口、普通退出、进程异常退出后均可继续或恢复采集。守护程序不读取会话或钥匙串，仅负责启动；采集、上传和通知始终沿用原 App 身份。首次项目授权和首次扫描仍需用户确认，中断过的已确认扫描可在后台恢复。

后台模式隐藏主窗口和 Dock 图标，保留菜单栏入口；打开 App 或点击通知可恢复界面。系统设置中的「后台运行」显示实际服务注册状态，提供开关及系统后台设置入口。用户显式「停止后台运行并退出」时写入停止标记并注销服务，不自动重新开启。用户在系统设置中禁止后台服务时，同样不能继续运行。旧版主 App 登录项仅在新服务注册后移除。

守护程序、Core 框架或 LaunchAgent 配置改变后，先等待旧服务注销完成，再注册新版本；未获系统批准的服务不会被强行重新开启。首次注册的临时失败会在后续同步周期重试，明确停止标记始终优先。

采集进程通过系统文件锁独占本地状态和上传队列；重复启动只唤起现有窗口，不创建第二个写入者。首次绑定凭据继续保存在同一钥匙串条目中，重启无需重新绑定；钥匙串临时锁定按可重试错误处理，不清空绑定。自动更新安装前暂停守护拉起最多 10 分钟，新进程启动时清除暂停；安装失败后暂停自动到期。用户停用标记优先于更新暂停到期。

2026-11-03 本机验证：140 项原生测试通过。正式安装包通过深度签名验证，ServiceManagement 状态为 enabled，launchd Job 为 running。正常按 Cmd+Q 退出后，原进程结束，由守护程序自动启动 `--background-service` 新进程，后台无激活、无 Dock 模式继续刷新发现记录；恢复前后绑定数据的规范化摘要一致。强制结束守护进程后 launchd 自动恢复，更新暂停及重新安装后的服务重新注册均验证通过。本次没有实际注销账户或重启电脑，登录启动依赖已注册的 RunAtLoad LaunchAgent。

API 每 5 秒将项目权限、工作卡片和审核完成事件从 Outbox 幂等写入 `app_notifications`。团队报告生成、归档事件仅标记已处理，不生成通知；旧队列中的报告通知也停止投递，并从未投递异常巡检中排除，历史记录和迟到回执保持有效。通知按租户、团队及成员隔离。App 完成绑定后，前台激活及每 10 秒独立拉取一次，停留在项目权限页或扫描页时也可投递，避免采集任务阻塞提醒，使用 macOS `UNUserNotificationCenter` 投递横幅与提示音，固定提醒文案不包含原始会话。点击通知进入对应页面。

首次授权发现和正常运行中的每次发现，都会将尚未登记的本机项目以元数据登记到中台，保持待审批状态，并拉取「新项目采集审批」通知。同一项目按目录摘要去重，重复扫描不会再次登记或反复提醒；登记失败后在后续扫描重试，重启后也会继续补登记。未经批准不读取会话正文。已有项目里新增会话不产生项目审批通知。App 运行期间约每分钟扫描一次；新建项目在出现可识别的会话元数据后才能被发现。

- `GET /v1/collector/notifications` 仅拉取待投递通知，不能改变投递状态。
- `POST /v1/collector/notifications/delivered` 接收当前成员的通知 UUID 回执，重复提交安全。
- `POST /v1/admin/partners/:id/notifications/test` 由管理员排队测试通知；入口为团队管理的成员设备详情。
- `GET /v1/admin/partners/:id/notifications/:notificationId` 查询当前成员的测试通知状态；网页每 2 秒更新，区分 App 离线、尚未授权、权限关闭、排队及系统已接受。查询不修改投递状态。

App 仅在系统接受通知后记录本地回执，再向中台确认；失败回执跨重启重试，持续失败记录 `NOTIFICATION_RECEIPT_FAILED`。系统权限关闭或 App 离线时不会标记投递，超过 15 分钟由异常巡检告警。回执不表示用户已阅读，也不保证系统一定展示横幅。App 上报 `notification` 阶段的固定权限日志 `NOTIFICATIONS_ALLOWED`、`NOTIFICATIONS_DENIED`、`NOTIFICATIONS_NOT_CONFIGURED`，权限变化时更新，避免上传任意系统数据。App 设置可请求通知权限或打开系统通知设置，并显示是否开启横幅。工作卡片访问和审核同样使用绑定设备身份，不再要求额外网页登录。

工作卡片采用同一列表：上方为待审核，下方为已处理，保留周期筛选。通过或忽略后移入已处理分组，仍可查看详情。项目审批的会话来源图标靠右排列并向左扩展，固定预留发现时间与操作列，超过 4 个来源在左侧显示剩余数量。

旧消息 SDK、回调、卡片、配置和绑定/投递表全部删除，不保留其他消息通道。历史迁移文件保持不可变，删除通过新迁移执行。

## 部署与验证

先在目标数据库执行 `npm run db:migrate`，应用 `0039` 采集表和 `0040` App 通知及旧消息表删除迁移，再部署 API 与 Web、重新构建 App。反向代理上传上限至少 24 MiB，使用 HTTPS。中台已使用的绑定码也可用于 App 迁移；撤销绑定码会同时阻止 App 后续请求。

`npm run typecheck` 检查所有 TypeScript 工作区；`RUN_DB_TESTS=1 DATABASE_URL=... npx vitest run apps/api/src/routes/collector.integration.test.ts apps/api/src/collector-contracts.test.ts apps/api/src/routes/inspection.integration.test.ts` 使用隔离数据库验证真实绑定、历史权限、完整会话持久化、去重、拒绝项目、缺包、权限冲突、用户日志按成员隔离、日志细节脱敏及异常巡检。原生 `CollectorTests` 验证入口顺序、日志离线恢复、日志细节编码、无回复会话、完整包及重启重试。`npm run test:monitoring -w @partner-report/web` 验证用户日志、系统日志、异常巡检及桌面／手机布局。

旧 `state.json` 的邮箱配置不构成有效联网身份，升级后需要重新绑定。现有本地审批也不会直接升级为中台授权。演示与 UI 截图模式不调用真实采集服务。
