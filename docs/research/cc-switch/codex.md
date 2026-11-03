> 归档说明：这是 2026-10-28 对 CC Switch 4.0.21（`6d6b7162f122ac0ce1356a14688c8c4f712db3c8`）的原始源码阅读笔记，含标注为 INFERENCE 的推测，未运行验证。
> 设计建议及部分泛化表述已在[汇总报告](../../SESSION_COLLECTOR_RESEARCH.md)中修正；以后者为准。这里保留阅读证据，不作为已经实现或验收的规格。

# Report: CC Switch Codex session pipeline

## Summary

- **Where sessions come from:** Rollout JSONL files under `<codex_dir>/sessions` and `<codex_dir>/archived_sessions`, read recursively. Both `*.jsonl` and `*.jsonl.zst` (zstd-compressed) files count.
- **Where `codex_dir` comes from:** CC Switch's own setting `codex_config_dir`, otherwise `~/.codex`. CC Switch does **not** read the `CODEX_HOME` env var for session reading.
- **SQLite and the index file are only used for titles.** The listing never reads cwd or ids from the state DB.
- **Listing (`scan_sessions`) only reads the first 10 lines and last 30 lines.** For files of 16 KB or more, the tail comes from the last 16 KB.
- **The listing reads content it doesn't need for project detection.** `scan_sessions` reads the first user message (for the title) and the last message text (for the summary) from every file. For our privacy rule (non-approved projects: cwd/id/timestamps only), that part must be removed.
- **Loading messages (`load_messages`) is a single-pass state machine over the whole file.**
  - Injected user text is recognised by prefix or by being fully wrapped in one tag.
  - An assistant message's `phase` (`final_answer` / `commentary`) goes into `meta.stop_reason`.
  - Aborted turns produce an `EventKind::Aborted` system message.
- **Skipping subagents:** only `session_meta.payload.source` being an object with a `subagent` key. No check on `originator`, exec, or the other source kinds.

## Files

- `src-tauri/src/session_manager/providers/codex.rs:58-95`: session roots, the scan entry point, and applying thread titles after the scan.
- `codex.rs:99-232`: title loading from `session_index.jsonl` and `state_5.sqlite` (UI only).
- `codex.rs:236-246`: `SNIFF_BYTES` and `INJECTED_USER_PREFIXES`.
- `codex.rs:248-266`: `load_messages`.
- `codex.rs:270-447`: the payload structs (only the fields it uses are deserialized, borrowed rather than copied).
- `codex.rs:470-488`: `sniff_types`, which reads the line type from the first 512 bytes.
- `codex.rs:587-612`: `RolloutParser` state.
- `codex.rs:615-789`: dispatch for each line type (`process_line`, `response_item`, `event_msg`).
- `codex.rs:791-863`: turns, model changes, abort, compaction.
- `codex.rs:902-1015`: `on_message` / `on_user_message` (separating real prompts from injected text).
- `codex.rs:1017-1076`: reasoning and `agent_message` (sub-agent) handling.
- `codex.rs:1323-1378`: `on_item`, which handles `item_completed` and collects AgentMessage phases.
- `codex.rs:1760-1820`: `finish`, which attaches model, tokens and phase.
- `codex.rs:1849-1869`: `is_wrapped_in_tag`, `is_image_wrapper`.
- `codex.rs:1911-2095`: listing metadata (head/tail read, `parse_session_lines`, `is_subagent_source`).
- `codex.rs:2097-2174`: title candidate, VS Code IDE-context prompt extraction, session id from filename.
- `codex.rs:2176-2194`: `collect_jsonl_files`, recursive.
- `codex.rs:2794-3047`: test fixture rollout. This is the best reference for the real line shapes.
- `session_manager/providers/codex_items.rs:60-170`: `Str` / `Contents` / `ContentItem` and `joined_text`.
- `codex_items.rs:213-264`: `RawItem` (the `item_completed.item` fields, including `phase`).
- `codex_items.rs:322-357`: `status_from_str` and `into_record`.
- `session_manager/providers/utils.rs:24-90`: `FileParseCache`, keyed by mtime and length.
- `utils.rs:101-138`: `read_head_tail_lines`.
- `src-tauri/src/codex_rollout_file.rs`: whole file (~140 lines of logic). The `.jsonl` / `.jsonl.zst` duality, `open_reader`, `dedupe_siblings`.
- `src-tauri/src/codex_state_db.rs:19-90`: `state_5.sqlite` paths (config dir, plus `sqlite_home` in config.toml or `CODEX_SQLITE_HOME`), and the WSL lockability check.
- `src-tauri/src/codex_config.rs:270-276`: `get_codex_config_dir` (settings override, otherwise `~/.codex`).
- `codex_config.rs:891`: `read_codex_config_text`.
- `src-tauri/src/settings.rs:1241-1247`: `get_codex_override_dir`.
- `src-tauri/src/codex_history_migration.rs`: rewrites `session_meta.payload.model_provider` in rollouts and `threads.model_provider` in the DB. Session _reading_ does not depend on it.
- `src-tauri/src/services/session_usage_codex.rs:679-709`, `1121-1126`, `1346-1390`: fork/subagent/paginated-continuation logic in the usage importer. Session_manager doesn't use it, but it is the reference for edge cases.

