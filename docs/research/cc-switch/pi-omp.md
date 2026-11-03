> 归档说明：这是 2026-10-28 对 CC Switch 4.0.21（`6d6b7162f122ac0ce1356a14688c8c4f712db3c8`）的原始源码阅读笔记，含标注为 INFERENCE 的推测，未运行验证。
> 设计建议及部分泛化表述已在[汇总报告](../../SESSION_COLLECTOR_RESEARCH.md)中修正；以后者为准。这里保留阅读证据，不作为已经实现或验收的规格。

**Pi / Oh My Pi (omp) session pipeline in CC Switch v4.0.21 (`6d6b716`)**

## Summary

- **One parser for both apps.** All the Pi logic is in `session_manager/providers/pi.rs`. Oh My Pi (omp) is the same code with different settings, held in a `Dialect` struct. `omp.rs` only adds its own root lookup, resume command and delete cleanup.
- **Active branch = path from the last entry back to the root.** The parser follows `parentId` from the last valid entry in the file up to the root. Abandoned branches are dropped.
- **Mapping to messages** is in `providers/pi_blocks.rs`. User text, assistant text, thinking, tool calls and tool results each become a separate block.
- **No "final answer" field exists.** Your collector has to work it out per turn. There's a suggested rule at the end.
- **Privacy problem: the scan reads everything.** It parses every line of every file and pulls out user and assistant text to build the title and summary. You can't reuse it for projects that aren't approved. The header is the first line (omp may put a title line before it), so you can read just that to get the session id and cwd.

## Files

