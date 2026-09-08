# Project Permission Resolution

Plugin 2.1 uses `/v2/project-scope` and `/v2/project-scope/resolve`.
The server must be deployed before installing this plugin. Plugin 2.0 keeps
using the existing v1 routes; its minimum version, binding, permissions and
schedule are not changed by this release.

## Separate Plugin Editions

| Edition | Source                      | Workspace                   | Distribution                                                           |
| ------- | --------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| 2.0.0   | `plugins/partner-report`    | `@partner-report/plugin`    | Retained source and release archive; existing devices remain supported |
| 2.1.0   | `plugins/v2/partner-report` | `@partner-report/plugin-v2` | Existing team marketplace and default installer                        |

The existing marketplace now points to the separate 2.1.0 source directory.
The original 2.0.0 manifest, skill and bundled runtime remain intact. Build 2.1.0
with `npm run plugin:build:v2`; `npm run plugin:install` reads the marketplace
entry to select and build the published edition. Both editions retain the plugin
name `partner-report` and the same stable
data directory so an explicitly selected upgrade can retain the existing binding.
They are alternative client editions, not two collectors to enable concurrently
on the same machine. Keep their source trees and release archives separate.

Members using the existing Git marketplace can update with the normal commands:

```bash
codex plugin marketplace upgrade partner-report-marketplace
codex plugin add partner-report@partner-report-marketplace
```

For a local repository marketplace, pull the latest code, install dependencies
with `npm ci`, and run `npm run plugin:install`. The installer registers that
local repository before installing so it validates the same source it built.
Restart Codex and open a new conversation after updating. Do not reconnect or
delete the stable data directory. Publishing this entry does not run an update
command on any member's device; devices remaining on 2.0 use the supported v1
flow. There is no separate v2 marketplace or special v2 installer command.

The server runs both API versions concurrently. Changing the source packaging
does not change the deployed API or any member's current permissions.

## Identity And Decisions

The v2 policy supplies a durable, per-instance anonymous identity namespace.
The plugin hashes the normalized Git remote, or the filesystem identity when
no remote is available. Raw paths and Git remotes remain local. Its existing
local salt and key algorithm remain available to match legacy records.

For v2 resolution, the server first matches the exact full display name within
the authenticated tenant, team and member. This is an explicit business rule:
one member cannot have two different projects with the same name. Paths, Git
identities and anonymous keys may change without prompting another review for
that name. Different members, case variants and similar names are not merged by
name. Raw paths and Git remotes are not uploaded by existing 2.1 clients; the
server uses the identity keys they already provide for subsequent matching.

If no name matches, a registered anonymous identity or compatible existing key
can still identify a renamed project. A reused key with a contradictory identity
gets a separate deterministic pending record. Genuinely new projects remain
pending until reviewed. Repeated discovery of the same pending project does not
create additional candidate-change events.

Duplicate live permissions retain the earliest local key and the latest explicit
review decision, including its effective time. A tie between allow and deny
keeps the denial. A newer administrative request for reapproval remains pending.
The server snapshots permissions before removing duplicates and records
`project_scope.name_deduplicated` audit events. Persistent scope and identity
aliases prevent old keys from recreating the same-name duplicate.

Historical backup recovery requires an exact anonymous key and a recorded
decision. A current record, including an explicit pending review or denial,
always takes precedence. Every restored record retains its original decision
time and writes a `project_scope.permission_restored` audit event. The backup
tables are retained. Recovery does not impersonate a Feishu reviewer.

The plugin applies central decisions to local mappings, retires obsolete local
aliases, and rechecks authorization before reading session content. It does not
invoke v1 bootstrap. Missing local data or protocol upgrades invalidate unfinished
runs, but preserve successful collection state. If the server lacks v2 support,
the plugin stops rather than falling back to destructive bootstrap.

## Rollout

1. Back up the database and apply the pending migrations, including
   `0038_project_scope_aliases.sql` for member name deduplication.
2. Deploy the API with both route versions.
   Rebuild and deploy the web image as well: its Nginx gateway must forward both
   `/v1/` and `/v2/` to the API. Checking port 4310 alone does not verify the
   public route. Run `node scripts/check-public-api.mjs https://platform.laien.org`
   after deployment; all checks must return API JSON, never the SPA HTML page.
