import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { ApiError, type DomainActor } from "./common.js";
import {
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
    feishuBindingId: randomUUID(),
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
      await tx`delete from audit_events where tenant_id = ${fixture.tenantId}`;
      await tx`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_entries where tenant_id = ${fixture.tenantId}`;
      await tx`delete from project_scope_policies where tenant_id = ${fixture.tenantId}`;
      await tx`delete from report_periods where tenant_id = ${fixture.tenantId}`;
      await tx`delete from feishu_partner_bindings where id = ${fixture.feishuBindingId}`;
      await tx`delete from plugin_instances where id = ${fixture.pluginInstanceId}`;
      await tx`delete from partners where id = ${fixture.partnerId}`;
      await tx`delete from teams where id = ${fixture.teamId}`;
      await tx`delete from tenants where id = ${fixture.tenantId}`;
    });
  });

  it("versions candidates and applies first versus later approvals correctly", async () => {
    const firstKey = "a".repeat(64);
    await expect(
      registerProjectScopeCandidates(identity, {
        periodKey: "scope-period",
        candidates: [
          { scopeKey: firstKey, displayName: "first-project", sessionCount: 2 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FEISHU_IDENTITY_CONFIRMATION_REQUIRED",
    });
    await sql`
      insert into feishu_partner_bindings (
        id, tenant_id, team_id, partner_id, app_id, open_id, status, verified_at
      ) values (
        ${fixture.feishuBindingId}, ${fixture.tenantId}, ${fixture.teamId},
        ${fixture.partnerId}, 'cli_scope_test', 'ou_scope_test', 'active', now()
      )
    `;
    const first = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      candidates: [
        { scopeKey: firstKey, displayName: "first-project", sessionCount: 2 },
      ],
    });
    expect(first).toMatchObject({ version: 2, initialized: false });

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

    const laterKey = "b".repeat(64);
    const later = await registerProjectScopeCandidates(identity, {
      periodKey: "scope-period",
      candidates: [
        { scopeKey: laterKey, displayName: "later-project", sessionCount: 1 },
      ],
    });
    const decided = await decideProjectScopes(actor, fixture.pluginInstanceId, {
      baseVersion: later.version,
      decisions: [{ scopeKey: laterKey, decision: "allow" }],
    });
    const laterEntry = decided.entries.find(
      (entry) => entry.scopeKey === laterKey,
    )!;
    expect(new Date(laterEntry.effectiveFrom!).toISOString()).toBe(
      periodEnd.toISOString(),
    );

    await expect(
      decideProjectScopes(actor, fixture.pluginInstanceId, {
        baseVersion: later.version,
        decisions: [{ scopeKey: laterKey, decision: "deny" }],
      }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    } satisfies Partial<ApiError>);
  });
});
