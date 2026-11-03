> 归档说明：这是 2026-10-28 对 CC Switch 4.0.21（`6d6b7162f122ac0ce1356a14688c8c4f712db3c8`）的原始源码阅读笔记，含标注为 INFERENCE 的推测，未运行验证。
> 设计建议及部分泛化表述已在[汇总报告](../../SESSION_COLLECTOR_RESEARCH.md)中修正；以后者为准。这里保留阅读证据，不作为已经实现或验收的规格。

## Summary

- **OpenCode** has two stores: legacy JSON files (`storage/session|message|part`) and `opencode.db`. The database has two schema versions: V1 tables `session/message/part` and V2 tables `session_v2/session_message`. Sessions from both stores are merged, and the SQLite copy wins when the same id appears in both. The project folder comes only from the session's `directory` field. `projectID`, `worktree` and `parentID` are never read.
- **Hermes** has `state.db` (tables `sessions` and `messages`) plus `sessions/*.jsonl`. Sessions from both are merged and SQLite wins. The project folder comes from `cwd`, falling back to `directory`. The 500-session cap applies only to the SQLite session list.
- **Privacy problem:** upstream's scan step reads message content in three places. We must not copy these into the collector:
  - OpenCode JSON sessions without a title: the scan reads the first user message's parts.
  - Hermes SQLite: the scan reads the first user message and the last message of **every** listed session, up to 500.
  - Hermes JSONL: the scan reads the first 30 and last 10 lines of each file.
