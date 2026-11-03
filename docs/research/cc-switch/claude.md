> 归档说明：这是 2026-10-28 对 CC Switch 4.0.21（`6d6b7162f122ac0ce1356a14688c8c4f712db3c8`）的原始源码阅读笔记，含标注为 INFERENCE 的推测，未运行验证。
> 设计建议及部分泛化表述已在[汇总报告](../../SESSION_COLLECTOR_RESEARCH.md)中修正；以后者为准。这里保留阅读证据，不作为已经实现或验收的规格。

All paths are relative to `cc-switch/src-tauri/src/`. `claude.rs` means `session_manager/providers/claude.rs`.

---

# CC Switch Claude session pipeline: findings for the collector

## Summary

- **Root:** `get_claude_config_dir()/projects`. The directory is either the CC Switch setting `claude_config_dir` or `~/.claude`. It **does not read the `CLAUDE_CONFIG_DIR` environment variable.**
- **No decoding of the encoded project folder name.** The real cwd comes from the `cwd` field in the first records, or from the last `type:"relocated"` record (`/cd`).
- **The list scan reads message content** (first 10 lines + last 30 lines + last 64 KiB, or the whole file if under 16 KiB) to build the title and summary. That breaks our rule that non-approved projects have no content read. The collector needs its own metadata-only scan.
- **`load_messages` streams the whole file.** It drops `isSidechain` and `isMeta` records, treats `isCompactSummary` as a system event, and sorts user text into: interrupt / slash command / `!bash` / injected / real prompt.
  - Assistant records that share a `message.id` and are adjacent get merged.
  - Thinking and tool_use become separate blocks.
- **There is no "final answer" concept upstream.** It only assigns turn ids `t{n}` (`assign_turn_ids`). We have to derive the final answer ourselves.
- **Subagents:** files are skipped by filename (`agent-*` or `journal.jsonl`), and sidechain records are skipped by flag.

## Files

| Location                             | What it holds                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `config.rs:91-97`                    | `get_claude_config_dir()` = settings override, else `get_home_dir().join(".claude")`                       |
| `settings.rs:1233-1239`, `1012-1035` | `get_claude_override_dir` (from `claude_config_dir` in app settings); `resolve_override_path` expands `~`  |
| `session_manager/mod.rs:63,123,252`  | Wires `claude::scan_sessions` and `load_messages`; delete root = `<cfg>/projects`                          |
| `claude.rs:38-44`                    | `scan_sessions`: recursively collects `*.jsonl` under projects, runs them through `PARSE_CACHE`            |
| `claude.rs:89-120`                   | `last_relocated_cwd`: reads the last 64 KiB and takes the last `type=="relocated"` → `relocatedCwd`        |
| `claude.rs:124-131`                  | `scan_session_file`: skips agent files, then `read_head_tail_lines(path,10,30)` and relocated lookup       |
| `claude.rs:133-277`                  | `parse_session_lines`: builds id, cwd, created/last-active times, title, summary                           |
| `claude.rs:279-284`                  | `is_agent_session`: name starts with `agent-` or equals `journal.jsonl`                                    |
| `claude.rs:292-310`                  | `collect_jsonl_files`: recursive and unfiltered, so it also enters `<sessionId>/subagents/`                |
| `claude.rs:46-79`                    | `delete_session`: removes the `.jsonl` and the sibling `<stem>/` folder (subagents, tool-results)          |
| `claude.rs:332-350`                  | `load_messages`: line-by-line borrowed deserialization; bad lines skipped; stops at the first read error   |
| `claude.rs:353-380`                  | `Draft` (role, ts, uuid, injected, blocks, meta, `api_id`), `CallSlot`, `TranscriptBuilder`                |
| `claude.rs:394-443`                  | `finish` (drops empty messages, then `assign_turn_ids`) and `push` (record-type dispatch)                  |
| `claude.rs:477-519`                  | `push_system`: `stop_hook_summary`, `compact_boundary`, `local_command`                                    |
| `claude.rs:540-560`                  | `push_compact_summary`                                                                                     |
| `claude.rs:564-647`                  | `push_assistant`: text / thinking / tool_use split; merge by `message.id`                                  |
| `claude.rs:651-797`                  | `push_user`, `push_user_texts`: sorting user text                                                          |
| `claude.rs:799-990`                  | Tool result pairing and backfill (UI only)                                                                 |
| `claude.rs:1317-1358`                | `strip_system_reminders`, `is_injected_text`, `slash_command`, `tag_content`                               |
| `claude.rs:1405-1540`                | `RawRecord`, `RawMessage`, `RawItem`, `ToolUseResult`: the parsed fields                                   |
| `providers/utils.rs:24-91`           | `FileParseCache`: re-parses only when mtime or size changes; read errors are not cached                    |
| `providers/utils.rs:103-139`         | `read_head_tail_lines`: whole file if under 16 KiB, else first N lines + tail of the last 16 KiB           |
| `providers/utils.rs:141-155`         | `parse_timestamp_to_ms`: integer ms or s, or RFC3339                                                       |
| `providers/utils.rs:157-218`         | `extract_text`: used by the scan; turns `tool_use` into `[Tool: x]` and **includes `tool_result` content** |
| `providers/blocks.rs:719-747`        | `starts_turn` / `assign_turn_ids`                                                                          |
| `session_manager/model.rs:433-458`   | `project_content`: Thinking and Step are left out of `content`                                             |