## Architecture

- `session_manager::scan_sessions` (`mod.rs:61`) spawns `codex::scan_sessions` on its own thread. That function:
  1. Gets the roots and collects files recursively.
  2. Runs `codex_rollout_file::dedupe_siblings`.
  3. Runs `PARSE_CACHE.scan(files, scan_session_file)`, which parses only files whose mtime or length changed.
  4. Overlays titles from the index/DB.
- `load_messages(provider_id, path)` (`mod.rs:121`) calls `codex::load_messages`, which works like this:
  1. `open_reader` (transparent zstd).
  2. `LineSpans` yields bytes plus a byte span for each line.
  3. `RolloutParser.process_line`, then `finish()`.
  4. The result is a `Vec<SessionMessage{role, ts, id, turn_id, injected, blocks, meta, content}>`.

---

## Report

### 1. Session roots

| Item                          | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                    | Ref                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Base dir                      | `get_codex_config_dir()`: CC Switch's `settings.codex_config_dir` override, otherwise `~/.codex`                                                                                                                                                                                                                                                                                                                             | `codex_config.rs:270-276`, `settings.rs:1241-1247`  |
| Roots                         | `<dir>/sessions` and `<dir>/archived_sessions`                                                                                                                                                                                                                                                                                                                                                                               | `codex.rs:63-69`                                    |
| Recursion                     | Every subdirectory (`YYYY/MM/DD/`); accepts `*.jsonl` or `*.jsonl.zst` by extension only                                                                                                                                                                                                                                                                                                                                     | `codex.rs:2176-2194`, `codex_rollout_file.rs:27-37` |
| `CODEX_HOME` env              | **Not used** when resolving the session dir. It only appears in installer and app-server code (`commands/misc.rs:798`, `provider/codex_client_catalog.rs:248`). Our collector should resolve `$CODEX_HOME` itself, with `~/.codex` as the fallback. [INFERENCE: Codex itself honours CODEX_HOME]                                                                                                                             | grep `CODEX_HOME`                                   |
| State DB                      | `<dir>/state_5.sqlite`, plus `<sqlite_home>/state_5.sqlite` (from the `sqlite_home` key in config.toml, otherwise the `CODEX_SQLITE_HOME` env var). The filename is versioned in a constant                                                                                                                                                                                                                                  | `codex_state_db.rs:19-38`                           |
| Separate history per provider | There is **none on the reading side**: all files are listed regardless of `model_provider`. `codex_history_migration.rs` only _rewrites_ `session_meta.payload.model_provider` and `threads.model_provider` so that Codex's own resume picker shows sessions across providers (`codex_history_migration.rs:1196-1220`, `1313-1317`). Our collector can ignore it; it should just read `model_provider` as metadata if wanted | —                                                   |
| Archived vs active dedupe     | **No session-id dedupe** between `sessions/` and `archived_sessions/`; both are listed (test `codex.rs:2215-2238`). The only dedupe is plain vs `.zst` sibling with the same logical path in the same dir; the plain file wins (`codex_rollout_file.rs:126-137`)                                                                                                                                                             | —                                                   |

