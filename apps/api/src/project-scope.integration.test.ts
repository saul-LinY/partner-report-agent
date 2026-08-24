import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, type DomainActor } from "./common.js";
import {
  beginProjectScopeBootstrap,
  decideProjectScopes,
  registerProjectScopeCandidates,
} from "./project-scope.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

suite("project scope persistence", () => {
  const fixture = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    partnerId: randomUUID(),
    pluginInstanceId: randomUUID(),
    periodId: randomUUID(),
  };
  const periodEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000);
  const actor: DomainActor = {
    actorType: "plugin",
    actorId: fixture.pluginInstanceId,
    userId: null,
    tenantId: fixture.tenantId,
    teamId: fixture.teamId,
    partnerId: fixture.partnerId,
  };
  const identity = {
    tenantId: fixture.tenantId,
    teamId: fixture.teamId,
    partnerId: fixture.partnerId,
    pluginInstanceId: fixture.pluginInstanceId,
  };

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name) values (${fixture.tenantId}, 'Scope Tenant')`;
      await tx`insert into teams (id, tenant_id, name) values (${fixture.teamId}, ${fixture.tenantId}, 'Scope Team')`;
      await tx`insert into partners (id, tenant_id, team_id, email, display_name) values (${fixture.partnerId}, ${fixture.tenantId}, ${fixture.teamId}, ${`scope-${fixture.partnerId}@local.test`}, 'Scope Partner')`;
      await tx`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${fixture.pluginInstanceId}, ${fixture.tenantId}, ${fixture.teamId},
          ${fixture.partnerId}, 'Scope Device', '0.4.0', 'access', 'refresh',
          ${new Date(Date.now() + 60_000).toISOString()}
        )
      `;
      await tx`
        insert into report_periods (
          id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at,
          submission_deadline_at, timezone, status
        ) values (
          ${fixture.periodId}, ${fixture.tenantId}, ${fixture.teamId}, 'scope-period',
          ${new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()},
          ${periodEnd.toISOString()}, ${periodEnd.toISOString()},
          ${periodEnd.toISOString()}, 'Asia/Shanghai', 'open'
        )
      `;
    });
  });

  afterAll(async () => {
    await sql.begin(async (tx) => {
      await tx`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
      await tx`delete from audit_events where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_entries where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_policies where tenant_id = ${fixture.tenantId}`;
      await tx`delete from report_periods where tenant_id = ${fixture.tenantId}`;
      await tx`delete from plugin_instances where id = ${fixture.pluginInstanceId}`;
      await tx`delete from partners where id = ${fixture.partnerId}`;
      await tx`delete from teams where id = ${fixture.teamId}`;
      await tx`delete from tenants where id = ${fixture.tenantId}`;
    });
  });

  it("versions candidates and applies first versus later approvals correctly", async () => {
    const firstKey = "a".repeat(64);
    const first = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      initialDiscovery: true,
      candidates: [
        { scopeKey: firstKey, displayName: "first-project", sessionCount: 2 },
        {
          scopeKey: "d".repeat(64),
          displayName: "single-session-project",
          sessionCount: 1,
        },
      ],
    });
    expect(first).toMatchObject({
      version: 2,
      initialized: false,
      entries: [{ scopeKey: firstKey }, { scopeKey: "d".repeat(64) }],
    });
    const scopeEvents = await sql<
      Array<{ event_type: string; aggregate_id: string; payload: unknown }>
    >`
      select event_type, aggregate_id, payload
      from outbox_events
      where tenant_id = ${fixture.tenantId}
        and event_type = 'project_scope.candidates.changed'
    `;
    expect(scopeEvents).toEqual([
      {
        event_type: "project_scope.candidates.changed",
        aggregate_id: fixture.pluginInstanceId,
        payload: expect.objectContaining({
          partnerId: fixture.partnerId,
          periodKey: "scope-period",
          version: 2,
        }),
      },
    ]);
    const initialized = await decideProjectScopes(
      actor,
      fixture.pluginInstanceId,
      {
        baseVersion: first.version,
        decisions: [{ scopeKey: firstKey, decision: "allow" }],
      },
    );
    expect(initialized.initialized).toBe(true);
    expect(
      new Date(initialized.entries[0]!.effectiveFrom!).getTime(),
    ).toBeLessThanOrEqual(Date.now() + 1_000);

    const legacySingleKey = "e".repeat(64);
    await sql`
      insert into project_scope_entries (
        id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
        display_name, status, first_seen_period_key, session_count
      ) values (
        ${randomUUID()}, ${fixture.tenantId}, ${fixture.teamId},
        ${fixture.partnerId}, ${fixture.pluginInstanceId}, ${legacySingleKey},
        'legacy-single-session', 'pending', 'scope-period', 1
      )
    `;
    const preserved = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      candidates: [],
    });
    expect(preserved.version).toBe(initialized.version);
    expect(
      preserved.entries.some((entry) => entry.scopeKey === legacySingleKey),
    ).toBe(true);

    const laterKey = "b".repeat(64);
    const laterSingleKey = "f".repeat(64);
    const later = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      candidates: [
        { scopeKey: laterKey, displayName: "later-project", sessionCount: 2 },
        {
          scopeKey: laterSingleKey,
          displayName: "later-single-project",
          sessionCount: 1,
        },
      ],
    });
    expect(
      later.entries.some((entry) => entry.scopeKey === laterSingleKey),
    ).toBe(true);
    const decided = await decideProjectScopes(actor, fixture.pluginInstanceId, {
      baseVersion: later.version,
      decisions: [{ scopeKey: laterKey, decision: "allow" }],
    });
    const laterEntry = decided.entries.find(
      (entry) => entry.scopeKey === laterKey,
    )!;
    expect(new Date(laterEntry.effectiveFrom!).getTime()).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );

    await expect(
      decideProjectScopes(actor, fixture.pluginInstanceId, {
        baseVersion: later.version,
        decisions: [{ scopeKey: laterKey, decision: "deny" }],
      }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    } satisfies Partial<ApiError>);

    const reset = await beginProjectScopeBootstrap(identity, {
      baseVersion: decided.version,
      reason: "local_scope_invalid",
    });
    expect(reset).toMatchObject({
      version: decided.version + 1,
      initialized: false,
      initializedAt: null,
      entries: [],
    });
    await expect(
      beginProjectScopeBootstrap(identity, {
        baseVersion: decided.version,
        reason: "local_scope_missing",
      }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    } satisfies Partial<ApiError>);

    const rediscovered = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      candidates: [
        {
          scopeKey: "c".repeat(64),
          displayName: "rediscovered-project",
          sessionCount: 3,
        },
      ],
    });
    expect(rediscovered).toMatchObject({
      version: reset.version + 1,
      initialized: false,
      entries: [
        {
          scopeKey: "c".repeat(64),
          status: "pending",
        },
      ],
    });
    const reapproved = await decideProjectScopes(
      actor,
      fixture.pluginInstanceId,
      {
        baseVersion: rediscovered.version,
        decisions: [{ scopeKey: "c".repeat(64), decision: "allow" }],
      },
    );
    expect(reapproved).toMatchObject({
      version: rediscovered.version + 1,
      initialized: true,
      entries: [
        {
          scopeKey: "c".repeat(64),
          status: "allowed",
        },
      ],
    });
    expect(
      new Date(reapproved.entries[0]!.effectiveFrom!).getTime(),
    ).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("renames the unique central project for an existing allowed scope", async () => {
    const scopeKey = "9".repeat(64);
    const projectId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`
        insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids)
        values (${projectId}, ${fixture.tenantId}, ${fixture.teamId}, 'legacy-name',
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
      `;
      await tx`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
          display_name, status, effective_from, first_seen_period_key, session_count
        ) values (
          ${randomUUID()}, ${fixture.tenantId}, ${fixture.teamId}, ${fixture.partnerId},
          ${fixture.pluginInstanceId}, ${scopeKey}, 'legacy-name', 'allowed', now(),
          'scope-period', 1
        )
      `;
    });
    try {
      await registerProjectScopeCandidates(identity, {
        periodKey: "scope-period",
        candidates: [
          { scopeKey, displayName: "renamed-project", sessionCount: 2 },
        ],
      });
      const projects = await sql<
        Array<{ name: string; aliases: string[]; external_ids: string[] }>
      >`
        select name, aliases, external_ids from projects where id = ${projectId}
      `;
      expect(projects).toEqual([
        {
          name: "renamed-project",
          aliases: ["legacy-name"],
          external_ids: [`scope:${fixture.pluginInstanceId}:${scopeKey}`],
        },
      ]);
    } finally {
      await sql`delete from project_scope_entries where scope_key = ${scopeKey}`;
      await sql`delete from projects where id = ${projectId}`;
    }
  });

  it("attaches the stable scope identity during an upgrade without renaming", async () => {
    const scopeKey = "8".repeat(64);
    const projectId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`
        insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids)
        values (${projectId}, ${fixture.tenantId}, ${fixture.teamId}, 'upgrade-project',
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
      `;
      await tx`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
          display_name, status, effective_from, first_seen_period_key, session_count
        ) values (
          ${randomUUID()}, ${fixture.tenantId}, ${fixture.teamId}, ${fixture.partnerId},
          ${fixture.pluginInstanceId}, ${scopeKey}, 'upgrade-project', 'allowed', now(),
          'scope-period', 1
        )
      `;
    });
    try {
      await registerProjectScopeCandidates(identity, {
        periodKey: "scope-period",
        candidates: [
          { scopeKey, displayName: "upgrade-project", sessionCount: 2 },
        ],
      });
      const projects = await sql<
        Array<{ name: string; aliases: string[]; external_ids: string[] }>
      >`
        select name, aliases, external_ids from projects where id = ${projectId}
      `;
      expect(projects).toEqual([
        {
          name: "upgrade-project",
          aliases: [],
          external_ids: [`scope:${fixture.pluginInstanceId}:${scopeKey}`],
        },
      ]);
    } finally {
      await sql`delete from project_scope_entries where scope_key = ${scopeKey}`;
      await sql`delete from projects where id = ${projectId}`;
    }
  });
});