## Architecture

`scan_sessions` → `FileParseCache.scan` → `scan_session_file` → `SessionMeta`.

`load_messages(path)` → `TranscriptBuilder.push` for each record → `Draft`s → `finish()` → `SessionMessage`s with blocks and `turn_id`.

Supporting pieces:

- Shared helpers come from `blocks.rs` and `utils.rs`.
- `ContentRef::Jsonl` (line byte offsets + JSON pointer) and `Sidecar` exist only for loading full text lazily in the UI.

---

## 1. Roots, config dir, project-dir encoding, real cwd

- **Root** = `get_claude_config_dir().join("projects")` (`claude.rs:39`, `mod.rs:252`).
  - `get_claude_config_dir` (`config.rs:91-97`): if the app setting `claude_config_dir` is set, use it after `~` expansion (`settings.rs:1233-1239`, `1012-1035`); otherwise `~/.claude`.
  - **The `CLAUDE_CONFIG_DIR` environment variable is not consulted.** Upstream uses that variable only when launching per-account terminals (`commands/misc.rs:5182-5197`, `services/claude_account/*`).
  - Per-account config dirs live at `<data_dir>/claude-accounts/<id>/config/`. `projects/` there is a **directory link** to the shared default (`services/claude_account/shared.rs:6`), so history stays in one place.
  - [INFERENCE] The collector should scan `~/.claude/projects` plus `$CLAUDE_CONFIG_DIR/projects` if that variable is set, and **deduplicate after resolving symlinks with canonicalize**.