- `session_manager/providers/pi.rs:56-75` — the `Dialect` struct (`title_slot`, `model_selector`) and the Pi settings.
- `pi.rs:105-139` — `session_roots_for` and `session_files`. `session_files` also includes child (subagent) sessions and is used only by usage tracking.
- `pi.rs:151-247` — Pi root lookup: env var, then `settings.json`, then the agent directory.
- `pi.rs:249-298, 300-309` — scan and load entry points.
- `pi.rs:381-421` — `parse_session`: builds the session metadata (title, summary, timestamps).
- `pi.rs:423-503` — `read_tree`: reads the header, builds the parent map, walks the active branch.
- `pi.rs:505-536` — `update_session_summary`.
- `pi.rs:546-588` — `read_active_messages` and `split_model_selector` (omp's model string).
- `pi.rs:609-668` — `parse_header`, `entry_identity` (id rules for v1 vs v2+), and `parse_message` (plain text used for the summary).
- `pi.rs:670-773` — path checks, layout depth, the 128 MiB size limit, id rules.
- `pi.rs:799-858` — `collect_jsonl_files` and `collect_child_session_files`.
- `pi.rs:871-995` — tests: latest leaf wins, duplicate ids, missing parent or cycle, `session_info` on an inactive branch.
- `providers/omp.rs:8-42` — omp settings and omp root lookup.
- `omp.rs:56-92` — resume command.
- `omp.rs:94-140` — delete, including the child-session folder and `.bak` files.
- `omp.rs:180-249` — test showing the branch choice and the title slot.
- `providers/pi_blocks.rs:23-91` — `PiTranscript::push_entry`: switch on entry type.
- `pi_blocks.rs:93-198` — `message_entry` and `assistant_message`, including `stopReason`.
- `pi_blocks.rs:200-318` — tool results and diff backfill.
- `pi_blocks.rs:320-470` — user content, images, `bashExecution`, summary events, `assistant_meta`.
- `providers/blocks.rs:719-747` — `starts_turn` and `assign_turn_ids`.
- `providers/utils.rs:157-218` — `extract_text`. It writes tool calls as `[Tool: name]`, so that text gets into summaries.
- `utils.rs:310-330` — `for_each_jsonl_value`: skips empty or broken lines and gives each line's byte range.
- `pi_config/mod.rs:34-100` — `get_pi_agent_dir` and `read_pi_native_defaults` (`sessionDir`).
- `omp_config.rs:28-171` — omp agent dir, profile, data dir and XDG handling.
- `settings.rs:1289-1300` — the in-app directory overrides `pi_config_dir` and `omp_config_dir`.
- `session_manager/mod.rs:69-70, 130-132`; `content.rs:670-673` — where the two providers are hooked in.
- `services/session_usage_pi.rs:168-171` — the only caller of `pi::session_files()`.

## 1. Roots, layout, ids, cwd, timestamps, title

**Pi root** (`pi.rs:151-180`). The first source that is set wins:

1. `PI_CODING_AGENT_SESSION_DIR` (non-empty) → **Flat** layout.
2. `sessionDir` in `<agentDir>/settings.json` (JSON5) → **Flat** layout. A settings file that can't be parsed makes Pi unavailable; there is no fallback.
3. `<agentDir>/sessions` → **ProjectDirectories** layout.

- For values from 1 or 2, `~` and `~/x` are expanded. A relative path gives `RequiresProjectContext`: the folder is not listed at all, and there's no fallback (`pi.rs:182-247`). A missing folder, or a path that isn't a folder, gives `Unavailable` with a reason (not an empty list).
- `agentDir` comes from the in-app setting `pi_config_dir`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. It must be an absolute path (`pi_config/mod.rs:34-74`).

**omp root** (`omp.rs:17-42`):

- `PI_CODING_AGENT_SESSION_DIR` is shared with Pi. Absolute → Flat; relative → not listed. No `~` expansion here, unlike Pi.
- Otherwise `get_omp_data_dir()/sessions` with the ProjectDirectories layout.
- The agent dir is the in-app setting `omp_config_dir` (`omp_config.rs:28-43`). Without it, the native lookup (`omp_config.rs:85-130`) is:
  - profile = `OMP_PROFILE`, then `PI_PROFILE` (`"default"` counts as no profile);
  - config root = `~/<PI_CONFIG_DIR or .omp>`;
  - with a profile: `<root>/profiles/<p>/agent`;
  - otherwise `PI_CODING_AGENT_DIR` if set (relative is resolved against the current directory). A value inherited from a parent profile is ignored;
  - otherwise `<root>/agent`.
- The data dir (`omp_config.rs:133-171`, Linux and macOS only): if the agent dir is the default and `$XDG_DATA_HOME/omp[/profiles/<p>]` exists, use that. Otherwise use the agent dir.

**Layout** (`pi.rs:760-831`):

- Flat: `<root>/*.jsonl`, exactly one level deep.
- ProjectDirectories: `<root>/<projectDir>/*.jsonl`, exactly two levels deep.
- Files over 128 MiB are skipped during the scan (`pi.rs:21, 821-831`). `load_messages` rejects any path that doesn't match the current layout (`pi.rs:707-740`).
- The project folder name is never decoded. The project comes only from the header's `cwd`.

**Header** (`pi.rs:609-641`):

- The header is the first valid JSON line. It must have `type:"session"`, otherwise the file is an error.
- `id` must match `[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`, at most 256 bytes (`pi.rs:762-772`). This is the `session_id`.
- `version` defaults to 1, and 0 is rejected.
- `cwd` is a string, possibly empty. Empty means no project.
- `timestamp` becomes `created_at`, via `parse_timestamp_to_ms` (RFC 3339, or seconds/ms).
- omp only: before the header there can be a `{"type":"title","v":1,"title":...}` line. The header can also carry a `title` (`pi.rs:440-451, 637-640`).

**Title / summary / last active** (`pi.rs:381-421, 505-536`):

- Title is checked in this order:
  1. explicit name: the omp title line or header title, then the latest `session_info.name` anywhere in the file, **even on an inactive branch** (test at `pi.rs:975-994`);
  2. else the first user message, cut to `TITLE_MAX_CHARS`;
  3. else the last part of `cwd`.
- Summary is the last user/assistant message text, cut to 160 characters. It's computed over all branches.
- `last_active_at` is the largest user/assistant timestamp (`message.timestamp`, else the entry's `timestamp`), falling back to the header timestamp.

**How much the scan reads:** the whole file. Every line is JSON-parsed (`read_tree`), and the parser keeps the text of user/assistant messages for the title and summary. **For an unapproved project, the collector must read only the first one or two lines** to get the session id and cwd. [INFERENCE] For last activity, use the file's modification time instead of reading the contents.

## 2. load_messages

**Flow** (`pi.rs:300-309, 546-574`):

1. Check the path is under the root and matches the layout.
2. `read_tree` (first full pass).
3. `read_active_messages` (second pass using `for_each_jsonl_value`). It skips everything up to and including the line with `type:"session"`, and keeps entries whose position is in `active_entry_indexes`.
4. omp only: `split_model_selector` turns `model:"provider/id"` into `provider` + `modelId`.
5. `PiTranscript::push_entry`.

**Tree and active branch** (`pi.rs:458-498, 643-667`):

- **v2 and later:** every entry needs a valid `id`, and `parentId` must be null, missing or a valid id. Entries that fail this are not part of the tree. A duplicate id: the later entry replaces the earlier one.
- **v1 (legacy):** the id is a made-up `legacy-<n>`, and each entry's parent is simply the previous entry, so the file is one straight chain.
- **Choosing the branch:** start at `latest_id`, the **last valid entry in file order**, and follow parents up to the root. There's no use of a "current leaf" pointer from the app, and no timestamp ordering.
  - A cycle stops the walk.
  - A missing parent stops the walk; the part already walked is kept (tests at `pi.rs:871-893, 939-973`).
  - Note: if the last line belongs to a branch with no messages (for example `session_info` or `label` on an old branch), that branch still becomes the active one. [INFERENCE] That follows from the code above; it isn't tested.
- Entries on the active branch are output in file order, not in tree-walk order.

**Entry type → message** (`pi_blocks.rs:37-91`):

| Entry                                                | Output                                                  |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `message`                                            | handled by `message.role` (next table)                  |
| `model_change`                                       | system event `ModelChange` with text `provider/modelId` |
| `thinking_level_change`                              | system event `ThinkingLevel`                            |
| `compaction`, `branch_summary`                       | system `Compaction` event, preview of `/summary`        |
| `custom_message` where `display != false`            | system Text from `extract_text(content)`                |
| anything else (`session_info`, `label`, `custom`, …) | dropped                                                 |

**Message role → blocks** (`pi_blocks.rs:93-318, 320-421`):

| `message.role`                       | Output                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `user`                               | role `user`. Content can be a string or an array of `{text}` / `{image, data, mimeType}`                       |
| `assistant`                          | role `assistant`, one message with blocks in content order (details below)                                     |
| `toolResult`                         | role `tool`, one ToolResult (details below)                                                                    |
| `bashExecution`                      | role `user`: ToolCall (`by_user`) + ToolResult. This is the user typing a `!cmd`; it does not start a new turn |
| `branchSummary`, `compactionSummary` | system Compaction event                                                                                        |
| `system` and anything else           | dropped                                                                                                        |

Assistant messages:

- Content can be a string, or an array of `thinking` → Thinking block, `text` → Text block, `toolCall {id, name, arguments}` → ToolCall block.
- `stopReason` adds an event at the end:
  - `"aborted"` → `Event Aborted`
  - `"length"` → `Event Other("truncated")`
  - `"error"` → `Event Error(errorMessage)`
- `assistant_meta` keeps `model`, token usage, cost and the raw `stop_reason` (`pi_blocks.rs:423-455`).

Tool results:

- `toolCallId`, `isError`, the text joined, images, and `details.exitCode`, `durationMs`, `fullOutputPath`.
- If `details.exitCode` is missing, the exit code is parsed from a last line of the form "Command exited with code N".
- `details.diff` is copied back onto the matching edit/write tool call.

**Turns** (`blocks.rs:719-747`):

- `finish()` calls `assign_turn_ids`. A new turn starts at a user message that has non-empty text, an image, or a slash command and isn't flagged as injected. Pi never sets the injected flag.
- Content before the first prompt goes to `t0`.

**Final answer:** the parser doesn't mark one. It only keeps the raw `meta.stop_reason`. The message `content` field is a plain-text version of the blocks that leaves out Thinking but includes tool titles and results (`model.rs:436-452`). So `content` is not "the answer only".

- [INFERENCE] Suggested rule for the collector: within a turn, the final answer is the Text blocks of the last assistant message whose `stopReason` isn't `toolUse`/aborted/error. Pi's normal values are `stop`, `length`, `toolUse`, `error`, `aborted`; the code only handles three of them by name.
- [INFERENCE] Treat a turn as incomplete when there's no such message: the last assistant message is `toolUse`, aborted or error, or the turn ends on a tool result.
- Text in an assistant message that also contains a toolCall is intermediate commentary, not the answer.
- Read the raw JSON rather than the `SessionMessage` output, so that skipping thinking and tool steps is decided by your own code.

## 3. omp vs Pi

Everything is shared through `Dialect` except four things:

1. **Root lookup.** omp uses the profile/XDG data dir, doesn't expand `~` in the env var, and doesn't read `sessionDir` from settings (`omp.rs:17-42`).
2. **`title_slot=true`.** A title line can come before the header, and the header can have a `title`.
3. **`model_selector=true`.** The `model:"provider/id"` string is split.
4. **Resume and delete.** omp's resume sets `OMP_PROFILE`, `PI_PROFILE`, `PI_CODING_AGENT_DIR` and clears the XDG variables (`omp.rs:56-92`). omp's delete also removes the `<session>/` child folder and `<file>.*.bak` (`omp.rs:94-140`).

Tree building, the branch walk, the transcript code and the path checks are all shared. `omp.rs` is about 140 lines of code, against roughly 830 in `pi.rs` and 470 in `pi_blocks.rs`, not counting tests.

## 4. Subagent / task sessions

- Child sessions are stored in a folder named after the parent file without `.jsonl` (`<parent>/…/*.jsonl`); grandchildren nest the same way. Folders named `subagent-artifacts` (transcripts and audit logs without a header) are skipped (`pi.rs:834-858`).
- **The session browser leaves them out.** The listing is depth-limited, and `load_messages` on a child path fails the layout check. Tests: omp `omp.rs:251-268`, Pi `pi.rs:1122-1137`.
- **Only usage tracking includes them**, through `session_files()` (`pi.rs:117-139`; test at `pi.rs:1160-1218`; caller `session_usage_pi.rs:169`). That function exists only for Pi. omp has no usage sync that I found.
- Nothing links a child session back to its parent, apart from the folder nesting.

## 5. Edge cases and UI-only parts

- **Skipped:** broken JSON lines and empty lines. **Hard limits:** 500k entries and 128 MiB (`pi.rs:19-21`).
- A future `version` (for example 4) is parsed with the current rules (`pi.rs:896-910`).
- The tool-call text `[Tool: name]` from `extract_text` ends up in the summary text.
- **UI-only, not needed for the collector:** `ContentRef::Jsonl` byte pointers for loading large content on demand, image size estimates, diff backfill, tool-kind detection and titles, the resume command, delete (checks containment and header id; omp removes artifacts without following symlinks), and `SessionDiscovery` status for the UI.
- The branch choice depends only on file order, so rewinding inside the app without appending a line isn't detected. [INFERENCE] Pi appends a line when you navigate the tree, so in practice this works.

## Other providers (storage, one line each)

- **gemini**: `~/.gemini` (or the in-app override) `/tmp/<projectHash>/chats/*.json|*.jsonl`. The project comes from `.project_root`. JSONL is replayed with `$set` / `$rewindTo` (`gemini.rs:20-81`, `gemini_config.rs:9-15`).
- **grokbuild**: `~/.grok` (or override) `/{sessions,archived_sessions}/<encoded-project>/<id>/summary.json` with `info.cwd`, plus `chat_history.jsonl` (`grokbuild.rs:36-64`).
- **openclaw**: `get_openclaw_dir()` (setting override; default presumably `~/.openclaw` [INFERENCE]) `/agents/<agent>/sessions/*.jsonl`, plus the `sessions.json` index. Same JSONL format as Pi, read through `PiTranscript` with every line included (`openclaw.rs:31-50`, `pi_blocks.rs:1-5`).
- **kimi**: `$KIMI_CODE_HOME` or `~/.kimi-code` `/sessions/<workspace>/<session>/state.json` (cwd, title) plus `agents/main/wire.jsonl` (`kimi.rs:12-52`, `kimi_config.rs:89-94`).
- **dsh**: `$DSH_HOME` or `~/.dsh` `/sessions/<project>/<session>/session.vN.jsonl[.zstd]`; the highest generation is used (`dsh.rs:17-66`, `dsh_config.rs:13-18`).
- **agy** (Antigravity): `~/.gemini/antigravity-cli/brain` and `~/.gemini/antigravity/brain`, plus per-profile `<appConfig>/agy/<p>/antigravity-cli/brain`. Each conversation has `<id>/.system_generated/logs/transcript_full.jsonl`, and metadata is in the SQLite file `conversation_summaries.db` (`workspace_uris`) (`agy.rs:19-155`, `agy_config.rs:31-47`).
- **mcode** (MiniMax Code): SQLite at `$MINIMAX_DATA_DIR` or `$MAVIS_DATA_DIR` or `~/.minimax`, file `/v2/sqlite/runtime-state.sqlite`, opened read-only (`mcode.rs:9-131`, `mcode_config.rs:12-17`).
- Also present but not in scope: claude, codex, opencode, hermes (with a WSL Python reader).
