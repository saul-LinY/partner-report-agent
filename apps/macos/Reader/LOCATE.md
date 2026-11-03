# Metadata discovery CLI

`cc-session-reader --locate input.json output.json` processes one array per invocation:

```json
[{"provider":"codex","source":"/absolute/path/rollout.jsonl.zst"}]
```

The output has one row per request, in request order. `provider` and `source` are
echoed exactly, without canonicalization. Successful rows contain string
`session_id` and `cwd`; unsuccessful rows contain null for both. Status values:

- `located`: an explicit session ID and absolute project directory were found.
- `excluded`: explicit child/subagent metadata was found.
- `metadata_error`: missing, conflicting, malformed, or unreadable metadata.
- `unsupported`: provider is not supported by this discovery command.

Supported inputs are Codex JSONL / JSONL.zst, Claude JSONL, Pi/OMP session headers
(including OMP's leading title slot), Hermes `session`/`init` JSONL headers, and
OpenCode legacy `storage/session/<project>/<id>.json` metadata files. Hermes
JSONL may use a `.json` extension. JSON arrays and body-derived locations are
rejected. Metadata objects/lines are limited to 8 MiB (8,388,608 bytes, including
the line ending for JSONL), matching the former Swift discovery budget. Larger
records return `metadata_error` without including their contents in diagnostics.
Claude discovery examines at most 20 leading records. Discovery does not deserialize title/prompt/content
fields and stops once a valid header has been found.

Nested `payload`, `message`, `info`, `custom`, and `path` fields are projected
only when they are maps. Primitive/array body values are skipped; known metadata
fields inside maps (such as `cwd`) retain strict types. Claude CLI identity is
its native `sessionId`; SDK/backend `session_id` is not a CLI identity alias.

Authorized JSONL reads tolerate an incomplete final record only when it has no
newline and JSON parsing reports unexpected EOF, including a partial UTF-8
character inside an unfinished string. Complete malformed lines, invalid
metadata types, and valid final records with foreign identity/project metadata
remain rejected. An incomplete header alone never establishes a location.

The command is silent and writes output with Unix mode 0600, including when
replacing an existing output file. Diagnostics never include parsed JSON values.

For authorized extraction, continue to pass the original OpenCode session JSON
path in `Job.source`; the reader validates its metadata, message/part identities
and project paths before dispatching to the retained legacy message parser.
Hermes file extraction checks all records' metadata before projecting messages.
No new public `Job` fields are required. Without native finish evidence, Hermes
turns remain incomplete. Antigravity stores lacking `status` or `not_fully_idle`
retain questions as incomplete, while still requiring workspace/parent metadata.

This command does not discover SQLite, Grok or Antigravity metadata; the host
continues to enumerate those stores. Relative or missing project paths are not
inferred from filenames, enclosing directories, titles, prompts, or content.
