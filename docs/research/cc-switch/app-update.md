# CC Switch 应用更新链路与采集 App 的选项

分析日期：2026-10-28。固定源码：CC Switch 4.0.21，提交 `6d6b7162f122ac0ce1356a14688c8c4f712db3c8`。

本次只读源码并调整交互草图，没有运行 CC Switch、实际检查网络更新、下载或安装软件。

## 已核实的上游行为

### 自动检查

[`src/contexts/UpdateContext.tsx:119`](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src/contexts/UpdateContext.tsx#L119) 在应用启动后延迟 1 秒调用 checkUpdate。

checkUpdate 用 ref 防止并发检查，调用 checkForUpdate 时设置 30 秒超时。发现更新后保存版本、更新说明、发布日期等状态；可将用户关闭提醒的版本记在 localStorage 中。该启动 effect 没有设置重复轮询定时器，也没有在检查成功后自动调用安装。

[`src/lib/updater.ts:24`](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src/lib/updater.ts#L24) 动态加载 `@tauri-apps/plugin-updater`，取得当前版本并调用 check，返回“有更新”或“已是最新”的结果。

在检查的设置类型、更新 context 和设置界面中，没有发现独立的“自动更新”偏好开关。不要将它对 Claude Code 等外部工具的自动升级选项误认为 CC Switch 自身的更新设置。

### 用户触发安装

[`src/components/settings/AboutSection.tsx:134`](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src/components/settings/AboutSection.tsx#L134) 的按钮行为：

1. 没有已知更新时，点击执行检查，并提示结果。
2. 已知有更新时，点击调用 installUpdateAndRestart。
3. 安装中显示更新状态并禁用按钮；失败提示错误，另提供下载页回退。
4. portable 分支打开下载入口，而不是走普通应用的原地安装流程。

`src/components/shell/Sidebar.tsx` 根据 hasUpdate 在设置／关于入口显示提示点。因此它的普通路径是“启动自动检查 → 显示可用更新 → 用户点击更新”，不能称为静默自动安装。

### 下载、安装与 macOS 重启

[`src-tauri/src/commands/settings.rs:279`](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/commands/settings.rs#L279) 的 install_update_and_restart 负责完整流程：

1. 创建 updater 并再次检查可用版本；没有更新时返回 false。
2. 下载更新包，向前端发送 update-download-progress 事件。
3. macOS/Linux 调用 install；安装成功后保存窗口状态、清理退出资源，再调用后端 restart_process。
4. 安装、清理和重启在同一后端流程中完成，不依赖旧 WebView 在应用 bundle 被替换后继续执行重启命令。

上游这里清理的是 CC Switch 自己的运行资源；它没有我们的采集游标、上传确认和队列逻辑，不能直接认为同样的退出清理已经适合采集 App。

### 更新来源与发布

[`src-tauri/tauri.conf.json:64`](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/tauri.conf.json#L64) 配置了 updater 公钥与两个清单入口：

- `https://dl.ccswitch.io/latest.json`
- GitHub Releases 中的 latest.json 下载地址。

`src-tauri/src/lib.rs:582` 注册 Tauri updater 插件；初始化失败会记录日志，不中断主应用启动。

`.github/workflows/release.yml` 为 macOS 生成 updater 使用的 `.app.tar.gz` 和签名，生成包含平台下载地址与签名的 latest.json；首次安装的 DMG 和 updater 使用的更新包是不同产物。`sync-r2.yml` 将清单及更新包镜像到下载站。

## 对我们的设计建议

用户要求在“应用偏好”增加自动更新选项。这比 CC Switch 已实现的“启动自动检查”多了一项无人操作时的安装策略，需明确区分来源事实与本地设计。

| 设置           | 建议行为                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------- |
| 自动更新开启   | 在可以连接公司更新源时检查、下载并验证更新包；待当前采集、上传任务结束并保存进度后安装和重启 |
| 自动更新关闭   | 不自动下载或安装；通过手动检查入口，由用户决定更新                                           |
| 检查更新按钮   | 始终保留手动入口；显示检查结果，实际产品还应呈现版本、下载进度及失败原因                     |
| 自动更新默认值 | 草图示例为开启；最终默认策略尚未单独确认                                                     |

实现时可复用 Tauri updater 的技术路线及“后端统一安装／退出／重启”的结构。公司系统提供自己的清单、不同 Mac 架构的更新包和签名，使用本应用的验签配置；不指向 CC Switch 的更新源，也不复用它的公钥作为本应用发布身份。

检查间隔与上传频率分开设计。无法连接更新源、下载或验证失败时继续运行当前版本，不将这些失败显示为“已是最新”。

采集 App 进入安装前，应停止接受新的采集／上传任务，等待当前任务到达可恢复边界并持久保存游标、未确认队列和凭据状态；不应等待所有离线待传数据都上传成功才允许更新。升级后继续按项目审批及投递确认状态恢复，不重置绑定和已批准项目。

队列恢复、更新包签名、macOS 应用签名／公证及重启后的目录权限仍需在实际应用中验证。本次仅完成源码调研、需求记录和草图开关，并未实现或验证真实自动更新。
