# Project Permission Resolution

Plugin 2.1 uses `/v2/project-scope` and `/v2/project-scope/resolve`.
The server must be deployed before installing this plugin. Plugin 2.0 keeps
using the existing v1 routes; its minimum version, binding, permissions and
schedule are not changed by this release.

## Separate Plugin Editions

| Edition | Source | Workspace | Distribution |
| --- | --- | --- | --- |
| 2.0.0 | `plugins/partner-report` | `@partner-report/plugin` | Existing team marketplace and default installer |
| 2.1.0 | `plugins/v2/partner-report` | `@partner-report/plugin-v2` | Separate opt-in release archive |

The existing marketplace remains pinned to the 2.0.0 source directory. Do not
replace its manifest, skill or bundled runtime with v2 files. Build 2.1.0 with
`npm run plugin:build:v2`; the default `npm run plugin:install` still selects
2.0.0. Both editions retain the plugin name `partner-report` and the same stable
data directory so an explicitly selected upgrade can retain the existing binding.
They are alternative client editions, not two collectors to enable concurrently
on the same machine. Keep their source trees and release archives separate.

The server runs both API versions concurrently. Changing the source packaging
does not change the deployed API or any member's current permissions.

## Identity And Decisions

The v2 policy supplies a durable, per-instance anonymous identity namespace.
The plugin hashes the normalized Git remote, or the filesystem identity when
no remote is available. Raw paths and Git remotes remain local. Its existing
local salt and key algorithm remain available to match legacy records.

The server resolves an existing key or a registered identity to the canonical
permission key. New identities become pending. A reused key with a contradictory
identity gets a separate deterministic pending record; unrelated grants remain
unchanged. Pending records are reused without repeated candidate-change events.
Name matching does not establish authorization.

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

1. Back up the database and apply migration 0036.
2. Deploy the API with both route versions.
3. Verify v1 behavior and the team's unchanged minimum plugin version.
4. Install 2.1 only for the affected member, retaining their stable data directory.
5. Run ordinary collection (`force: false`). Do not reset the binding or schedule.

Swift's September 7 review initially produced 15 entries. At the user's explicit
request, the platform subsequently restored the complete pre-conflict snapshot
`7557442c-3547-4575-a093-39d35b48dcb3`: 20 entries, 9 allowed, 11 denied,
0 pending, policy version 22. Keys, names, decisions, effective times, and review
times match that snapshot exactly. The replaced 15 entries remain in rollback
snapshot `66ddbd35-9f06-4481-947a-f3d33bef0ca2`; the restored state is also backed
up as `6061d5e2-273f-411b-9cee-e877fcd21a56`. This was an explicitly requested
administrative restore. Automatic resolution still preserves live decisions
and never matches permissions by display name. A deleted/recreated non-Git
project may have a new filesystem identity and require individual confirmation.

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
2.0 source, marketplace entry, and default installer remain unchanged. Swift's
production policy remains at 20 entries, and team minimum plugin versions remain
unchanged. These checks do not constitute a collection run on Swift's computer;
his optional 2.1 installation and device collection remain unverified.
