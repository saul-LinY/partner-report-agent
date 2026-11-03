# CC Switch 读取链路裁剪与复测

日期：2026-10-29。结果：独立源码已落地，原仓库的无关代码已删除，裁剪后的读取链路通过独立构建及复测。

## 实际修改位置

原克隆目录 `/Users/saul/PROJECT/ccswitch-upstream/cc-switch` 现在是独立的 `cc-session-reader` Rust 库与 CLI。

- 分支：`codex/session-reader-extraction`。
- 保留原 Git 历史、MIT 许可、上游来源及文件哈希；未推送或覆盖上游远程。
- 删除前创建了完整归档（包括原 Git 数据），位于 `.local/collector-extraction/cc-switch-full-6d6b716.tar.gz`；其 SHA-256 记录在同目录 `backup.json`，删除前已核验。
- 未修改安装在 Applications 中的 CC Switch，也未改写 AI 工具的会话源文件和源数据库。

删除的原应用内容包括 React/Tauri 界面、供应商和账号管理、代理、终端启动／恢复、会话删除与改写、全局会话正文扫描、云同步、用量服务、原数据库迁移和发布工作流。

剩余内容是 13 个 provider 的读取模块、消息模型、必要的格式辅助函数、zstd／JSONL／SQLite 读取、项目门禁和提问／正式回复提取，以及独立回归工具。没有 Tauri、Node 或原 CC Switch 源码目录的构建依赖。

代码及文档从原来的约 63 MB、1,782 个文件缩减到约 430 KB、37 个文件。这里不包含保留的 Git 历史、另存的备份、真实数据和构建产物；精确字节数以 [复测摘要](research/cc-switch/extraction-validation-summary.json) 为准。

## 如何验证没有删坏

1. 将已获准读取的 159 份真实文件冻结到私有目录，避免边测边写入的会话造成假差异。
2. 用裁剪前的原始解析二进制读取冻结文件，保存基线结果。
3. 在暂存源码中裁剪并独立编译，比较其输出。
4. 确认一致后，实际删除原克隆目录的无关文件并放入独立源码。
5. 在原 `src-tauri` 和前端源码已经不存在的情况下，用全新的 target 目录离线、按 Cargo.lock 构建和测试。
6. 用这个新编译的二进制再次读取相同冻结文件，逐项比较提问、回复、状态、来源身份及统计，仅排除运行耗时。

最终 161 条源处理结果（159 份成功解析文件、1 份跨项目拦截、1 个拒绝哨兵）与裁剪前全部一致。不是仅仅比较总数，也没有拿旧二进制冒充新源码构建结果。

## 测试结果

- 6 项 Rust 集成测试通过：未授权先拒绝、无定位证据不读取、SQLite 项目以实际元数据为准、SQLite 子会话排除、未验证来源明确拒绝，以及输出文件符号链接保护。
- 原来的 29 项回归检查全部通过：六种主要格式、提问与正式回复提取、诊断／步骤过滤、未完成后补回复、分支、长文、队列和幂等接收仿真。
- 真实样本：Codex 153 份、Claude Code 5 份、OMP 1 份，合计 1,276 轮。其中 1,125 轮有明确正式回复，151 轮按未完成处理。
- 已接受的 1,125 条正式回复均通过原始记录独立文本核对，没有发现文字差异。
- 比 2026-10-28 的报告多 2 轮，是今天冻结输入前会话增加所致；本轮裁剪前后使用完全相同的快照，没有靠忽略差异来通过。

原先的临时验证代码采用外部绝对路径引用上游；本次已替换为库内相对模块，当前源码不包含 `/Users/saul` 或指向原 `src-tauri` 的编译路径。依赖目录解析改为当前用户 home 和显式可配置目录。

## 当前交付边界

可以单独构建、测试和调用的读取核心已经完成。入口和命令示例见独立仓库的 `README.md`，库入口为 `cc_session_reader::extract_manifest`，命令行为 `cc-session-reader manifest.json results.json`。

它目前接收可信宿主提供的获准会话清单，自己不连接正式审批服务，也不负责全机自动发现和上传。不能把一个本地清单中的 `allowed` 当作最终服务端鉴权。

13 个 provider 都保留并参与编译；完整提取入口验证的是 Codex、Claude、Pi、OMP、OpenCode、Hermes，其中真实数据仍只覆盖 Codex、Claude、OMP。其余 7 个 provider 的审批前定位适配器没有验收，公开入口明确拒绝这些来源，不会退回全量扫描绕过门禁。

本次没有实现桌面 App、上传接口、正式审批同步、自启动或更新器。接收端和离线队列仍是隔离 SQLite 仿真。真实正文与快照保留在 Git 忽略、仅当前用户可访问的 `.local/collector-extraction/` 中，没有写进报告或版本库。

## 证据与后续使用

- 独立源码：`/Users/saul/PROJECT/ccswitch-upstream/cc-switch`。
- 干净构建二进制：`.local/collector-extraction/clean-target/debug/cc-session-reader`。
- 冻结样本与裁剪前基线：`.local/collector-extraction/evidence/`。
- 最终复测结果与提取正文：`.local/collector-extraction/final-regression/`。
- 对比结论和尺寸：`.local/collector-extraction/extraction-result.json`。

独立仓库的 `scripts/regression.py` 可生成可移植测试数据并运行，无需本机真实会话；加 `--real-manifest` 时才显式读取获准的真实清单。原上游依赖完整应用的测试模块已去掉，由本次独立回归和集成测试替代，不宣称保留了原应用的完整测试覆盖。
