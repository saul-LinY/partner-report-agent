---
name: partner-report-sync
description: Connect a local Codex device to Partner Report, incrementally extract structured work facts from eligible Codex sessions, sync validated facts, and execute pending Work Item aggregation or individual Report generation jobs. Use when the user asks to connect, sync, rescan, check status, aggregate work items, or generate/regenerate a Partner Report.
---

# Partner Report Sync

Run or inspect the local Partner Report pipeline without a separate OpenAI API key. Raw Codex turns are read locally and never uploaded. The Plugin stores only a bounded input containing Turn IDs, user prompts, and `final_answer` messages under `PLUGIN_DATA`; only schema-validated facts and aggregation results go to the Partner Report API.

For this MVP, produce AI results only while running `gpt-5.6-sol`. If the active runtime explicitly reports another model, stop before completing an extraction or remote Agent Job and explain the mismatch.

## Resolve The CLI

`PLUGIN_ROOT` and `PLUGIN_DATA` are injected into plugin Hook commands, not into a normal Skill conversation. Do not query or require those environment variables here.

Before the first command in this Skill, run:

```bash
codex plugin list --json
```

Find the installed and enabled entry whose `pluginId` is `partner-report@partner-report-marketplace`. Use its absolute `source.path` as `PLUGIN_PATH`. Verify that:

- `<PLUGIN_PATH>/.codex-plugin/plugin.json` has `name: "partner-report"`.
- `<PLUGIN_PATH>/dist/cli.mjs` exists.

Then substitute that exact absolute path into commands. For example:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" status
```

If there is no installed and enabled matching entry, report that the Plugin is unavailable and ask the user to install or enable it. Never guess a repository path, search transcript files, or use `transcript_path` as a fallback.

## Connect A Device

Use the server URL explicitly requested by the user. If the user did not provide one, ask for the Partner Report data platform API URL before connecting. Do not assume localhost. Run:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" connect --server <SERVER_URL>
```

The CLI also accepts `PARTNER_REPORT_SERVER_URL` when `--server` is omitted. Remote servers must use HTTPS. Loopback HTTP is supported for local development; `--allow-insecure-http` exists only for an explicitly requested private test environment.

Relay the returned `verificationUri` and `userCode`. Keep the command alive while the Partner approves the code in the Web workspace. Tokens are stored in macOS Keychain by default; never print or request either token.

On macOS, the command may return `runnerStartPending: "NEXT_TRUSTED_HOOK"`. This is expected: the next trusted `Stop` or `SessionEnd` Hook receives the official writable Plugin data directory, restores the non-secret binding configuration from Keychain, and starts the Runner. Do not start a second Runner manually.

Binding stores the normalized server URL in the local Plugin configuration and starts the single-instance local Runner. All later heartbeats, Fact batches, job leases, and job results use that saved URL. A later Plugin upgrade reuses the same `PLUGIN_DATA`, Plugin Instance, server URL, and Keychain credentials. If the data platform moves to a different URL, reconnect to the new URL so the new server issues its own credentials; never edit `config.json` to point old credentials at another server.

## Normal Automatic Operation

Do not ask the Partner to run the extraction pipeline after every conversation. `Stop` and `SessionEnd` only update local activity state. The Runner checks every five minutes, waits until a Session has had no new Turn for the Team quiet period (120 minutes by default), then performs extraction, Fact sync, and heartbeat automatically. These ordinary cycles only accumulate structured facts for the open week; they do not create Work Items or a Report.

At the weekly `cutoff_at`, the central Worker closes the period and enqueues exactly one `AGGREGATE_WORK_ITEMS` job per Partner with eligible facts. The Runner leases that job and returns project cards. Those cards then enter the first Partner review in the data platform. Only when the Partner completes that review does the server enqueue `GENERATE_INDIVIDUAL_REPORT`; after the Runner generates it, the Report enters a second Partner review in the data platform. Feishu and Monitor delivery are not part of the current path.

For health or progress, run `status`. For an explicit immediate sync request, run one bounded automatic cycle and bypass the quiet window:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" run-once --force
```

Report the safe summary returned by the command. Do not expose raw Session input or generated Evidence bodies. Use the manual recovery steps below only when the automatic cycle fails and the user asks to diagnose or recover it.

## Manual Recovery Pipeline

Follow the order exactly. A failed step stays local and must not be skipped.

### 1. Prepare Incremental Session Jobs

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" prepare
```

The CLI uses stable `thread/list` and `thread/read` with `includeTurns`. It applies Session exclusion, path exclusion, path inclusion, project mapping, period, and relevance filters in that order. Session ID selects the stored Cursor and Turn ID skips the accepted history. Every selected Turn is reduced to `userPrompt` and the last `agentMessage` whose phase is `final_answer`; commentary, reasoning, commands, tools, file changes, and code details are discarded before model execution. Never read `transcript_path` or rollout JSONL files.

