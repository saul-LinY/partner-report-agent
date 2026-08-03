---
name: partner-report-sync
description: Bind this Codex installation to a Partner by Admin-issued code, collect complete project-session turns every Friday at 13:00, extract local structured facts, upload them to Partner Report, or inspect collection status. Use when the user asks to connect Partner Report, configure the weekly task, collect or sync sessions, or check plugin status.
---

# Partner Report Sync

This Plugin only performs first-stage local collection. It reads eligible Codex Sessions, keeps complete user-question plus final-answer Turns, uses local Codex to extract bounded structured Facts, and uploads those Facts. Cross-Session aggregation, Work Item generation, edits, and Report generation run in the data platform.

Never upload raw transcripts, reasoning, commentary, commands, tool calls, file changes, credentials, or an incomplete Turn. A Turn is complete only when both the user prompt and an `agentMessage` with phase `final_answer` exist and the Turn was not cancelled, failed, interrupted, or still in progress.

## Resolve The Installed CLI

Run:

```bash
codex plugin list --json
```

Find the enabled Plugin whose name is `partner-report`, take its absolute `source.path` as `PLUGIN_PATH`, and verify these files exist:

- `<PLUGIN_PATH>/.codex-plugin/plugin.json`
- `<PLUGIN_PATH>/dist/cli.mjs`

Never guess a repository path or read transcript/rollout JSONL files directly.

## Connect

Ask for the data-platform API URL and the binding code created by Admin for the Partner's work email. Then run:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" connect --server <SERVER_URL> --binding-code <BINDING_CODE>
```

Remote URLs require HTTPS. Loopback HTTP is supported for local development. Tokens go to macOS Keychain by default and must never be printed. One email may have multiple binding codes and Plugin instances; the server aggregates all accepted Facts into the same Partner.

After a successful connection, ensure the user has one project-scoped Codex Scheduled task in the desktop app or web app:

- Name: `Partner Report weekly collection`
- Schedule: every Friday at 13:00 in the Team timezone
- Prompt: `Use $partner-report-sync to run weekly-collect and return only the safe collection summary.`

Scheduled tasks are managed by official Codex surfaces, not by this CLI. Do not create a lifecycle Hook or a background Runner.

## Weekly Collect

When invoked with `weekly-collect`, run exactly one bounded cycle:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" weekly-collect
```

The CLI maps a Session to a project using the longest configured project-root path. A Session opened in any descendant folder belongs to that same project. Sessions outside every configured root are excluded.

At Friday 13:00, a Turn whose model answer is still running is skipped without advancing its cursor. It will be eligible in a later manual or weekly run after a final answer exists. Other complete Turns in the same Session remain eligible.

Relay only the returned counts, period key, safe warning codes, and sync state. Never expose local extraction input, Fact evidence bodies, tokens, or raw Session text.

## Manual Collection

For an Admin-requested recovery or explicit catch-up, run:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" weekly-collect --force
```

`--force` rebuilds eligible complete-turn ranges and should not be used for ordinary weekly operation.

## Status

When the user only asks about health, run:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" status
```

Report whether the Plugin is connected, its version, last scan/sync/collection timestamps, pending local jobs, coverage counts, and the last safe error code.

## Local Extraction Contract

The bundled CLI runs isolated `codex exec` jobs against a JSON schema. It passes only Session ID, project mapping, complete Turn IDs, user prompts, final answers, and extraction policy. Each accepted Session revision advances its cursor only after the server accepts the upload. A completed Fact requires explicit evidence from a complete Turn. Uncertain progress stays uncertain.