The usage importer does note that "the same rollout's copies (e.g. one each in sessions/ and archived_sessions/) must have identical content" (`session_usage_codex.rs:1826-1827`). **We should dedupe by session_id ourselves.**

### 2. `scan_sessions`

- **Which files:** see the table above. Unchanged files are skipped via `FileParseCache` (mtime and length, `utils.rs:42-90`). Read errors are not cached and are retried on the next scan.
- **How much is read** (`read_session_lines`, `codex.rs:1937-1961`):
  - Plain files: `read_head_tail_lines(path, 10, 30)`. Files under 16 KB are read in full. Larger files: the first 10 lines from the start, then a seek to `len-16384`, dropping the partial first line and keeping the last 30 (`utils.rs:101-138`).
  - Caveat: one line longer than 16 KB in the tail produces a garbage or partial tail. [INFERENCE: the parse fails and the line is skipped silently]
  - Also note: the "first 10 lines" are whole lines, so a huge `session_meta` (it contains base instructions) gets read into memory in full. [INFERENCE about size]
  - `.zst` files: only the first 10 lines are decompressed. There is no tail; `last_active` is the file mtime (Codex keeps the mtime when compressing).
- **Field derivation** (`parse_session_lines`, `codex.rs:1963-2088`):

| Field            | Source                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skip             | `session_meta.payload.source` is an object with a `subagent` key, so return `None` (`codex.rs:1989`, `2090-2095`)                                                                                                                                                                                    |
| `session_id`     | `session_meta.payload.id`, otherwise the first UUID matched in the filename by regex (`codex.rs:1992-1997`, `2171-2174`)                                                                                                                                                                             |
| `project_dir`    | `session_meta.payload.cwd` only. `turn_context.cwd` is not used, so a later cwd change in the session is invisible                                                                                                                                                                                   |
| `created_at`     | `timestamp` of the first parseable head line, otherwise `session_meta.payload.timestamp`                                                                                                                                                                                                             |
| `last_active_at` | first `timestamp` found going backwards through the tail, otherwise the mtime (`.zst` only)                                                                                                                                                                                                          |
| `title`          | thread title from the index/DB, otherwise the first `response_item/message role=user` in the head that passes `title_candidate_from_user_message` (skips `# AGENTS.md`, `<environment_context>`, and extracts the VS Code prompt), otherwise the basename of the cwd. Truncated to `TITLE_MAX_CHARS` |
| `summary`        | text of the last `response_item/message` of **any role** in the tail, truncated to 160 chars                                                                                                                                                                                                         |
| `resume_command` | `codex resume <id>`                                                                                                                                                                                                                                                                                  |

