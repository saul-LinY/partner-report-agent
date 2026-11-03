> 归档说明：这是 2026-10-28 对 CC Switch 4.0.21（`6d6b7162f122ac0ce1356a14688c8c4f712db3c8`）的原始源码阅读笔记，含标注为 INFERENCE 的推测，未运行验证。
> 设计建议及部分泛化表述已在[汇总报告](../../SESSION_COLLECTOR_RESEARCH.md)中修正；以后者为准。这里保留阅读证据，不作为已经实现或验收的规格。

**Summary.**

- **Turn grouping** is done twice: in Rust and again in TypeScript. Rust (`cache::build_turns`) builds only a table of contents and a `has_final_reply` flag. The real split into question, steps and final answer is in the frontend (`src/components/sessions/reader/turns.ts`, `locateFinal` / `buildTurn`).
- **"Final answer"** has no explicit concept, apart from Codex's `phase` field (`commentary` or `final_answer`), which is stored in `meta.stop_reason`. Everywhere else it is a heuristic: the assistant text blocks that come after the turn's last `tool_call`.
- **Privacy:** the metadata pass is not content-free. Titles and summaries come from the first and last user or assistant message text. Even Pi's "metadata" pass reads the whole tree (`pi.rs:380-417`).
- **Coupling** to the rest of the app is mostly config-dir getters plus `codex_rollout_file`, `codex_state_db`, `kimi_session` and `config::write_json_file`. The external crates are serde, serde_json, rusqlite, chrono, base64, url, zstd, regex, log and dirs.
- **License** is MIT (Copyright (c) 2025 Jason Young).

---

# CC Switch session_manager core analysis (v4.0.21 @ 6d6b716)

## 1. Data model

### SessionMeta (`src-tauri/src/session_manager/mod.rs:20-39`)

Fields: `provider_id, session_id, title?, summary?, project_dir?, created_at?, last_active_at?, source_path?, resume_command?` (all `i64` times are in ms). It is Serialize-only and camelCase. `project_dir` is the session cwd: it is the field to use for project detection. It is **not** a git root; the collector has to resolve git roots itself.

### SessionMessage (`model.rs:10-91`)

- **`role`:** `user | assistant | tool | system`.
- **`content`:** plain-text projection built from blocks by `project_content` (`model.rs:438-470`). Text is kept as is, a ToolCall becomes `[Tool: name] title`, a ToolResult becomes its preview, an Image becomes `[Image: mime size]`, and an Event becomes its text. **Thinking and Step are excluded.** When blocks are non-empty, `content` is not serialized (hand-written Serialize, `model.rs:38-71`).
- **`ts`, `id`:** `id` is the source record id.
- **`turn_id`:** Codex uses its native `turn_id`; every other provider gets `t{n}` from `assign_turn_ids`.
- **`injected: bool`:** AGENTS.md, environment_context, system-reminder, the developer role, and so on.
- **`blocks: Vec<SessionBlock>`** and **`meta: Option<MessageMeta>`.** MessageMeta (`model.rs:93-114`) holds model, tokens, cost, `duration_ms` and `stop_reason`.

### SessionBlock (`model.rs:116-232`), tagged by `type` in snake_case

- **`Text { text, full? }`:** `full` is set when the text exceeds 8K chars and is only a preview (`blocks.rs` `INLINE_TEXT_MAX_CHARS`). **Caution:** an over-long text block that you want to upload must be fetched in full through its `full` ContentRef.
- **`Thinking { text, summary?, redacted, duration_ms?, full? }`.**
- **`ToolCall { id, raw_name, kind: ToolKind, title, detail?, server?, input_preview, input_total_len, input_full?, diff?, by_user }`.**
- **`ToolResult { call_id, status: ToolStatus, preview, total_len, line_count, truncated, full?, exit_code?, duration_ms?, images, saved_path? }`.**
- **`Image { image: ImageRef }`.**
- **`Event { kind: EventKind, text?, url?, full? }`.**
- **`Step { phase: Start|Finish, tokens?, cost_usd?, reason? }`:** OpenCode only.

### Enums (`model.rs:250-297`)