For an explicit deep rescan, use `prepare --force`. Do not use force for an ordinary run.

### 2. Extract Every Local Job

Run `next-local` until it returns `{"status":"empty"}`:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" next-local
```

For each ready job:

1. Read only the returned `inputPath`.
2. Create a JSON result at the returned `resultPath`.
3. Validate it by running:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" complete-local --job-id JOB_ID --result RESULT_PATH
```

The result is one `SessionFactUpload` object:

- Copy `sessionId`, `sourceRevision`, `sourceHash`, `fromTurnId`, `toTurnId`, and `observedAt` from the input session.
- Treat `userPrompt` as task intent and `assistantFinal` as the only outcome/progress source. Do not infer implementation details that are not present in those fields.
- Set `status` to `extracted` and return zero or more `facts`.
- Each fact must match `SessionWorkFactV1` and carry the input's exact `production` object.
- Use stable fact IDs derived from Session, revision, and an index. Do not invent UUIDs that imply server ownership.
- Describe work performed, outcomes, decisions, blockers, impact, status changes, and next steps. Do not summarize casual conversation or the reporting workflow itself.
- A `completed` fact must have `completionSupport: "evidence"` and at least one evidence reference.
- Evidence always includes `turnId`, `occurredAt`, and `excerptHash`. Include `excerpt` only when `evidenceExcerptEnabled` is true, and never exceed 240 characters.
- Never return a full prompt, response, command output, transcript, credential, access token, private key, or sensitive environment value.
- If content is uncertain, preserve the uncertainty. Do not upgrade a discussion or plan to completed.

When validation fails, correct the JSON and repeat `complete-local`. The Cursor does not move at this stage.

### 3. Sync Facts

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" sync
```

Repeat only if the command reports a retryable failure or a partial rejection that has been corrected. The CLI reuses the same idempotency key after an ambiguous network failure. It advances each Session Cursor only after the API accepts that Session revision.

### 4. Execute Remote Agent Jobs

Run `lease-next` until it returns empty:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" lease-next
```

Read the returned `inputPath`, write the structured result to `resultPath`, then complete the lease:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" complete-remote --job-id JOB_ID --result RESULT_PATH
```

Complete leases promptly; they expire after 15 minutes. On an unrecoverable local generation error, explicitly fail the lease:

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" fail-remote --job-id JOB_ID --error-code LOCAL_AGENT_FAILED --message "Concise safe message"
```

Do not put raw Session content in error messages.

#### Aggregate Work Items

For `AGGREGATE_WORK_ITEMS`:

- Verify `aggregationMode` is `weekly_report`; ordinary Fact sync must never create or execute this job.
- Return `AggregationResultV1` with the exact production metadata.
- Account for every input Fact exactly once: place it in one group or in `unassignedFactIds`.
- Merge only facts that clearly describe the same work thread. Keep low-confidence relationships independent.
- Group by project and overall task progress, not by filenames or implementation steps. Facts without a configured project should normally become independent groups without `projectId`; reserve `unassignedFactIds` for facts that cannot form a usable work item.
- Respect provided project IDs. Never invent a project ID.
- A completed group must remain supported by source facts with completion evidence.
- Importance scores are independent 0-5 components; do not inflate every component together.

#### Generate An Individual Report

For `GENERATE_INDIVIDUAL_REPORT` or `REGENERATE_INDIVIDUAL_REPORT`:

- Read only the approved Work Item Snapshot, Coverage, template, and preferences in the job input.
- Return `IndividualReportResultV1` with the exact production metadata.
- Include each required section exactly once: `summary`, `achievements`, `project_progress`, `risks`, `next_priorities`, `coordination`, and `coverage`.
- Every factual claim must cite one or more allowed Work Item IDs.
- Preferences may change language, length, order, emphasis, and technical detail, but never change facts.
- Include Coverage limitations plainly. Do not imply excluded, failed, or unread Sessions were reviewed.

#### Rescan Or Reanalyze

For `RESCAN_SESSIONS` or `REANALYZE_SESSIONS`, run `prepare --force`, complete local extraction and `sync`, then write:

```json
{ "completed": true, "batchIds": [] }
```

Populate `batchIds` with successful batch IDs returned during this run.

### 5. Send Final Heartbeat

```bash
node "<PLUGIN_PATH>/dist/cli.mjs" heartbeat
```

Report the final local status to the user. Do not expose tokens, Evidence bodies, or raw Session text.

## Status Only

When the user only asks for health or progress, run `status`. This is local and does not mutate server business state.