- **Read mode:** every database is opened with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`. There is no `immutable=1` (a test explicitly rejects it), no busy timeout for OpenCode or Hermes, and no WAL pragma.
- **Neither provider does any of these:** mark a "final answer", flag unfinished turns, or filter out subagent/child sessions. The collector has to do all three itself.

---

## Report

### 0. Shared pieces

- `mod.rs:63-70` scans all providers in parallel threads. `mod.rs:113-117`: if a session's source path starts with `sqlite:`, it is loaded by `load_messages_sqlite`; otherwise it is loaded from the file (`mod.rs:124,129`).
- `SessionMessage::from_blocks` (`model.rs:76-88`) builds the plain-text `content` field via `project_content` (`model.rs:433-455`). That function skips `Thinking` and `Step` blocks but **keeps** tool calls and events. So `content` is not a clean "answer only" field. Build the answer from `Text` blocks only.
- Turns: `assign_turn_ids` / `starts_turn` (`blocks.rs:719-745`). A new turn starts at a `user` message that is not `injected` and contains non-empty Text, an Image, or a SlashCommand event. Everything after it, up to the next such message, has the same `t{n}` id. Messages before the first user prompt are `t0`.
- Lazy full-content fetch: `content.rs:445-497`. It allows only specific (table, column) pairs: OpenCode `part|message|session_message` × `data|content`; Hermes `messages` × `content|reasoning|tool_calls`. Both id and session_id are bound as parameters. It opens read-only with no mutex.

---

### 1. OpenCode

#### 1.1 Storage locations and environment overrides

| Item                                 | Path / rule                                                                                                                                | Code                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Base dir                             | `$XDG_DATA_HOME/opencode` (empty string counts as unset), else `~/.local/share/opencode` on **every** OS, macOS included                   | `opencode.rs:19-28`; `opencode_config.rs:89-102` (same logic duplicated) |
| Legacy JSON storage                  | `<base>/storage/` with `session/**.json`, `message/<sessionID>/*.json`, `part/<messageID>/*.json`, `session_diff/<id>.json`                | `opencode.rs:31-33`, `:110-126`, `:283-298`, `:543-545`                  |
| SQLite                               | `OPENCODE_DB` env var (empty ignored; an absolute path is used as-is, a relative one is joined to the data dir), else `<base>/opencode.db` | `opencode_config.rs:73-87`                                               |
| Config dir (not needed for sessions) | settings override, else `~/.config/opencode`                                                                                               | `opencode_config.rs:49-56`                                               |

**Schema detection** (`opencode.rs:48-54`): V2 if both `session_v2` and `session_message` tables exist, otherwise V1.

**Mixed V1/V2 databases** (`opencode.rs:66-79`, `:233-252`): the migration timestamp comes from this query:

```sql
SELECT max(coalesce(time_created, 0), coalesce(time_updated, 0)) FROM kv WHERE key = 'migration.v1-v2'
```

In a V2 database, V1 sessions are added only if they are absent from `session_v2` and were updated after that timestamp.

**Merging JSON and SQLite** (`opencode.rs:83-108`): build a set of SQLite `session_id`s. A JSON session is added only if its id is not in that set. Matching is by id only; timestamps and content are not compared.

**Source reference formats:**

- SQLite: `sqlite:<db_path>:<session_id>`. It is split at `rfind(":ses_")`, which relies on OpenCode session ids starting with `ses_` (`opencode.rs:133-139`).
- JSON: the source is the message directory `storage/message/<sessionID>` (`opencode.rs:724-725`).

#### 1.2 Scan

**SQLite V1** (`opencode.rs:199-200`):

```sql
SELECT id, COALESCE(title, ''), directory, time_created, time_updated
FROM session ORDER BY time_updated DESC
```

**SQLite V2** (`opencode.rs:216-223`):

```sql
SELECT s.id, COALESCE(s.title, ''), s.directory, s.time_created,
       MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS last_active_at
FROM session_v2 s LEFT JOIN session_message m ON m.session_id = s.id
GROUP BY s.id ORDER BY last_active_at DESC
```

The V2 query touches `session_message`, but only to aggregate `time_updated`. It does **not** read `data`.

**Extra V1 query for mixed databases** (`opencode.rs:236-240`):

```sql
SELECT id, COALESCE(title, ''), directory, time_created, time_updated FROM session
WHERE NOT EXISTS (SELECT 1 FROM session_v2 WHERE session_v2.id = session.id) AND time_updated > ?1
ORDER BY time_updated DESC
```

**Row mapping** (`opencode.rs:162-194`):

- `project_dir` = `directory`, or None if empty.
- Title and summary both = `title`, or the basename of `directory` if the title is empty.
- Timestamps are used as stored (milliseconds). **The SQLite scan reads no message content.**

**JSON scan** (`opencode.rs:690-745`): from each session JSON it reads `id`, `title`, `directory`, `time.created` and `time.updated`.

- **When `title` is empty, it calls `get_first_user_summary`** (`:728-732`, `:748-797`). That walks every message JSON in the session to find the earliest user message, then reads that message's parts and keeps the text, truncated to 160 characters.
- This **reads content during scan** and must be removed for the collector.

**Fields not used:** `projectID`, `worktree`, `parentID`, and archive time. `projectID` appears only in test fixtures (`opencode.rs:962`). Nothing in the code reads `parentID`, `subtask` or `archived`. Project detection relies only on `directory`.

#### 1.3 Loading messages

**JSON** (`opencode.rs:257-325`):

- Reads every file under `message/<sid>/`, taking `id`, `role` and `time.created`.
- Parts come from `part/<msgId>/*.json`, **sorted by filename** (the comment says part ids increase over time).
- Messages are sorted by `(created_ts, msg_id)`, then turn ids are assigned.

**SQLite V1** (`opencode.rs:370-438`):

```sql
SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC
SELECT id, message_id, data FROM part WHERE session_id = ?1 ORDER BY time_created ASC, id ASC
```

The role is taken from the `role` field inside the message's `data` JSON.

**SQLite V2** (`opencode.rs:440-526`):

```sql
SELECT id, type, time_created, data FROM session_message WHERE session_id = ?1 ORDER BY seq ASC, rowid ASC
```

- Only `type ∈ {user, assistant, system}` is kept.
- `user`/`system` rows use `data.text`.
- Other rows use the `data.content[]` array; each item is shaped like a V1 part, and tool items use `name`/`id`.
- If none of those exist, `text` is used as the fallback.

**Choosing which session to read in a V2 database** (`opencode.rs:347-366`): if the id exists in `session_v2`, use V2; otherwise, if a `message` table exists, use V1.

**How each part type is handled** (`opencode_blocks.rs:79-127`, `push_part_blocks`):

| part `type`                                              | Result                                                                                                                                         | Upload?                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `text`                                                   | Text block. **Skipped if `synthetic:true` or `ignored:true`** (text OpenCode inserted itself)                                                  | ✅ user prompt / answer                  |
| `reasoning`                                              | Thinking block                                                                                                                                 | ❌                                       |
| `step-start` / `step-finish`                             | Step block (tokens, cost, `reason`)                                                                                                            | ❌ (`reason` may help decide completion) |
| `tool`                                                   | ToolCall + ToolResult; `state.status` is `completed`→Success, `error` containing "abort"→Interrupted, `running`/`pending`→Pending (`:220-227`) | ❌                                       |
| `agent`                                                  | Event `@name`                                                                                                                                  | ❌                                       |
| `patch`                                                  | Fake `patch` ToolCall                                                                                                                          | ❌                                       |
| `file`                                                   | `image/*` becomes an Image block; anything else becomes a filename event                                                                       | Decide yourself (image attachments)      |
| `snapshot` / `compaction` / `subtask` / `retry` / others | **Dropped** (`:125`)                                                                                                                           | ❌                                       |

**Message-level fields:**

- `error.name == "MessageAbortedError"` becomes an `Aborted` event. Any other `error` becomes an Error event (`opencode_blocks.rs:338-354`).
- Assistant metadata (`:357-402`): `modelID`/`providerID`, `tokens`, `cost`, `time.created`/`time.completed`, and `finish`, which becomes `stop_reason`.

**Final answer:** upstream does not mark one. Proposed rule for the collector [INFERENCE]: within a turn, take the **last assistant message**, and from it the **last run of non-synthetic Text parts**. In OpenCode, one assistant message can contain several step-start/step-finish rounds, and a turn can contain several assistant messages. The Text parts in earlier steps are commentary between tool calls.

**Unfinished turns:** upstream has no flag for this. Suggested signals [INFERENCE]: the last assistant message has no `time.completed`, or its `finish` is a value like `tool-calls`, or it has a `MessageAbortedError`, or the turn has no assistant Text at all.

**Subagents / child sessions:**

- No `parentID` filtering anywhere. Child sessions show up as ordinary sessions, with the same `directory` as the parent.
- In the parent session, the `subtask` part is dropped. The Task tool call appears only as a tool block.
- The collector must read `parentID` from the session JSON or `session.parent_id` itself. Those column/field names were **not seen** in this repo [INFERENCE].

#### 1.4 SQLite open mode

```rust
Connection::open_with_flags(&db_path,
    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
```

Used at `opencode.rs:147-150` (scan) and `:339-342` (load). There is no `busy_timeout` and no URI `immutable`/`mode=ro`. If the open fails, the scan silently returns an empty list. Codex, by contrast, sets `busy_timeout(2s)` at `codex.rs:176`, and the collector should do the same.

Delete (`opencode.rs:592-688`, which opens the database read-write) is not needed by the collector.

#### 1.5 Edge cases

- The `ses_` prefix requirement for parsing source references (`:135`).
- Empty messages are dropped (`model.rs:91-93`). A message containing only synthetic text is therefore dropped as well.
- V2 `system` messages are kept as role `system`. They do not start a turn (`starts_turn` requires `user`).
- Image `data:` URLs are referenced lazily via `/url` and not copied (`opencode_blocks.rs:304-313`). `file://` URLs become a local path.

---

### 2. Hermes

#### 2.1 Storage locations and environment overrides

- `get_hermes_dir()` (`hermes_config.rs:53-66`), in order:
  1. CC Switch setting `hermes_config_dir`
  2. `HERMES_HOME` (trimmed; `~` is not expanded)
  3. Default: macOS/Linux `~/.hermes`, Windows `%LOCALAPPDATA%\hermes` (`:68-80`)
- Database: `<dir>/state.db`. Transcripts: `<dir>/sessions/*.jsonl` and also `*.json` (`hermes.rs:20-26`, `:668-670`).

**Merging** (`hermes.rs:30-53`): same as OpenCode. SQLite comes first, and a JSONL session is added only if its id is not already present. The JSONL id comes from a `type:session|init` line's `id`/`sessionId`, falling back to the filename stem (`:776-782`).

**Source reference formats:** `sqlite:<db>#<session_id>`, split at the last `#` (`hermes.rs:627-636`). For JSONL, the source is the file path.

#### 2.2 Scan (SQLite)

- `hermes.rs:91-108`: check that the `sessions` table exists, get its columns via `PRAGMA table_info`, then:

```sql
SELECT * FROM sessions ORDER BY rowid DESC LIMIT 500      -- SQLITE_SCAN_LIMIT = 500 (:59)
```

- **About the 500 limit:** only the 500 newest rows by rowid are listed. Older sessions **never appear** in the list. The limit also scopes the first/last-message lookups below. Loading a single session's messages has **no** limit. Because a collector must not miss sessions, it should drop this cap or page through instead.
- Row mapping (`hermes.rs:256-299`):
  - `id`
  - title = `title`, truncated
  - **`project_dir` = `cwd`, else `directory`**
  - created = `started_at`, else `created_at`
  - last active = `last_activity_at` (if not null), else `ended_at`, else `updated_at`
  - Timestamps go through `parse_timestamp_to_ms`.
- **The scan reads content** (`hermes.rs:117-133`, `:188-230`). For each of the 500 sessions it runs:

```sql
SELECT m.session_id, m.content FROM messages m
JOIN (SELECT session_id, {MIN|MAX}(id) AS edge_id FROM messages
      WHERE {role_filter}{display_filter}
        AND session_id IN (SELECT id FROM sessions ORDER BY rowid DESC LIMIT 500)
      GROUP BY session_id) f ON m.id = f.edge_id
```

- First message: `MIN` with `role = 'user'`.
- Last message: `MAX` with `role IN ('user','assistant') AND content IS NOT NULL AND content != ''`.
- The collector **must remove this**, or restrict it to approved sessions.
- `display_filter` (`:236-243`): `AND (active = 1 OR compacted = 1)` if both columns exist; `AND active = 1` if only `active` exists; nothing for older schemas.
- `decode_content` (`:246-254`): content that starts with `"\0json:"` is JSON, and its text parts are extracted with `extract_text`.

#### 2.3 Scan (JSONL)

`hermes.rs:691-797`:

- `read_head_tail_lines(path, 30, 10)` reads the first 30 and last 10 lines.
- From `type == "session"|"init"` lines it takes `id`/`sessionId`, `title`, and `cwd`/`directory`.
- Timestamps come from `timestamp`/`ts`.
- **The first user message and last message text are read** for the title and summary.
- The collector must strip this down to reading only the header lines [INFERENCE: whether `cwd` reliably appears in the first 30 lines is unknown].

#### 2.4 Loading messages (SQLite)

`hermes.rs:440-476`. Missing columns are replaced with `NULL AS col`:

```sql
SELECT id, role, content, timestamp, tool_call_id, tool_calls, tool_name,
       active, display_metadata, reasoning
FROM messages WHERE session_id = ?1{display_filter} ORDER BY id ASC
```

Rows are in insertion order, since timestamps can go backwards (comment at `:450-451`).

`messages_from_rows` (`hermes.rs:478-574`):

1. **Skip `model_only` rows**: `display_metadata.model_only`, which may be double-encoded JSON (`:420-438`). These are micro-compaction merge rows.
2. **Deduplicate** by `(role, content, timestamp bits, tool_call_id, tool_calls, tool_name)` (`:407-416`). Compaction re-inserts rows, so duplicates are expected. The first position is kept, filled with the row having the larger `(active, id)`.
3. Per role:
   - `tool` → ToolResult with status Unknown.
   - `assistant` → `reasoning` column becomes Thinking, `content` becomes Text, `tool_calls` (OpenAI-shaped JSON) becomes ToolCalls.
   - Anything else, including `user` and `system`, with non-empty text → Text.
4. Timestamps are REAL seconds, multiplied by 1000 (`:581-583`).

**Final answer** [INFERENCE]: the last row in the turn with `role='assistant'` and non-empty `content`. Ideally also with empty `tool_calls`, since a non-empty `tool_calls` means work was still in progress. Assistant `content` that accompanies `tool_calls` is intermediate commentary.

**Unfinished / aborted:** Hermes stores no completion or abort marker, and upstream does not detect it. Suggestion [INFERENCE]: if the turn's last row is a `tool` row, or an assistant row whose `tool_calls` is non-empty, treat the turn as incomplete.

**Child sessions:** not handled by upstream. Whether the `sessions` table has a parent column was not seen in this repo [INFERENCE: check against a real database].

#### 2.5 Loading messages (JSONL)

`hermes.rs:802-861`:

- Supports flat `{role, content, ts}` lines and `{type:"message", message:{…}, timestamp}` lines.
- Role mapping is the same as SQLite, but there is **no** reasoning, no dedupe and no `model_only` handling.
- The comment notes the field names were guessed by analogy with the SQLite schema and are unverified (`:799-800`).

#### 2.6 SQLite open mode and WAL

- Scan (`hermes.rs:81-87`) and load (`:371-375`): `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`. No busy timeout.
- Test `readonly_reader_sees_committed_wal_without_immutable` (`hermes.rs:1048-1094`):
  - A plain read-only connection **sees** data committed in WAL mode and cannot write.
  - An `immutable=1` URI connection (`file:...?mode=ro&immutable=1` with `SQLITE_OPEN_URI`) sees **nothing** that is still only in the WAL. The comment at `:1079-1080` says this mode "must not be a fallback for a live Hermes database".
  - Conclusion: use normal read-only mode, do not use `immutable`, and add a busy timeout.

#### 2.7 `hermes_wsl.rs` (Windows only, not needed)

`mod.rs:3-4` compiles it only under `#[cfg(windows)]`. For `\\wsl.localhost\` and `\\wsl$\` UNC paths (`:63-86`), it runs `wsl.exe --distribution <d> ... python3 -I -c <hermes_wsl_reader.py>` (`:90-100`). Results come back as line-delimited JSON frames capped at 1 MiB each (`:10`, `:12-60`). Not relevant to a macOS collector.

#### 2.8 Edge cases

- Structured content with the `\0json:` prefix: for `tool` rows, no full-content reference is offered (`hermes.rs:510-516`).
- Rows hidden by undo/rewind/regenerate (`active=0, compacted=0`) are excluded. Rows archived by compaction (`compacted=1`) are kept but deduplicated.
- Pulling `tool_calls` arguments lazily via JSON pointer is only needed for the UI.

---

### 3. What the collector should change

1. **Scan reads metadata only.** For OpenCode, use the SQLite queries in §1.2 directly (no content), and for JSON sessions read only the session JSON, deleting `get_first_user_summary`. For Hermes, use `SELECT id, cwd/directory, started_at, last_activity_at/ended_at/updated_at FROM sessions`: no LIMIT 500, no edge-message queries. For Hermes JSONL, read only the header lines.
2. **Decide the project before reading content.** Map `directory`/`cwd` to a git root or registered folder, ignore temporary directories, and only call load for approved sessions.
3. **Extract only what is uploaded:**
   - User prompt: Text blocks of the turn's starting user message. For OpenCode, skip synthetic/ignored text.
   - Answer: Text from the last assistant message as described in §1.3 and §2.4.
   - Drop Thinking, Tool, Step, Patch and Event blocks.
4. **Add these upstream lacks:** detection of unfinished turns, filtering of child sessions, and `busy_timeout`.