- **ToolKind:** Shell, Read, Search, Edit, Write, Web, Mcp, Agent, Ask, Todo, Other.
- **ToolStatus:** Success, Error, Interrupted, Pending, Unknown.
- **EventKind:**
  - Aborted (user interrupt or `turn_aborted`)
  - Compaction
  - ModelChange
  - ThinkingLevel
  - Hook
  - PrLink
  - SlashCommand
  - Info
  - Error
  - SubAgent
  - Other

### ContentRef (`model.rs:330-356`)

Variants: `Jsonl{offset,len,pointer}`, `Sqlite{table,id,column,pointer}`, `File{rel_path,pointer}`, `Sidecar{rel_path}`. These are references used to fetch full content on demand.

### TurnIndex (`model.rs:406-421`)

Fields: `turn_id, first_message_index, last_message_index, question_preview (≤80 chars), ts?, step_count, error_count, has_final_reply, aborted`.

### How a turn is built

1. **Assigning turn ids** (`providers/blocks.rs:722-746`): parsers call `assign_turn_ids`. `starts_turn` returns true for a user message that is not injected and contains non-empty Text, an Image, or a SlashCommand event. Each such message increments `t{n}`; anything before the first question goes to `t0`. Messages that already have a `turn_id` (Codex) keep it.
2. **Rust table of contents** (`cache.rs:310-407`, `build_turns`): consecutive messages with the same key are grouped. `has_final_reply` comes from `reply_pending`: non-empty assistant Text sets it to true and any later ToolCall resets it to false. Old-format messages without blocks fall back to checking for a `[Tool:` prefix. Turns that contain only injected messages are dropped. **Only the index is produced, not the reply text.** It is sent to the frontend as `TranscriptChunk::Header` (`model.rs:384-404`).
3. **Frontend structure** (`src/components/sessions/reader/turns.ts`):
   - `groupMessages` (around line 233) groups by `turnId`.
   - `locateFinal` (lines 274-296) defines the final answer: in the last assistant message of the turn that has text, take the Text blocks that come **after the turn's last tool_call**. If the last tool_call is after those texts, the turn has no final answer.
   - `buildTurn` (lines 298-530) sorts every block:
     - Text after the final position goes to `final`.
     - Other assistant Text becomes a `note` step (intermediate commentary).
     - Thinking becomes a `thinking` step.
     - Tool calls and results become `tool` steps.
     - Events become `event` steps, or `leadingEvents` / `trailingEvents`.
   - The output type is `SessionTurn { question?, steps, final?: TurnFinal{messageIndex,text,images,ts,model,cost}, trailingEvents, aborted, … }` (lines 108-146).
   - **Conclusion:** the question / steps / final split exists only in TS. Our collector has to port `locateFinal` and `buildTurn` to Rust.
4. **Explicit final-answer concept:**
   - **Codex only.** `AgentMessage.phase` (`commentary` or `final_answer`) is written to `meta.stop_reason` (`codex.rs:597-598, 916-922, 1325-1328, 1805-1815`).
   - `codex.rs:1770-1780` uses `final_by_turn`, the last assistant message with text in each turn, to attach model and token usage to it.
   - **Other providers:** there is no explicit marker, so the "last text after the last tool_call" heuristic applies.

   [INFERENCE] For Codex, prefer `stop_reason=="final_answer"` and fall back to the heuristic.

5. **Unfinished turns:** a turn has no final answer when `has_final_reply == false`, or when `aborted` is set (an `EventKind::Aborted` event). Codex's `task_complete` only flushes buffered blocks (`codex.rs:751`); it is not exposed as a "turn completed" signal.

   [INFERENCE] A turn where the agent is still running looks the same as a turn whose last step is a tool. The collector needs its own rule, for example "the next turn has started or the session has been idle for N minutes".

## 2. The `scan_sessions` flow

