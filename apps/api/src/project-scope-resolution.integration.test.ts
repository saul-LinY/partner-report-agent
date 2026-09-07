import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  beginProjectScopeBootstrap,
  decideProjectScopes,
  loadProjectScopePolicy,
  registerProjectScopeCandidates,
} from "./project-scope.js";
import { createProjectScopeBackup } from "./project-scope-backup.js";
import {
  loadResolvableProjectScope,
  resolveProjectScopes,
} from "./project-scope-resolution.js";
import type { DomainActor } from "./common.js";
import { buildApp } from "./server.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("project permission resolution and legacy compatibility", () => {
  const identity = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    partnerId: randomUUID(),
    pluginInstanceId: randomUUID(),
  };
  const actor: DomainActor = {
    ...identity,
    actorType: "feishu",
    actorId: "scope-test",
    userId: null,
  };
  const periodKey = "resolution-test";
  const token = randomUUID();
  const k = (n: number) => n.toString(16).padStart(64, "0");
  const candidate = (n: number, name = `project-${n}`) => ({
    scopeKey: k(n),
    identityKey: k(n + 1000),
    displayName: name,
    sessionCount: 1,
  });
  const resolve = async (candidates: unknown[]) =>
    resolveProjectScopes(identity, {
      baseVersion: (await loadProjectScopePolicy(identity)).version,
      periodKey,
      candidates,
    });
  async function decide(scopeKey: string, decision: "allow" | "deny") {
    return decideProjectScopes(actor, identity.pluginInstanceId, {
      baseVersion: (await loadProjectScopePolicy(identity)).version,
      decisions: [{ scopeKey, decision }],
    });
  }
  beforeAll(async () => {
    await sql`insert into tenants (id,name) values (${identity.tenantId}, 'Resolution Tenant')`;
    await sql`insert into teams (id,tenant_id,name) values (${identity.teamId},${identity.tenantId},'Resolution Team')`;
    await sql`insert into partners (id,tenant_id,team_id,email,display_name)
      values (${identity.partnerId},${identity.tenantId},${identity.teamId},${`${identity.partnerId}@local.test`},'Resolution Partner')`;
    await sql`insert into plugin_instances (id,tenant_id,team_id,partner_id,device_name,version,access_token_hash,refresh_token_hash,access_expires_at)
      values (${identity.pluginInstanceId},${identity.tenantId},${identity.teamId},${identity.partnerId},'Test','2.0.0',${createHash("sha256").update(token).digest("hex")},'refresh',now()+interval '1 day')`;
    await sql`insert into feishu_partner_bindings (id,tenant_id,team_id,partner_id,status,open_id,app_id)
      values (${randomUUID()},${identity.tenantId},${identity.teamId},${identity.partnerId},'active',${identity.partnerId},'test-app')`;
    await sql`insert into report_periods (id,tenant_id,team_id,period_key,starts_at,ends_at,cutoff_at,submission_deadline_at,timezone,status)
      values (${randomUUID()},${identity.tenantId},${identity.teamId},${periodKey},now()-interval '1 day',now()+interval '7 days',now()+interval '7 days',now()+interval '7 days','Asia/Shanghai','open')`;
  });
  afterAll(async () => {
    await sql`delete from outbox_events where tenant_id=${identity.tenantId}`;
    await sql`delete from audit_events where tenant_id=${identity.tenantId}`;
    await sql`delete from feishu_partner_bindings where tenant_id=${identity.tenantId}`;
    await sql`delete from project_scope_backup_snapshots where tenant_id=${identity.tenantId}`;
    await sql`delete from project_scope_entries where tenant_id=${identity.tenantId}`;
    await sql`delete from project_scope_policies where tenant_id=${identity.tenantId}`;
    await sql`delete from report_periods where tenant_id=${identity.tenantId}`;
    await sql`delete from plugin_instances where id=${identity.pluginInstanceId}`;
    await sql`delete from partners where id=${identity.partnerId}`;
    await sql`delete from teams where id=${identity.teamId}`;
    await sql`delete from tenants where id=${identity.tenantId}`;
  });

  it("preserves the v1 response and existing review when a v2 plugin enrolls", async () => {
    const first = candidate(1);
    await registerProjectScopeCandidates(identity, {
      periodKey,
      candidates: [
        {
          scopeKey: first.scopeKey,
          displayName: first.displayName,
          sessionCount: 1,
        },
      ],
    });
    await decide(first.scopeKey, "allow");
    const before = await loadProjectScopePolicy(identity);
    const after = await resolve([first]);
    const { lastSeenAt: _seen, ...unchanged } = before.entries[0]!;
    expect(
      after.entries.find((e) => e.scopeKey === first.scopeKey),
    ).toMatchObject(unchanged);
    expect(after.version).toBe(before.version);
    expect(after.identitySalt).toMatch(/^[a-f0-9]{64}$/);
    expect(await loadProjectScopePolicy(identity)).not.toHaveProperty(
      "identitySalt",
    );
    expect(
      (
        await sql`select minimum_plugin_version from teams where id=${identity.teamId}`
      )[0]!.minimum_plugin_version,
    ).toBe("0.2.0");
  });

  it("finds an allowed project by identity after its local key is lost", async () => {
    const resolved = await resolve([{ ...candidate(1), scopeKey: k(101) }]);
    expect(resolved.bindings[0]).toMatchObject({
      scopeKey: k(1),
      resolution: "identity_match",
    });
    expect(
      resolved.entries.filter((e) => e.displayName === "project-1"),
    ).toHaveLength(1);
    expect(resolved.entries.find((e) => e.scopeKey === k(1))!.status).toBe(
      "allowed",
    );
  });

  it("preserves a denial and does not repeat pending approval events", async () => {
    await resolve([candidate(2)]);
    await decide(k(2), "deny");
    const restored = await resolve([{ ...candidate(2), scopeKey: k(102) }]);
    expect(restored.entries.find((e) => e.scopeKey === k(2))!.status).toBe(
      "denied",
    );
    const pending = await resolve([candidate(3)]);
    const before =
      await sql`select count(*)::int as count from outbox_events where aggregate_id=${identity.pluginInstanceId}`;
    const repeated = await resolve([candidate(3)]);
    expect(repeated.version).toBe(pending.version);
    expect(
      await sql`select count(*)::int as count from outbox_events where aggregate_id=${identity.pluginInstanceId}`,
    ).toEqual(before);
  });

  it("does not match projects by name", async () => {
    const result = await resolve([candidate(4, "project-1")]);
    expect(result.entries.find((e) => e.scopeKey === k(4))!.status).toBe(
      "pending",
    );
    expect(result.entries.find((e) => e.scopeKey === k(1))!.status).toBe(
      "allowed",
    );
  });

  it("isolates a reused key with a different identity and recovers after explicit review", async () => {
    const replacement = { ...candidate(1), identityKey: k(5001) };
    const result = await resolve([replacement]);
    const newKey = result.bindings[0]!.scopeKey;
    expect(newKey).not.toBe(k(1));
    expect(result.entries.find((e) => e.scopeKey === newKey)!.status).toBe(
      "pending",
    );
    expect(result.entries.find((e) => e.scopeKey === k(1))!.status).toBe(
      "allowed",
    );
    expect((await resolve([replacement])).bindings[0]!.scopeKey).toBe(newKey);
    await decide(newKey, "deny");
    const next = await resolve([{ ...replacement, scopeKey: newKey }]);
    expect(next.entries.find((e) => e.scopeKey === newKey)!.status).toBe(
      "denied",
    );
  });

  it("does not restore an allow when identity is unavailable", async () => {
    const result = await resolve([
      { scopeKey: k(1), displayName: "project-1", sessionCount: 1 },
    ]);
    expect(result.bindings[0]!.scopeKey).not.toBe(k(1));
    expect(
      result.entries.find((e) => e.scopeKey === result.bindings[0]!.scopeKey)!
        .status,
    ).toBe("pending");
  });

  it("does not choose an allow from contradictory reviewed aliases", async () => {
    await registerProjectScopeCandidates(identity, {
      periodKey,
      candidates: [
        { scopeKey: k(11), displayName: "alias", sessionCount: 1 },
        { scopeKey: k(12), displayName: "alias", sessionCount: 1 },
      ],
    });
    await decide(k(11), "allow");
    await decide(k(12), "deny");
    const result = await resolve([
      { ...candidate(11, "alias"), recoveryKeys: [k(12)] },
    ]);
    expect(result.bindings[0]!.resolution).toBe("identity_conflict");
    expect(
      result.entries.find((e) => e.scopeKey === result.bindings[0]!.scopeKey)!
        .status,
    ).toBe("pending");
  });

  it("rejects stale versions atomically", async () => {
    await expect(
      resolveProjectScopes(identity, {
        baseVersion: 1,
        periodKey,
        candidates: [candidate(20)],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(
      (await loadProjectScopePolicy(identity)).entries.find(
        (e) => e.scopeKey === k(20),
      ),
    ).toBeUndefined();
  });

  it("cannot recover another identity's grant through a supplied recovery key", async () => {
    const result = await resolve([{ ...candidate(25), recoveryKeys: [k(1)] }]);
    expect(result.bindings[0]!.resolution).toBe("identity_conflict");
    expect(
      result.entries.find((e) => e.scopeKey === result.bindings[0]!.scopeKey)!
        .status,
    ).toBe("pending");
  });

  it("serves both authenticated route versions and rejects actor overrides", async () => {
    const app = await buildApp({ logger: false });
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect(
        (await app.inject({ method: "GET", url: "/v2/project-scope" }))
          .statusCode,
      ).toBe(401);
      const legacy = await app.inject({
        method: "GET",
        url: "/v1/project-scope",
        headers,
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).not.toHaveProperty("identitySalt");
      const modern = await app.inject({
        method: "GET",
        url: "/v2/project-scope",
        headers,
      });
      expect(modern.statusCode).toBe(200);
      const body = {
        periodKey,
        baseVersion: modern.json().version,
        candidates: [candidate(2)],
      };
      const resolution = await app.inject({
        method: "POST",
        url: "/v2/project-scope/resolve",
        headers,
        payload: body,
      });
      expect(resolution.statusCode).toBe(200);
      expect(resolution.json().bindings[0].scopeKey).toBe(k(2));
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v2/project-scope/resolve",
            headers,
            payload: { ...body, pluginInstanceId: randomUUID() },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("restores the latest exact-key backup after legacy bootstrap without a new review", async () => {
    await registerProjectScopeCandidates(identity, {
      periodKey,
      candidates: [
        { scopeKey: k(31), displayName: "historical-alias", sessionCount: 1 },
        { scopeKey: k(32), displayName: "historical-alias", sessionCount: 1 },
      ],
    });
    await decide(k(31), "allow");
    await decide(k(32), "deny");
    const prior = await loadProjectScopePolicy(identity);
    const salt = (await loadResolvableProjectScope(identity)).identitySalt;
    await beginProjectScopeBootstrap(identity, {
      baseVersion: prior.version,
      reason: "local_scope_identity_conflict",
    });
    expect((await loadProjectScopePolicy(identity)).entries).toHaveLength(0);
    const restored = await resolve([candidate(1), candidate(2)]);
    expect(restored.entries.map((e) => e.status).sort()).toEqual([
      "allowed",
      "denied",
    ]);
    expect(restored.identitySalt).toBe(salt);
    expect(restored.initialized).toBe(true);
    expect(
      (
        await sql`select count(*)::int as count from audit_events where tenant_id=${identity.tenantId} and action='project_scope.permission_restored'`
      )[0]!.count,
    ).toBe(2);
  });

  it("does not choose an allow from contradictory backup aliases", async () => {
    const result = await resolve([{ ...candidate(31), recoveryKeys: [k(32)] }]);
    expect(result.bindings[0]!.resolution).toBe("identity_conflict");
    expect(
      result.entries.find((e) => e.scopeKey === result.bindings[0]!.scopeKey)!
        .status,
    ).toBe("pending");
  });

  it("does not overwrite a newer live denial or pending decision with an old backup", async () => {
    await createProjectScopeBackup(identity, "test-baseline");
    await decide(k(1), "deny");
    expect(
      (await resolve([candidate(1)])).entries.find((e) => e.scopeKey === k(1))!
        .status,
    ).toBe("denied");
    await sql`update project_scope_entries set status='pending',effective_from=null,decided_at=null where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${k(1)}`;
    expect(
      (await resolve([candidate(1)])).entries.find((e) => e.scopeKey === k(1))!
        .status,
    ).toBe("pending");
  });
});