- **Encoded folder name** (e.g. `-Users-saul-PROJECT-foo`): upstream **never decodes it**, and grep finds no encode/decode function. The decoding is lossy anyway because `/`, `.` and `_` all become `-` [INFERENCE about Claude Code's encoding].
- **How the real cwd is recovered** (`claude.rs:156-161`, `240-248`):
  1. The `cwd` of the first record that has one, within the first 10 lines.
  2. Overridden by the **last** `{"type":"relocated","relocatedCwd":...}` record found in the last 64 KiB (`/cd`). Upstream deliberately skips a cheaper tail window because Claude Code's metadata block can sit tens of KB before the end of the file (`claude.rs:85-89`; test at `claude.rs:1953`).
  3. **The `cwd` of later ordinary records is ignored on purpose.** It follows the Bash tool's working directory and drifts into subfolders (`claude.rs:243-245`; test at `claude.rs:1984`).
  - For git-root detection: take that cwd, then walk up to the git root. A drifted Bash cwd must not be used.

## 2. `scan_sessions` (list scan)

- **`session_id`**: the first `sessionId` in the first 10 lines, else the file stem (`claude.rs:150-155`, `250`, `286-290`).
- **`created_at`**: the first parseable `timestamp` in the first lines (`claude.rs:162-164`).
- **`last_active_at`**: the last parseable `timestamp`, scanning the last 30 lines in reverse (`claude.rs:203-205`).
- **Title**: `custom-title` (last `type:"custom-title"` record → `customTitle`, tail only) > first real user message > basename of the cwd. Truncated to 80 characters (`claude.rs:207-216`, `252-261`; `utils.rs:15`).
  - "First real user message": `type=="user"` or `message.role=="user"`, text via `extract_text`, skipping text that starts with `<command-name>` and `is_injected_text` (`claude.rs:168-189`).
  - It does **not** check `isMeta` or skip tool_result here, because `extract_text` includes tool_result content (`utils.rs:184-193`).
- **Summary**: the last non-`isMeta` record with message text that isn't a command or injected, truncated to 160 characters (`claude.rs:218-235`, `263`). This **can be assistant text or tool output**.
- **No `type:"summary"` handling.** grep finds no `"summary"` record type in claude.rs.
- **How much is read**:
  - Under 16 KiB: the whole file.
  - Otherwise: the first 10 lines (unbounded line length) plus the last 16 KiB, keeping the last 30 lines (`utils.rs:103-139`), **plus** a separate last-64 KiB read for `relocated` (`claude.rs:93-103`).
  - Each line is fully parsed into `serde_json::Value`.
  - Cached by `(mtime, len)` (`utils.rs:42-91`).
- **For the collector (privacy):** reuse the approach (head lines + relocated tail) but deserialize into a struct containing **only** `sessionId`, `cwd`, `timestamp`, `type`, `relocatedCwd`. serde then skips everything else without materializing it.
  - Skip title, summary and `custom-title` entirely for non-approved projects.
  - [INFERENCE] Bytes still pass through the read buffer, which is unavoidable; nothing is retained.
  - To get `last_active_at` without content, file mtime is enough.

## 3. `load_messages`

### Dispatch (`claude.rs:410-443`)

- **Dropped up front:** `isSidechain==true` or `isMeta==true` (`claude.rs:411-413`). `isMeta` covers the `<local-command-caveat>` user record (test at `claude.rs:2467`).
- **`type` handling:**
  - `system` → `push_system`
  - `pr-link` → PR event
  - `user`, `assistant`, or missing type → message handling
  - **Everything else is skipped:** `attachment`, `file-history-snapshot`, `queue-operation`, `mode`, `custom-title`, `summary`, `relocated`, `last-prompt`, ... (`claude.rs:441`). Records without `message` are dropped (`claude.rs:422-424`).
- **Role** = `message.role`, else `type`.
- **`isCompactSummary==true`** → `push_compact_summary`. This is **not a user prompt**: it becomes a system Compaction event, merged into a preceding lone `compact_boundary` event (`claude.rs:540-560`).

### `system` subtypes (`claude.rs:477-519`)

| Subtype                                                                | Handling                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stop_hook_summary`                                                    | Hook event, only when `hookErrors` is non-empty                                                                                                                      |
| `compact_boundary`                                                     | Compaction event (`content` or "Conversation compacted")                                                                                                             |
| `local_command`                                                        | Newer form of a local slash command. `content` (`<command-name>…`) goes through `push_user_texts` and becomes a **user** SlashCommand event, which **starts a turn** |
| Others (`turn_duration`, `api_error`, `informational`, `away_summary`) | Ignored                                                                                                                                                              |

### User records (`claude.rs:651-797`)

- **Content forms:** a string, or an item array split into `tool_result` → ToolResult blocks, `text` → texts, `image` (base64) → Image blocks.
- **Only the first non-empty text decides the category** (`claude.rs:735`):
  1. Starts with `[Request interrupted by user` → **Aborted** event. This covers both `"[Request interrupted by user]"` and `"... for tool use]"`. Does not start a turn.
  2. Starts with `<command-` and has a non-empty `<command-name>` → **SlashCommand** event `"/name args"`. **Starts a turn** (`blocks.rs:727`).
  3. Starts with `<bash-input>` → user `!cmd`, becomes a ToolCall + ToolResult with `by_user` set (`claude.rs:1212-1261`). Does not start a turn.
  4. `is_injected_text` (`claude.rs:1336-1341`): contains `<local-command-caveat>`, or starts with `<local-command-stdout>`, `<local-command-stderr>` or `<task-notification>`. If the record also carries tool_results, the text is thrown away; otherwise the record is marked `injected=true` (kept, but **does not start a turn**).
  5. Otherwise, a **real prompt**: each text has `<system-reminder>…</system-reminder>` removed (an unclosed tag strips to the end; `claude.rs:1317-1333`).
     - If all texts are empty after stripping and there are no results or images, the record is treated as injected.
- **Role**: if every block is a ToolResult the role becomes `"tool"`, else `"user"` (`claude.rs:784-788`). A tool_result record therefore never starts a turn. A mixed tool_result + real-text record stays `user` and does start one (test at `claude.rs:1830`).
- **Turn rule** (`blocks.rs:719-733`): role `user`, not injected, with non-empty Text, Image, or SlashCommand. Content before the first prompt is `t0`.

### Assistant records (`claude.rs:564-647`)

- **Item handling:**
  - `text` (non-empty after trim) → Text
  - `thinking` / `redacted_thinking` → Thinking. Redacted when the type is `redacted_thinking`, or the text is empty but a signature exists. Empty thinking with no signature is dropped (`claude.rs:996-1019`).
  - `tool_use` / `server_tool_use` → ToolCall
  - Anything else is ignored
- A plain string `content` becomes Text.
- **Streaming chunks**: Claude Code writes one JSONL record per content block. If the **previous draft** has the same role and the same `message.id` (`api_id`), blocks are appended and meta is merged, with later non-empty fields winning, e.g. `usage` and `stop_reason` (`claude.rs:617-646`, `1291-1312`; test at `claude.rs:2191`).
  - Only adjacent records merge. The `uuid` of the first chunk is kept as the message id.
- **Meta** (`claude.rs:1263-1288`): `model` (the `<synthetic>` placeholder model name is excluded), token usage, and `stop_reason` taken from `message.stop_reason`. The fixture uses `"tool_use"` (`claude.rs:2779`).
- `project_content` leaves Thinking out of `content` (`model.rs:433-458`). Note that **`content` includes `[Tool: X] title` lines**, so the collector must use the blocks, not `content`.

### Final answer (not implemented upstream; proposal) [INFERENCE]

- Within a turn, the final answer = the Text blocks of the **last assistant message (after the `message.id` merge) that contains Text, with no ToolCall after it in that turn**. Equivalently, the Text blocks after the turn's last tool_use. Optionally also check `stop_reason == "end_turn"`; I haven't verified that value appears in this code.
- Text before or between tool calls is intermediate commentary and should be dropped.
- **Incomplete turn** if any of these hold:
  - The turn ends in an Aborted event (`[Request interrupted by user…`).
  - The last assistant activity is a ToolCall with no text after it.
  - The last stop reason is `tool_use`.
  - The turn has no assistant Text at all.
  - Tool results with `toolUseResult.interrupted==true` are another signal (`claude.rs:870-881`).
- **Open design decision:** slash-command turns (`/compact`, `/model`) should probably be excluded or kept as non-prompts. Upstream counts them as turn starters.
- Turns after compaction keep counting normally, and the compact summary is not a prompt.

## 4. Subagents and sidechains

- **File level:** `collect_jsonl_files` recurses into everything under projects (`claude.rs:292-310`), so both `<sessionId>/subagents/agent-*.jsonl` and older top-level `agent-*.jsonl` files are collected. `is_agent_session` then rejects them by name: starts with `agent-`, or equals `journal.jsonl` (workflow log; `claude.rs:279-284`; tests at `claude.rs:2107`, `2120`).
  - [INFERENCE] Any other future `.jsonl` inside `<sessionId>/` would be treated as a session. The collector should only take `projects/<encoded>/<uuid>.jsonl` at depth 2.
- **Record level:** `isSidechain==true` records inside the main file are dropped (`claude.rs:411`).
- **Sidecar folder `<stem>/`**: contains `subagents/` and `tool-results/` (`claude.rs:1765-1775`). It is used only for delete and for `persistedOutputPath` references in the UI (`claude.rs:982-988`). **The collector never needs to read it.**
- Inside the main transcript, Agent/Task tool calls and their results are ordinary tool steps and get dropped under our rules.

## 5. Edge cases, and UI-only parts we can drop

**Edge cases to keep:**

- Malformed lines are skipped. A read error stops parsing but keeps what was parsed (`claude.rs:337-347`).
- Lenient types: a field with the wrong type becomes `None` rather than failing the line (`claude.rs:1400-1404`, `LStr`/`Lenient`).
- The file is being appended while Claude runs. [INFERENCE] Ignore a trailing partial line and use the mtime/size cache the same way `FileParseCache` does (`utils.rs:42-91`, which does not cache read errors).
- A `<system-reminder>` inside a real prompt must be stripped before upload (test at `claude.rs:2419`).
- `<task-notification>` (background task finished) is injected, not a prompt.
- `<bash-input>` (`!cmd`) is not a prompt.
- Images in prompts: upstream keeps them as refs. [INFERENCE] Upload a placeholder or skip.
- Timestamps may be integer ms or s, or RFC3339 (`utils.rs:141-155`).
- `delete_session` validates that the `sessionId` in the file matches (`claude.rs:46-60`). Not needed.

**UI-only, drop all of it:** tool title and kind normalization (`claude.rs:1054-1146`, `blocks.rs`), diff estimation and backfill (`claude.rs:1148-1189`, `893-980`), exit code and duration, image `ContentRef`s, preview truncation (`large_text_block`, `preview_chars`), `pr-link` events, hook events, thinking duration, token meta, the `content` projection, `FileParseCache`'s title and summary, `custom-title`, `resume_command`, and `delete_session`.

**Minimal port for the collector:** `RawRecord`/`RawMessage`/`RawItem` (without the image, source and `toolUseResult` fields), the dispatch in `push`, the text sorting in `push_user_texts` (`claude.rs:735-772`), the helpers `strip_system_reminders`, `is_injected_text`, `slash_command`, `tag_content`, the `message.id` merge, `starts_turn`, plus the new final-answer and incomplete logic.

---
