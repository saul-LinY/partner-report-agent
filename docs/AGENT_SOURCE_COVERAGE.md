# Agent 会话来源覆盖

更新：2026-10-29。按会话存储源覆盖，不将 CLI、IDE 扩展、桌面 UI 简单看成同一条路径。已有工具图标不代表所有存储格式已验收。

范围按用户最新要求保留 8 种来源，顺序沿用截图。DeepSeek Harness、OpenClaw、MiniMax Code、Gemini CLI、Kimi Code 已从 App 枚举、图标及内置 Reader 移除；原始 CC Switch 调研记录保留作历史参考。

## 刷新行为

- 启动时发现项目。
- 每轮扫描完成后约 60 秒再次检查；会话读取有耗时时并非严格的整分钟定时器。
- 切回 App、电脑唤醒时立即复查；右上角也可手动刷新。
- 日／周上传频率不控制本机会话发现周期。

## 当前来源矩阵

| Agent        | 已检查的来源                                                                       | 读取及限制                                                                       |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Codex        | 默认 sessions、archived_sessions，CODEX_HOME，自定义路径；CLI／IDE／App 共用时去重 | 合并默认／环境／CC Switch 路径，全部版本及外置 state DB；无索引与压缩文件由独立定位命令补扫；原生标题按实际来源读取                                            |
| Claude Code  | 默认 projects、CLAUDE_CONFIG_DIR、自定义路径；共用历史不重复计数                   | 增加 CC Switch 多账号路径；读取标题前检查迁移目录；Code 本地会话可读，独立 Claude Desktop／云聊天存储不在已验证范围                    |
| Pi           | 默认 sessions 和自定义路径                                                         | 解析 PI_CODING_AGENT_DIR、绝对 session override 与 native JSON5 sessionDir；相对 sessionDir 明确提示需启动上下文，不猜路径           |
| OMP          | 默认 sessions、profiles 下的 agent/sessions、可用的 XDG 数据位置和自定义路径       | 补自定义 PI_CONFIG_DIR、命名 profile 及 XDG profile；按来源父目录分别读取，避免跨目录批次拒绝                |
| OpenCode     | 默认数据目录与自定义目录中的 opencode.db                                           | 补 XDG_DATA_HOME／OPENCODE_DB、V1／V2 与旧 JSON 元数据发现、授权 gate、正文读取及分片指纹                                |
| Hermes       | 默认 state.db 和自定义目录                                                         | HERMES_HOME／CC Switch 自定义目录、SQLite 和带头部的 JSONL；正式 finish_reason 已接通并与本机两条原文核对；无项目元数据的旧记录保留定位提示                       |
| Antigravity  | 默认 CLI brain、桌面 brain、自定义 brain、CC Switch profile brain                  | 本机桌面真实会话已验证；以独立 workspace 元数据授权，排除 GENERIC MODEL 过程内容 |
| Grok Build   | 默认／自定义 sessions、默认 archived_sessions 的 summary 元数据 | 已验证真实提问、工具结果过滤、generated_title、events 轮次结束；不把仍在执行的回复标为正式输出 |

自定义目录是补充来源，不应该使默认目录完全失效。相同路径先 canonicalize 去重，同一工具原生会话身份聚合续接文件；不同工具的相同模型名称不能合并为一个来源。

## 本机 Antigravity 漏采修复

原 App 只检查 `~/.gemini/antigravity-cli/brain` 是否存在，没有真正的 Antigravity 发现适配。本机实际使用的是 `~/.gemini/antigravity/brain`，因此此前刷新也不会出现。

修复后从同目录独立的 `conversation_summaries.db` 读取 conversation_id、workspace_uris、父子关系及更新时间，不为未允许项目读取 title／preview。已允许后再取真实标题并读取 transcript。

读取组件再次检查所有 workspace 都在允许根之内、会话身份与目录匹配、是否为子会话。`GENERIC` 即便标为 `MODEL` 也属于过程记录，不作为回复；正式输出取已结束轮次的最后一条非空、DONE 的 PLANNER_RESPONSE。最后一轮还需会话空闲且非运行状态，仍在执行时只保留提问。