- **Dispatch** (`mod.rs:61-109`): nine providers are scanned in parallel threads (codex, claude, opencode, openclaw, gemini, hermes, grokbuild, pi, omp), then four serially (mcode, kimi, dsh, agy). Results are merged and sorted by `last_active_at` or `created_at`, newest first. There are no parameters, so it cannot filter by project.
- **Per-file caching:** `providers/utils.rs:16-99`, `FileParseCache::scan`, caches `SessionMeta` per file keyed on `(mtime, len)`. Read errors are not cached. Claude and Codex keep a static `PARSE_CACHE` (`claude.rs:36`, `codex.rs:97`).
- **Claude** (`claude.rs:38-44, 102-283`):
  - `read_head_tail_lines(path, 10, 30)` (`utils.rs:103-140`) reads the first 10 lines and the last 30 lines from the final ~16KB. Files under 16KB are **read in full**.
  - It also reads the last 64KB looking for a `relocated` record (`last_relocated_cwd`, `claude.rs:62-95`).
  - From the head: `sessionId`, `cwd`, `timestamp`, and **the first real user message (title)**.
  - From the tail: `timestamp`, `custom-title`, and **the last user or assistant message text (summary, truncated to 160 chars)**.
  - Title priority: custom-title, then first user message, then the cwd basename.
  - It skips `agent-*` and `journal.jsonl` files (`claude.rs:285-290`).
- **Codex** (`codex.rs:1905-2010+`): reads the first 10 and last 30 lines. A compressed `.jsonl.zst` file only has its head decompressed and uses the file mtime as `last_active`. `session_meta.payload` provides `id`, `cwd` and `timestamp`, and the first user `response_item` becomes the title. Subagent sources return `None`. Thread titles from `session_index` and the state DB are applied afterwards.
- **Pi / OMP** (`pi.rs:380-417`): `read_tree` reads the **entire** file (≤128MB) to get `first_user_message` and `last_message`.
- **Gemini** (`gemini.rs:514-`): `read_session_document` parses the whole file.
- **OpenCode, Hermes, mcode:** SQLite queries that take the first or last message (see the Hermes tests at `hermes.rs:1456-1530`).
- **Privacy conclusion:** every provider's `scan_sessions` reads message text to build the title and summary. A file under 16KB is read in full by Claude's path. **We need to write a metadata-only pass.**

  [INFERENCE] For Claude: read head lines until the first record with `cwd` and `sessionId`, ignore `message`, and use mtime as `last_active`. Even so, the JSON line has to be parsed, so the process does load that content into memory. Codex is similar, but only needs the `session_meta` line, which is usually line 1.

## 3. `content.rs`

- **`validate_source`** (`content.rs:80-114`):
  - mcode: `mcode:<id>` must point at the canonicalized `mcode::database_path()`.
  - opencode or hermes with a `sqlite:` prefix: `validate_sqlite_source` (lines 168-180) requires the canonicalized DB to equal the provider's own DB path.
  - Everything else: `provider_roots()` (`mod.rs:249-268`), plus a Codex `.jsonl` ↔ `.jsonl.zst` sibling swap (`codex_source_or_sibling`, lines 118-128), then `resolve_under_roots` (lines 132-166). That function canonicalizes, resolving symlinks, and checks `starts_with(root)`. It errors with "outside provider roots" or "Session root not found".
- **`SourceLocation`** (lines 51-57): `Path{path,root}` (both canonicalized; may be a directory, as with old OpenCode) or `Sqlite{db,session_id}`. `ValidatedSource::load_path()` (lines 60-66) hands the canonicalized path to the parser.
- **`resolve_content_ref`** (lines 213-276) fetches full text by ContentRef:
  - Jsonl: `read_jsonl_line` (lines 304-361) verifies line boundaries and returns `STALE` if they do not match. Grokbuild maps to `chat_history.jsonl`, dsh `.zstd` files are decompressed whole, and Codex `.zst` files are decompressed from the start to the offset.
  - Sqlite: a table and column whitelist (`sqlite_allowed`, lines 450-460), parameter-bound `id` and `session_id`, read-only connection.
  - File and Sidecar: `safe_join` (lines 506-530) allows only Normal or CurDir components and re-checks the canonicalized result.
- **Limits:**
  - `MAX_TEXT_BYTES = 32MB` (line 26)
  - `MAX_IMAGE_BYTES = 20MB` (line 28)
  - `MAX_PAGE_CHARS = 512K chars` (line 30, documented as "≤ 2MB UTF-8"). **This is the "2MB" limit:** it is the pagination size for a single `get_session_block_content` call (`paginate`, lines 196-210). It is not a file limit.
  - `read_limited` (lines 533-551) checks the size from metadata, then enforces it again while reading.
  - Provider-specific: `pi::MAX_SESSION_BYTES = 128MB`, `MAX_TREE_ENTRIES = 500k` (`pi.rs:19-21`); `dsh MAX_BYTES = 128MB` (`dsh.rs:15`).
