import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, type DomainActor } from "./common.js";
import {
  beginProjectScopeBootstrap,
  decideProjectScopes,
  registerProjectScopeCandidates,
  reopenProjectScopeReview,
} from "./project-scope.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

suite("project scope persistence", () => {
  const fixture = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    userId: randomUUID(),
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
      await tx`insert into users (id, email, display_name, password_hash) values (${fixture.userId}, ${`scope-admin-${fixture.userId}@local.test`}, 'Scope Admin', 'test')`;
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
      await tx`delete from feishu_deliveries where tenant_id = ${fixture.tenantId}`;
      await tx`delete from feishu_partner_bindings where tenant_id = ${fixture.tenantId}`;
      await tx`delete from audit_events where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_backup_snapshots where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_entries where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_policies where tenant_id = ${fixture.tenantId}`;
      await tx`delete from plugin_binding_codes where tenant_id = ${fixture.tenantId}`;
      await tx`delete from report_periods where tenant_id = ${fixture.tenantId}`;
      await tx`delete from plugin_instances where id = ${fixture.pluginInstanceId}`;
      await tx`delete from partners where id = ${fixture.partnerId}`;
      await tx`delete from teams where id = ${fixture.teamId}`;
      await tx`delete from tenants where id = ${fixture.tenantId}`;
      await tx`delete from users where id = ${fixture.userId}`;
    });
  });

  it("requires Feishu review for initial and later discovered projects", async () => {
    const firstKey = "a".repeat(64);
    const secondKey = "d".repeat(64);
    const first = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      initialDiscovery: true,
      candidates: [
        { scopeKey: firstKey, displayName: "first-project", sessionCount: 2 },
        {
          scopeKey: secondKey,
          displayName: "single-session-project",
          sessionCount: 1,
        },
      ],
    });
    expect(first).toMatchObject({
      version: 2,
      initialized: false,
      entries: [
        { scopeKey: firstKey, status: "pending", effectiveFrom: null },
        { scopeKey: secondKey, status: "pending", effectiveFrom: null },
      ],
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
    await sql`
      update outbox_events set published_at = now()
      where tenant_id = ${fixture.tenantId}
        and event_type = 'project_scope.candidates.changed'
    `;
    await sql`
      insert into plugin_binding_codes (
        id, tenant_id, team_id, partner_id, code_hash, code_prefix,
        status, plugin_instance_id, created_by
      ) values (
        ${randomUUID()}, ${fixture.tenantId}, ${fixture.teamId},
        ${fixture.partnerId}, ${"b".repeat(64)}, 'PR-RETRY', 'connecting',
        ${fixture.pluginInstanceId}, ${fixture.userId}
      )
    `;
    await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      initialDiscovery: true,
      candidates: [
        { scopeKey: firstKey, displayName: "first-project", sessionCount: 2 },
        {
          scopeKey: secondKey,
          displayName: "single-session-project",
          sessionCount: 1,
        },
      ],
    });
    const reminderEvents = await sql<Array<{ event_type: string }>>`
      select event_type from outbox_events
      where tenant_id = ${fixture.tenantId}
        and event_type = 'project_scope.delivery.requested'
        and published_at is null
    `;
    expect(reminderEvents).toEqual([
      { event_type: "project_scope.delivery.requested" },
    ]);
    await expect(
      decideProjectScopes(actor, fixture.pluginInstanceId, {
        baseVersion: first.version,
        decisions: [{ scopeKey: firstKey, decision: "allow" }],
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_SCOPE_FEISHU_REVIEW_REQUIRED",
    } satisfies Partial<ApiError>);

    const feishuOpenId = `ou_${randomUUID()}`;
    await sql`
      insert into feishu_partner_bindings (
        id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
      ) values (
        ${randomUUID()}, ${fixture.tenantId}, ${fixture.teamId},
        ${fixture.partnerId}, 'scope-integration-app', ${feishuOpenId},
        'active', now()
      )
    `;
    const feishuActor: DomainActor = {
      ...actor,
      actorType: "feishu",
      actorId: feishuOpenId,
    };
    const initialized = await decideProjectScopes(
      feishuActor,
      fixture.pluginInstanceId,
      {
        baseVersion: first.version,
        decisions: [
          { scopeKey: firstKey, decision: "allow" },
          { scopeKey: secondKey, decision: "deny" },
        ],
      },
    );
    expect(initialized).toMatchObject({
      version: first.version + 1,
      initialized: true,
      entries: [
        { scopeKey: firstKey, status: "allowed" },
        { scopeKey: secondKey, status: "denied" },
      ],
    });
    expect(
      new Date(
        initialized.entries.find((entry) => entry.scopeKey === firstKey)!
          .effectiveFrom!,
      ).getTime(),
    ).toBeLessThanOrEqual(Date.now());

    const laterKey = "b".repeat(64);
    const later = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      candidates: [
        { scopeKey: laterKey, displayName: "later-project", sessionCount: 2 },
      ],
    });
    const laterEntry = later.entries.find(
      (entry) => entry.scopeKey === laterKey,
    )!;
    expect(later).toMatchObject({ initialized: true });
    expect(laterEntry).toMatchObject({
      status: "pending",
      effectiveFrom: null,
    });

    await expect(
      decideProjectScopes(actor, fixture.pluginInstanceId, {
        baseVersion: later.version,
        decisions: [{ scopeKey: laterKey, decision: "allow" }],
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_SCOPE_FEISHU_REVIEW_REQUIRED",
    } satisfies Partial<ApiError>);
    const laterApproved = await decideProjectScopes(
      feishuActor,
      fixture.pluginInstanceId,
      {
        baseVersion: later.version,
        decisions: [{ scopeKey: laterKey, decision: "allow" }],
      },
    );
    expect(laterApproved.entries).toContainEqual(
      expect.objectContaining({ scopeKey: laterKey, status: "allowed" }),
    );

    const adminActor: DomainActor = {
      ...actor,
      actorType: "web",
      actorId: fixture.userId,
      userId: fixture.userId,
      partnerId: null,
    };
    const reopened = await reopenProjectScopeReview(
      adminActor,
      fixture.pluginInstanceId,
      { baseVersion: laterApproved.version },
    );
    expect(reopened).toMatchObject({
      version: laterApproved.version + 1,
      initialized: false,
      initializedAt: null,
    });
    expect(reopened.entries).toHaveLength(3);
    expect(reopened.entries.every((entry) => entry.status === "pending")).toBe(
      true,
    );
    expect(
      reopened.entries.every((entry) => entry.effectiveFrom === null),
    ).toBe(true);
    const reapprovalBackups = await sql<
      Array<{
        reason: string;
        entry_count: number;
        allowed_count: number;
        denied_count: number;
      }>
    >`
      select reason, entry_count, allowed_count, denied_count
      from project_scope_backup_snapshots
      where plugin_instance_id = ${fixture.pluginInstanceId}
      order by created_at desc
      limit 1
    `;
    expect(reapprovalBackups).toEqual([
      {
        reason: "admin_reapproval",
        entry_count: 3,
        allowed_count: 2,
        denied_count: 1,
      },
    ]);
    const reapprovalEvents = await sql<Array<{ payload: any }>>`
      select payload from outbox_events
      where tenant_id = ${fixture.tenantId}
        and aggregate_id = ${fixture.pluginInstanceId}
        and event_type = 'project_scope.candidates.changed'
        and payload->>'reason' = 'admin_reapproval'
    `;
    expect(reapprovalEvents).toEqual([
      {
        payload: expect.objectContaining({
          partnerId: fixture.partnerId,
          periodKey: "scope-period",
          version: reopened.version,
          reason: "admin_reapproval",
        }),
      },
    ]);
    await expect(
      reopenProjectScopeReview(adminActor, fixture.pluginInstanceId, {
        baseVersion: reopened.version,
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_SCOPE_REVIEW_IN_PROGRESS",
    } satisfies Partial<ApiError>);

    const reapproved = await decideProjectScopes(
      feishuActor,
      fixture.pluginInstanceId,
      {
        baseVersion: reopened.version,
        decisions: reopened.entries.map((entry) => ({
          scopeKey: entry.scopeKey,
          decision: "allow" as const,
        })),
      },
    );

    const reset = await beginProjectScopeBootstrap(identity, {
      baseVersion: reapproved.version,
      reason: "local_scope_invalid",
    });
    expect(reset).toMatchObject({
      version: reapproved.version + 1,
      initialized: false,
      initializedAt: null,
      entries: [],
    });
    const bootstrapBackups = await sql<
      Array<{
        reason: string;
        entry_count: number;
        allowed_count: number;
      }>
    >`
      select reason, entry_count, allowed_count
      from project_scope_backup_snapshots
      where plugin_instance_id = ${fixture.pluginInstanceId}
      order by created_at desc, id desc
      limit 1
    `;
    expect(bootstrapBackups).toEqual([
      {
        reason: "local_scope_invalid",
        entry_count: 3,
        allowed_count: 3,
      },
    ]);
    await expect(
      beginProjectScopeBootstrap(identity, {
        baseVersion: reapproved.version,
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
          effectiveFrom: null,
        },
      ],
    });
  });

  it("repends historical auto-allowed scopes without a Feishu identity", async () => {
    const partnerId = randomUUID();
    const pluginInstanceId = randomUUID();
    const scopeKey = "7".repeat(64);
    const migrationIdentity = {
      tenantId: fixture.tenantId,
      teamId: fixture.teamId,
      partnerId,
      pluginInstanceId,
    };
    await sql.begin(async (tx) => {
      await tx`
        insert into partners (id, tenant_id, team_id, email, display_name)
        values (
          ${partnerId}, ${fixture.tenantId}, ${fixture.teamId},
          ${`migration-${partnerId}@local.test`}, 'Migration Partner'
        )
      `;
      await tx`
        insert into plugin_instances (
          id, tenant_id, team_id, partner_id, device_name, version,
          access_token_hash, refresh_token_hash, access_expires_at
        ) values (
          ${pluginInstanceId}, ${fixture.tenantId}, ${fixture.teamId},
          ${partnerId}, 'Migration Device', '2.0.0', 'access', 'refresh',
          ${new Date(Date.now() + 60_000).toISOString()}
        )
      `;
      await tx`
        insert into project_scope_policies (
          plugin_instance_id, tenant_id, team_id, partner_id,
          version, initialized, initialized_at
        ) values (
          ${pluginInstanceId}, ${fixture.tenantId}, ${fixture.teamId},
          ${partnerId}, 8, true, now()
        )
      `;
      await tx`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
          display_name, status, effective_from, decided_at,
          first_seen_period_key, session_count
        ) values (
          ${randomUUID()}, ${fixture.tenantId}, ${fixture.teamId}, ${partnerId},
          ${pluginInstanceId}, ${scopeKey}, 'historically-auto-allowed',
          'allowed', now(), now(), 'scope-period', 2
        )
      `;
    });
    try {
      const migrated = await registerProjectScopeCandidates(migrationIdentity, {
        periodKey: "scope-period",
        candidates: [],
      });
      expect(migrated).toMatchObject({
        version: 9,
        initialized: false,
        initializedAt: null,
        identityConfirmed: false,
        entries: [
          {
            scopeKey,
            status: "pending",
            effectiveFrom: null,
          },
        ],
      });
      const events = await sql<Array<{ event_type: string }>>`
        select event_type from outbox_events
        where aggregate_id = ${pluginInstanceId}
          and event_type = 'project_scope.candidates.changed'
      `;
      expect(events).toEqual([
        { event_type: "project_scope.candidates.changed" },
      ]);
    } finally {
      await sql`delete from outbox_events where aggregate_id = ${pluginInstanceId}`;
      await sql`delete from project_scope_entries where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from project_scope_policies where plugin_instance_id = ${pluginInstanceId}`;
      await sql`delete from plugin_instances where id = ${pluginInstanceId}`;
      await sql`delete from partners where id = ${partnerId}`;
    }
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