3. Verify v1 behavior and the team's unchanged minimum plugin version.
4. Members already running 2.1 do not need another plugin update for member name
   deduplication. Members on 2.0 retain the v1 flow. Installing 2.1 is only needed
   when moving an old client to v2 recovery.
5. Run ordinary collection (`force: false`). Do not reset the binding or schedule.

Swift's September 7 review initially produced 15 entries. At the user's explicit
request, the platform subsequently restored the complete pre-conflict snapshot
`7557442c-3547-4575-a093-39d35b48dcb3`: 20 entries, 9 allowed, 11 denied,
0 pending, policy version 22. Keys, names, decisions, effective times, and review
times match that snapshot exactly. The replaced 15 entries remain in rollback
snapshot `66ddbd35-9f06-4481-947a-f3d33bef0ca2`; the restored state is also backed
up as `6061d5e2-273f-411b-9cee-e877fcd21a56`. This was an explicitly requested
administrative restore. At that time automatic resolution did not use names;
the September 8 backend change adds the member-scoped rule above.

The user later confirmed that three pairs in the restored snapshot were duplicate
project detections. Those pairs were deduplicated while retaining each pair's
newer reviewed key and decision. Swift now has 17 entries, 7 allowed, 10 denied,
0 pending, policy version 23 at that point. The pre-cleanup snapshot is
`85b0f260-f0f3-49d5-954e-cbccf6279d39`, and the cleaned snapshot is
`fc06a8b6-8429-4bae-b8e6-ea9cd6dabf48`.

## Backend-only deduplication, September 8

Cleanup runs inside the v2 resolve transaction, including for projects outside
the current incremental scan. GET requests do not remove keys underneath an
ongoing collection. The returned full policy and existing `bindings` let the
unchanged 2.1 plugin replace its local duplicate entries during the next normal
collection. Users should not delete or edit `project-scope.json` for this rollout.

This also handles a previously reviewed project that was never enrolled in the
2.1 identity table before local data was lost. Same-name candidate batches
produce a single permission entry and one review event only if the project is
genuinely new. Version checks, rollback, and member isolation remain enforced.

Where duplicate permissions already reference different formal projects, the
server records member-scoped project redirects. Future uploads and future weekly
card generation use one canonical project, including when grouping facts with
old project IDs. Existing facts and previously generated or delivered cards are
not rewritten. Deploy the API and worker together after the additive migration.

Regression tests use an isolated PostgreSQL database and the unmodified 2.1
`applyScopeResolution` and discovery functions. They cover local duplicate
cleanup, repeated sync, missing legacy identity enrollment, denial preservation,
new-project review, administrative reapproval, member isolation, rollback, and
formal-project/card grouping. The v1 registrar and both plugin source trees are
unchanged by this backend change.

The old plugin remains supported, but still has its original conflict behavior.
Only upgrading that client enables v2 recovery. Rolling back the API requires
rolling back v2 clients first; the additive database migration can remain.

## Compatibility verification, September 7

Tests used a disposable PostgreSQL 17 database, with no production test writes.
The full suite passed 593 tests with `RUN_DB_TESTS=1`. Three additional
coexistence tests passed, and the three project-description integration tests
passed separately with `RUN_INTEGRATION_TESTS=1`: 599 passing tests in total.
All workspace type checks passed, including both plugin editions.

The new coexistence tests exercise authenticated v1 and v2 requests from two
members in the same team, using identical project keys with opposite decisions.
Concurrent requests preserve member isolation. Scanning 15 of 20 reviewed
projects preserves all 20 entries and creates no repeat approval event. Legacy
bootstrap and subsequent registration still work and leave the modern member
unchanged. Concurrent v2 updates reject stale versions and succeed on retry.
Existing resolution tests cover backup recovery, missing local keys, conflicting
identities, denial preservation, and authentication boundaries.

Production API source hashes match the tested permission modules. The original
2.0 source and team minimum plugin versions remain unchanged. The marketplace
and installer now select 2.1 for members who update. These checks do not constitute
a collection run on Swift's computer; his 2.1 installation and device collection
remain unverified.