- **Streaming and chunking:** `cache.rs:283-307`, `chunk_ranges`, splits by ≤256KB or ≤150 messages. `commands/session_manager.rs:36-77` (`stream_session_messages`) sends Header (turns), then Messages, then Done over a Tauri `Channel`. **Parsing is not streamed:** the whole session is parsed into a `Vec<SessionMessage>` first, and only transport is chunked.
- **Images** (lines 556-680): only allowed under the session root, the sidecar directory, Codex `visualizations`, or the session's `project_dir`. `project_dir_for` runs a full `scan_sessions` to find it. SVG is rejected.

## 4. `cache.rs` fingerprints and whether they suit incremental collection

- **`Fingerprint { modified: Option<SystemTime>, len }`** (`cache.rs:52-75`). `merge` takes the newer mtime and adds the lengths.
- **`fingerprint`** (lines 82-110):
  - Plain file: its own mtime and len.
  - Directory: the directory itself plus first-level children, with +1 per child.
  - SQLite: the db file plus the `-wal` file.
- **`source_fingerprint`** (lines 118-134):
  - grokbuild: also merges `chat_history.jsonl` from the same directory, because `summary.json` is only rewritten when a turn ends.
  - OpenCode directory sources: also merge the `storage/part/{messageID}/` directories and their files (`merge_opencode_parts`, lines 138-170).
- **`TranscriptCache`:** an LRU of 8 entries and 96MB, keyed by `(provider_id, raw sourcePath)` (lines 172-280).
- **For incremental collection:** this works as a "has it changed" check that triggers a re-parse, but it is not an increment. Every change re-parses the whole session.

  [INFERENCE] For JSONL sources, we can store a per-session byte offset and the set of uploaded turn ids. `LineSpans` (`utils.rs:~260-300`, which records the byte offset of each line) is useful for that. SQLite sources can only be compared by fingerprint, then re-parsed and de-duplicated by turn id or message id.

## 5. Coupling: `crate::` dependencies outside session_manager

| Dependency                                                                                                   | Used in                                                         |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `crate::config::get_claude_config_dir`                                                                       | `mod.rs:252`, `claude.rs:14,39`                                 |
| `crate::config::get_home_dir`                                                                                | `pi.rs:159`                                                     |
| `crate::config::write_json_file`                                                                             | `openclaw.rs:7-8` (delete path)                                 |
| `crate::config::sqlite_unsupported_in_temp_dir`                                                              | tests only                                                      |
| `crate::codex_config::{get_codex_config_dir, read_codex_config_text}`                                        | `codex.rs:14`, `content.rs:634`                                 |
| `crate::codex_rollout_file::{sibling, is_compressed, open_reader}`                                           | `content.rs:124,338,388`, `codex.rs:15` (`.jsonl.zst` handling) |
| `crate::codex_state_db::{codex_state_db_is_lockable, codex_state_db_paths, CODEX_STATE_DB_FILENAME}`         | `codex.rs:16,2199` (thread titles)                              |
| `crate::opencode_config::get_opencode_db_path`                                                               | `content.rs:97`, `opencode.rs:36`                               |
| `crate::hermes_config::get_hermes_dir`                                                                       | `mod.rs:257`, `content.rs:102`, `hermes.rs:8`                   |
| `crate::openclaw_config::get_openclaw_dir`                                                                   | `mod.rs:254`, `openclaw.rs:6`                                   |
| `crate::gemini_config::get_gemini_dir`                                                                       | `mod.rs:255`, `gemini.rs:20`                                    |
| `crate::grok_config::get_grok_config_dir`                                                                    | `grokbuild.rs:37`                                               |
| `crate::agy_config::{agy_dir, key_profiles_root, resume_command}`                                            | `agy.rs:29,32,140,197`                                          |
| `crate::dsh_config::data_dir`                                                                                | `dsh.rs:18`                                                     |
| `crate::kimi_config::data_dir`, `crate::kimi_session::RequestIndex`                                          | `kimi.rs:3,13,17`                                               |
| `crate::mcode_config::data_dir`                                                                              | `mcode.rs:10,18`                                                |
| `crate::omp_config::{get_omp_data_dir, get_omp_agent_dir, get_omp_native_agent_dir, get_omp_active_profile}` | `omp.rs:33,58-62`                                               |
| `crate::pi_config::{read_pi_native_defaults, get_pi_agent_dir}`                                              | `pi.rs:170,183`                                                 |