指纹纳入 transcript、元数据库及 WAL；这样即使正文文件未再次变化，运行状态由执行中变为空闲时也会重新判断，避免永远停在未完成状态。

本机验证会话有 44 条步骤记录：2 条 USER_INPUT、22 条 PLANNER_RESPONSE、20 条 GENERIC。最终输出仅 2 条提问和对应 2 条正式回复，过程内容不进入输出。源数据及验证结果保存在私有 `.local/weekly-report/agy-check`，不纳入版本库。

后续仍需按真实工具／版本补齐矩阵中的缺口，不能以推测目录或最后一条 MODEL 文本替代未验证的支持。

## 2026-10-29 首次逐项复查（以下为本轮修复前快照）

下表按最新保留的 8 种来源展示；此前原始复查报告的 12 种中，已移除四种均无样本，不影响总计。复用 App 实际打包的读取程序及同一套项目发现逻辑，只读取 App 状态中已允许的 4 个项目；每种工具抽查最新最多 3 个会话。未确认项目仅统计定位元数据，不提取正文。不创建对话、不改变项目授权、不联网。

| Agent | 发现会话（项目范围） | 已允许会话 | 抽查 / 有提问内容 | 正式回复条数 | 结论 |
| --- | ---: | ---: | --- | ---: | --- |
| Codex | 469 | 444 | 3 / 3 | 31 | 已验证当前本机格式 |
| Claude Code | 43 | 42 | 3 / 2 | 3 | 已验证当前本机格式 |
| OpenCode | 15 | 11 | 3 / 3 | 6 | 已验证当前本机格式 |
| Pi | 1 | 1 | 1 / 1 | 1 | 已验证当前本机格式 |
| Hermes | 1 | 1 | 1 / 1 | 0 | 部分可读，正式回复待完善 |
| Oh My Pi | 10 | 10 | 3 / 3 | 13 | 已验证当前本机格式 |
| Grok Build | 3 | 3 | 3 / 3 | 12 | 已验证当前本机格式 |
| Antigravity | 2 | 2 | 2 / 2 | 3 | 已验证当前本机格式 |

共抽查 19 个会话，18 个返回提问内容，1 个 Claude 样本为空；不将空内容计入成功读取。返回 96 轮提问、69 条正式回复，无解析报错。其余没有正式回复的轮次不能仅凭此表断言都在进行中：可能为中断、无终止证据或 Hermes 尚未适配。7 种工具已有真实正式回复证据，Hermes 只部分可用，仍不能宣布“全部 8 种已完整支持”。

Grok 本轮 3 个样本、12 轮提问和 12 条正式回复，已不再出现此前“读取受限”的未适配错误。Antigravity 本轮 2 个桌面会话返回 3 轮提问和 3 条正式回复。CLI 与桌面共用相同会话存储时可复用已验证路径；独立新格式仍需单独适配。

当前 19 项 XCTest 和 6 项 Rust 集成测试通过。复查脚本为 `apps/macos/scripts/audit-agents.swift`，详细结果在私有 `.local/weekly-report/agent-audit-20261029/summary.json`，不含聊天正文。会话数随本机继续使用变化，且此处排除了临时／无项目会话，不能与 CC Switch 全部会话总数直接对比。

## 本轮修复后的全量复查

目录解析、发现、来源上下文与正式回复已按新的链路验收。47 项 App 测试、36 项 Rust 测试通过；本机 4 个已允许项目共 518 个会话，509 个返回内容，4 个为空，5 个跨项目记录被阻止，读取 4,181 轮提问与 3,583 条正式回复。8 种保留工具均读到真实正式回复。Hermes 两条回复与原文一致，另外 6 份无可靠项目元数据的历史文件保留提示。

首次打开扫描实际 Agent／会话目录并记住路径，后续复查，不再只显示预设路径。逐项补齐范围、可复现验证及不能自动定位的边界见 [CC Switch 链路复查](CC_SWITCH_EXTRACTION_AUDIT.md)。
