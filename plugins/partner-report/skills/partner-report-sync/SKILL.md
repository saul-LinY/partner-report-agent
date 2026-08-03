---
name: partner-report-sync
description: Bind this Codex installation to a Partner by Admin-issued code, automatically configure daily collection at 13:00 Asia/Shanghai, extract complete project-session turns, upload local structured facts, or inspect collection status. Use when the user asks to connect Partner Report, configure the scheduled task, collect or sync sessions, or check plugin status.
---

# Partner Report Sync

This Plugin only performs first-stage local collection. It reads eligible Codex Sessions, keeps complete user-question plus final-answer Turns, uses local Codex to extract bounded structured Facts, and uploads those Facts. Cross-Session aggregation, Work Item generation, edits, and Report generation run in the data platform.

The Partner never configures a model in this Plugin. The Codex Scheduled task and the Plugin's isolated extraction jobs both use `gpt-5.6-sol` with `medium` reasoning. Extraction still forces an ephemeral read-only run with Hooks, rules, tools, Apps, other Plugins, web search, MCP servers, and multi-agent execution disabled.

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

After a successful connection, immediately use the official Codex Scheduled task capability in the current Codex desktop chat to create or update exactly one task with this configuration:

- Name: `Partner Report daily collection`
- Destination: standalone task; start a new chat for every run
- Project: none
- Schedule: `RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=0`
- Timezone: `Asia/Shanghai` (Beijing time)
- Model: `gpt-5.6-sol`
- Reasoning effort: `medium`
- Notifications: failures only
- Prompt: `Use $partner-report-sync to run daily-collect and return only the safe collection summary.`

Find an existing task by the exact name and update it instead of creating a duplicate. Creating or updating this task is a required continuation of Connect: do not merely relay the configuration or ask the user to create it manually. Confirm setup only after both binding and task configuration succeed. If the current Codex surface cannot manage Scheduled tasks, report that limitation and provide the exact configuration above without silently substituting defaults.

Scheduled tasks are owned by the official Codex surface, not by this CLI. Do not create a lifecycle Hook, project-scoped task, current-chat task, worktree, or background Runner.

## Daily Collect

When invoked with `daily-collect`, run exactly one bounded cycle:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" daily-collect
```

The CLI maps a Session to a project using the longest configured project-root path. A Session opened in any descendant folder belongs to that same project. Sessions outside every configured root are excluded.

At the daily 13:00 run, a Turn whose model answer is still running is skipped without advancing its cursor. It will be eligible in a later manual or daily run after a final answer exists. Other complete Turns in the same Session remain eligible.

Relay only the returned counts, period key, safe warning codes, and sync state. Never expose local extraction input, Fact evidence bodies, tokens, or raw Session text.

## Manual Collection

For an Admin-requested recovery or explicit catch-up, run:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" daily-collect --force
```

`--force` rebuilds eligible complete-turn ranges and should not be used for ordinary daily operation.

## Status

When the user only asks about health, run:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" status
```

Report whether the Plugin is connected, its version, last scan/sync/collection timestamps, pending local jobs, coverage counts, and the last safe error code.

## Local Extraction Contract

The bundled CLI runs isolated `codex exec` jobs against a JSON schema. It passes only Session ID, project mapping, complete Turn IDs, user prompts, final answers, and extraction policy. Each accepted Session revision advances its cursor only after the server accepts the upload. A completed Fact requires explicit evidence from a complete Turn. Uncertain progress stays uncertain.