- **Tauri** is used only in `commands/session_manager.rs`: `tauri::command`, `ipc::Channel` and `Response`, `async_runtime::spawn_blocking`, `tauri_plugin_dialog`, `tauri_plugin_opener::reveal_item_in_dir`, and `crate::store::AppState` for the terminal. The `session_manager` module itself has no tauri imports. `terminal/mod.rs` (resume in a terminal) can be dropped.
- **External crates used by session_manager** (versions from `src-tauri/Cargo.toml`):
  - `serde 1` (derive)
  - `serde_json 1` (features=["preserve_order"])
  - `rusqlite 0.31` (bundled; used by content, codex, hermes, opencode, mcode, agy)
  - `chrono 0.4` (`utils.rs:8`)
  - `base64 0.22` (`content.rs:16`)
  - `url 2.5` (`content.rs:600,695`, `agy.rs:178`)
  - `zstd 0.13` (`dsh.rs:44-50`, via `codex_rollout_file`)
  - `regex 1.10` (`codex.rs:9`, `codex_items.rs:15`)
  - `log 0.4`
  - `dirs 5.0` (`opencode.rs:25`)
  - `tempfile 3` (tests)
  - There is **no walkdir**: directories are walked recursively with `std::fs::read_dir`.
- **Windows-only:** `hermes_wsl.rs` and `hermes_wsl_reader.py` are `#[cfg(windows)]` and can be removed on macOS.
- **Other code using session_manager**, to account for when cutting it out: `services/session_usage_*.rs` (pi, gemini, grokbuild, agy, mcode), `services/codex_session_compression.rs`, `commands/pi.rs`, `agy_config.rs` and `agy_smoke_tests.rs`.

## 6. Tests and fixtures

- **Shared contract fixtures:** `tests/fixtures/sessions/{claude,codex,gemini,opencode,pi,generic}.messages.json` plus `agy.jsonl`. `model.rs:600-650` (`shared_fixtures_round_trip`) checks that they round-trip through the Rust types and that messages with blocks carry no `content`.
- **Inline `#[cfg(test)]` tests:**
  - `model.rs`: projection and serialization.
  - `cache.rs:434-748`: chunk_ranges, `build_turns_groups_by_question_and_counts_steps` (around 683), `build_turns_prefers_native_turn_ids` (around 722), and cache/fingerprint tests.
  - `blocks.rs`: normalize_tool, `assign_turn_ids` (around 1100-1128).
  - `utils.rs`: FileParseCache (around 370-430).
  - `mod.rs`: deletion root checks (lines 323-415).
  - `content.rs`: tests from around line 700.
  - Per-provider tests: `claude.rs` from around 1850, `codex.rs` 2197-3700, `hermes.rs` 1048-1600, `opencode.rs` 1052-1560, plus pi, gemini, grokbuild and mcode.
- **Caveats:** the tests use `tempfile` and env locks. SQLite tests are skipped when `crate::config::sqlite_unsupported_in_temp_dir()` is true.

## 7. License

- `LICENSE` is MIT, "Copyright (c) 2025 Jason Young". `Cargo.toml:5-7` gives `authors=["Jason Young"]`, `license="MIT"`, repository `https://github.com/farion1231/cc-switch`.
- Any copied or modified code must keep that copyright notice and the license text (for example in `THIRD_PARTY_LICENSES` or a NOTICE). The source files themselves have no per-file license headers; the module doc comments are in Chinese.

**Files to look at first:** `session_manager/mod.rs:20-160`, `model.rs:1-470`, `cache.rs:1-430`, `content.rs:1-700`, `providers/utils.rs:1-300`, `providers/blocks.rs:1-120,700-746`, `providers/claude.rs:30-300`, `providers/codex.rs:580-1000,1760-2010`, `commands/session_manager.rs:1-120`, and `src/components/sessions/reader/turns.ts:100-560`.