- **Title loading** (`codex.rs:99-232`):
  - Reads `session_index.jsonl` (`{id, thread_name}`) first. Then each lockable DB (opened read-only, 2 s busy timeout) runs `SELECT id,title FROM threads WHERE title<>'' AND (first_user_message IS NULL OR TRIM(title)<>TRIM(first_user_message))`.
  - DB titles override index titles.
  - This **never reads cwd** from the DB. The comment there warns that `first_user_message` can be huge enough to cause an OOM (openai/codex#29007).
- **Privacy issue for us:** the head scan parses user-message content (for the title) and the tail parses message text (for the summary), for **every** session. For non-approved projects our collector must:
  - parse only the `session_meta` line (id, cwd, timestamp, source, originator), plus timestamps from other lines;
  - not call `extract_text` on any other line.

  Ideally: sniff `type` cheaply (like `sniff_types`, `codex.rs:470-488`) and fully deserialize only lines whose type is `session_meta`; for last_active, read just the `timestamp` prefix of tail lines. [INFERENCE: design suggestion]

### 3. `load_messages`

Reading (`codex.rs:248-266`): a streaming `LineSpans` over `open_reader` with a 1 MiB BufReader. The whole file is processed, with no limit. Each line is dispatched by `sniff_types`: the top-level `type` and `payload.type` are read from the first 512 bytes, with a fallback to a `Head` struct parse.

**Line types handled** (`codex.rs:615-789`):

| top `type`                                                                  | sub (`payload.type`)                                                       | Effect                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `response_item`                                                             | `message`                                                                  | `on_message`: role `user` / `assistant` / anything else (developer/system becomes a `system` message with `injected=true`)                                                                                   |
|                                                                             | `reasoning`                                                                | Thinking block (summary, plus a content preview; empty = redacted, consecutive redacted blocks collapse)                                                                                                     |
|                                                                             | `function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call` | Tool-call blocks (pending calls tracked by `call_id`)                                                                                                                                                        |
|                                                                             | `function_call_output`, `custom_tool_call_output`                          | Tool-result blocks                                                                                                                                                                                           |
|                                                                             | `compaction`                                                               | Compaction event (no summary)                                                                                                                                                                                |
|                                                                             | `agent_message`                                                            | Message from a sub-agent (`author`), shown as a `system` message with `EventKind::SubAgent` plus text                                                                                                        |
| `event_msg`                                                                 | `item_completed`                                                           | `on_item`: `AgentMessage`, then `phases[id]=phase`; `ContextCompaction` becomes a compaction event; `WebSearch` id; CommandExecution/FileChange/McpToolCall/ImageView/Extension(web.*) are attached to calls |
|                                                                             | `task_started`                                                             | `start_turn(turn_id)`                                                                                                                                                                                        |
|                                                                             | `task_complete`                                                            | flush pool only (the `last_agent_message` field is ignored)                                                                                                                                                  |
|                                                                             | `turn_aborted`                                                             | `abort_turn`: open calls become Interrupted, then a `system` message with `EventKind::Aborted(reason)` (default `"interrupted"`)                                                                             |
|                                                                             | `thread_settings_applied`                                                  | model change                                                                                                                                                                                                 |
|                                                                             | `token_count`                                                              | token usage, only if there were no `token_usage_record` lines                                                                                                                                                |
| `turn_context`                                                              | —                                                                          | `start_turn(turn_id)` and the model (its `cwd` is **ignored**)                                                                                                                                               |
| `token_usage_record`                                                        | —                                                                          | token usage per turn                                                                                                                                                                                         |
| `compacted`                                                                 | —                                                                          | compaction event using `payload.message` as the summary (`replacement_history` is ignored)                                                                                                                   |
| `session_meta`, `world_state`, `inter_agent_communication_metadata`, others | —                                                                          | ignored (`codex.rs:675`)                                                                                                                                                                                     |

Note: the **`event_msg/user_message` and `event_msg/agent_message`** echoes are **not** handled. Only `response_item/message` is a source of user and assistant text, so nothing gets duplicated.

**User prompt vs injected text** (`on_user_message`, `codex.rs:937-1015`). This applies to each text item of a `role=user` message:

1. Empty text, or a lone `<image …>` / `</image>` wrapper line, is skipped (`codex.rs:1866-1869`).
2. A **trimmed** text starting with one of these `INJECTED_USER_PREFIXES` is injected (`codex.rs:241-246`):
   - `# AGENTS.md instructions`
   - `<environment_context>`
   - `<user_instructions>`
   - `<turn_aborted>`
3. So is any text **wholly wrapped in one tag**: `<name …>…</name>` where name is `[A-Za-z0-9_-]+` (e.g. `<recommended_plugins>`, `<skill>`) (`is_wrapped_in_tag`, `codex.rs:1850-1863`).
4. If the text starts with `# Context from my IDE setup:` (VS Code), the prompt is taken from the **last** `## My request for Codex:` heading. If there is no such heading, the whole text is injected (`codex.rs:2113-2169`).
5. Everything else is the real prompt. Images become `Image` blocks.

Injected and real parts of the same message are pushed as **two separate** `user` messages, `injected=true` and `injected=false` (`codex.rs:1003-1014`). Developer/system-role messages (`<permissions instructions>` etc.) are `role="system"` with `injected=true`.

→ **For us, the prompt is:** `role=="user" && !injected`, text blocks only.

**Final answer vs commentary:**

- `response_item/message role=assistant` can carry `payload.phase`; it is copied to `meta.stop_reason` (`codex.rs:911-923`).
- `event_msg/item_completed` with `item.type=="AgentMessage"` stores `phases[item.id]=item.phase` (`codex.rs:1325-1329`).
- In `finish()`, any assistant message whose `id` is in `phases` and has no `stop_reason` gets it (`codex.rs:1805-1815`).
- The fixture uses the same id `msg_final` for the AgentMessage item and the response_item message (`codex.rs:2977-2983`). The test asserts `stop_reason == "final_answer"` (`codex.rs:3275`).
- The values seen are `"final_answer"` and `"commentary"` (comment at `codex.rs:597`). There is **no** other special handling of commentary: both become ordinary assistant Text blocks.
- Fallback with no phase (older Codex): `finish()` treats "the last assistant message in the turn that has a Text block" as the final message. It attaches the model and tokens there (`codex.rs:1771-1803`).

→ **Our rule:** per turn, take the assistant text with `phase=="final_answer"`. Otherwise take the last assistant Text message in the turn. [INFERENCE] `task_complete.last_agent_message` (seen in the fixture at `codex.rs:2987`) is an alternative source of the final text, but CC Switch ignores it.

**Tool calls and reasoning into steps:**

- `push_assistant` merges blocks into the preceding "thinking-only" assistant message of the same turn (`codex.rs:870-900`).
- Tool calls become `ToolCall` blocks, kept in `calls`/`open` by `call_id`; outputs become `ToolResult` blocks.
- `item_completed` structured items attach to calls by id, or by heuristic (latest open call of a matching flavor, a pool for ambiguous parallel exec), or become standalone items (`codex.rs:1323-1378`, `1395-1530`).
- **For us:** all of this (lines ~494-585, 1017-1760, and most of `codex_items.rs`) can be dropped. Just skip `reasoning`, `*_call`, `*_output`, `item_completed` (except AgentMessage phase), `agent_message`.

**Interrupted / unfinished turns:**

- An explicit `event_msg/turn_aborted` becomes a system `Aborted(reason)` message, and the turn's open calls are marked Interrupted (`codex.rs:771-785`, fixture `codex.rs:3021`).
- A `<turn_aborted>` text injected into a user message is hidden as injected.
- At the end of the file with no `task_complete`, open calls get no result; the frontend shows them as "in progress" (`codex.rs:1761-1767`). There is **no explicit "turn incomplete" flag**.
- **For us:**
  - Turn complete = `task_complete` with that turn_id seen.
  - Aborted = `turn_aborted` seen.
  - Incomplete = neither seen, or no final_answer. [INFERENCE: we must track the state per turn ourselves]
- Turn ids come from `task_started.turn_id` and `turn_context.turn_id`. A message's `turn_id` is the current one at push time.

### 4. Detecting non-human sessions

- **Implemented:** only `is_subagent_source`. `session_meta.payload.source` being an object with a `subagent` key is excluded from the listing (`codex.rs:2090-2095`). The test fixture shape is `source:{subagent:{thread_spawn:{parent_thread_id,depth,agent_role}}}`, with `originator:"codex-tui"` (`codex.rs:2563`). `load_messages` itself does not filter.
- **Not implemented:** no check on `originator`, on `source` string values (e.g. `"cli"`, seen in the usage-test fixtures at `session_usage_codex.rs:2507`), or on exec/mcp/ephemeral sources.
  - [INFERENCE: Codex's SessionSource also has `"vscode"`, `"exec"`, `"mcp"`, plus subagent variants like `review`/`compact`/`thread_spawn`. Originator values like `codex_cli_rs`, `codex_vscode`, `codex_exec`. Verify against the Codex source before relying on them.]
- **Other signals available:**
  - `session_meta.payload.forked_from_id`
  - `source.subagent.thread_spawn.parent_thread_id`
  - `history_mode:"paginated"` / `history_base` (`session_usage_codex.rs:693-709`, `1376-1390`)
  - `response_item/agent_message` lines (inter-agent messages inside a parent session)
- **Recommendation for us:** skip when `source` is an object (any subagent), or when `source`/`originator` indicates exec/mcp [INFERENCE]. Keep `cli`/`vscode`.

### 5. Edge cases

- **Compaction:** handled via `compacted` (has `message` summary and `replacement_history`), `response_item/compaction`, and `item_completed ContextCompaction`, collapsed into one event (`codex.rs:658-669`, `697-701`, `1331-1334`, `829-843`).
  - `replacement_history` is ignored, so replayed history after compaction is not duplicated.
  - [INFERENCE] After compaction, Codex may re-emit injected context (AGENTS.md / environment_context) as new user messages. Prefix filtering covers that.
- **Forked sessions:** session_manager has no handling.
  - [INFERENCE from the usage importer comments] A fork's rollout starts with copied parent history, then new events.
  - Our collector must dedupe turns by `turn_id` across files, or use `forked_from_id` to skip the replayed prefix. Otherwise prompts get uploaded twice.
  - See `session_usage_codex.rs:3953` ("thread_spawn parent strips replay").
- **Resume / continuation:**
  - A normal resume appends to the **same** file (cache invalidated by the mtime/length change).
  - A resume of a compressed rollout: Codex decompresses it back to `.jsonl` first. During the transition both files exist, and `dedupe_siblings` prefers the plain one (`codex_rollout_file.rs:1-7`, `126-137`).
  - Paginated/revert continuations are separate files named `<threadId>_<rolloutId>.jsonl`, whose `session_meta.id` is the original thread id (`session_usage_codex.rs:679`, `1121-1126`, `3047-3050`).
  - session_manager would list them as separate entries **with the same session_id** (the id comes from session_meta). We must merge them by thread id.
- **Very large files:**
  - The listing reads only head (10 lines) and tail (16 KB) for plain files, and head only for zst.
  - `load_messages` streams with zero-copy borrowed deserialization; large tool outputs become previews plus `ContentRef` byte spans.
  - Sniffing avoids parsing the whole line twice.
  - For us: streaming line by line and skipping unwanted types after sniffing is enough.
  - Incremental upload [INFERENCE]: keep a byte-offset cursor per file. That's safe for plain append. When the file switches between plain and zst, the logical byte offsets stay the same (`content.rs:388-391` reads zst by skipping N decompressed bytes).
- **Other:** `content.codex_source_or_sibling` falls back to the sibling form when the stored path vanished (`content.rs:120-127`).

### 6. What is UI-only and can be dropped

| Drop                                                                                                                                                     | Ref                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Thread title loading (index jsonl + SQLite, `rusqlite`, the WSL lock check, `codex_state_db.rs` entirely, unless we want titles)                         | `codex.rs:99-232`                          |
| Title/summary derivation, VS Code title extraction for the list (but **keep** `extract_codex_prompt_from_ide_context` for prompts)                       | `codex.rs:2010-2075`, `2097-2111`          |
| `delete_session`, `resume_command`                                                                                                                       | `codex.rs:1871-1903`                       |
| The whole tool-step state machine: PendingCall, CallFlavor, OutputInfo, claim/pool, finish_call, backfill, emit_standalone, web search, local shell, MCP | `codex.rs:494-585`, `1017-1760`            |
| Reasoning/Thinking blocks, image refs, `ContentRef` / JsonlSpan pointers, `large_text_block` previews                                                    | `codex.rs:1017-1059` etc.                  |
| `codex_items.rs` except `Str` / `Contents` / `joined_text` / the `RawItem` phase                                                                         | `codex_items.rs:213-end`                   |
| Model-change events, token usage (optional metadata)                                                                                                     | `codex.rs:380-401`, `803-827`, `1771-1803` |
| `codex_history_migration.rs` (writes to the user's files; no reading dependency)                                                                         | whole file                                 |
| `blocks.rs` normalize/title helpers, `project_content`, `content.rs` window reads, the per-file parse cache (replace with our own offset cursor)         | —                                          |

**Keep and adapt:**

- the `codex_rollout_file.rs` reader, `is_rollout_file`, `dedupe_siblings`;
- `sniff_types`;
- the dispatch for `session_meta`, `task_started` / `turn_context` (turn id), `response_item/message`, `item_completed AgentMessage` (phase), `task_complete`, `turn_aborted`, the compaction markers;
- the injected-text classifier (`INJECTED_USER_PREFIXES`, `is_wrapped_in_tag`, `is_image_wrapper`, the IDE-context extraction);
- `is_subagent_source`, extended to the other non-human sources.

**Checks for the main agent:** none to run here. Before relying on the `source`/`originator` value sets in §4, confirm them against the Codex upstream (`SessionSource` / `originator`).
