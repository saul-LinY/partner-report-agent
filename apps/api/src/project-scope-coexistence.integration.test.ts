import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import { buildApp } from "./server.js";
import { decideProjectScopes } from "./project-scope.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

suite("legacy and modern members sharing one platform", () => {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const periodKey = "coexistence-test";
  const member = (version: string) => ({
    tenantId,
    teamId,
    partnerId: randomUUID(),
    pluginInstanceId: randomUUID(),
    token: randomUUID(),
    version,
  });
  const legacy = member("2.0.0");
  const modern = member("2.1.0");
  const key = (n: number) => n.toString(16).padStart(64, "0");
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    scopeKey: key(i + 1),
    displayName: `project-${i + 1}`,
    sessionCount: 1,
  }));
  const modernCandidates = candidates.map((candidate, i) => ({
    ...candidate,
    identityKey: key(i + 1001),
  }));
  let app: Awaited<ReturnType<typeof buildApp>>;
  const get = (who: typeof legacy, version: number) =>
    app.inject({
      method: "GET",
      url: `/v${version}/project-scope`,
      headers: { authorization: `Bearer ${who.token}` },
    });
  const post = (who: typeof legacy, url: string, payload: object) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${who.token}` },
      payload,
    });

  beforeAll(async () => {
    await sql`insert into tenants (id,name) values (${tenantId},'Coexistence Tenant')`;
    await sql`insert into teams (id,tenant_id,name) values (${teamId},${tenantId},'Coexistence Team')`;
    await sql`insert into report_periods (id,tenant_id,team_id,period_key,starts_at,ends_at,cutoff_at,submission_deadline_at,timezone,status)
      values (${randomUUID()},${tenantId},${teamId},${periodKey},now()-interval '1 day',now()+interval '7 days',now()+interval '7 days',now()+interval '7 days','Asia/Shanghai','open')`;
    for (const who of [legacy, modern]) {
      await sql`insert into partners (id,tenant_id,team_id,email,display_name)
        values (${who.partnerId},${tenantId},${teamId},${`${who.partnerId}@local.test`},${who.version})`;
      await sql`insert into plugin_instances (id,tenant_id,team_id,partner_id,device_name,version,access_token_hash,refresh_token_hash,access_expires_at)
        values (${who.pluginInstanceId},${tenantId},${teamId},${who.partnerId},'Test',${who.version},${createHash("sha256").update(who.token).digest("hex")},${randomUUID()},now()+interval '1 day')`;
      await sql`insert into feishu_partner_bindings (id,tenant_id,team_id,partner_id,status,open_id,app_id)
        values (${randomUUID()},${tenantId},${teamId},${who.partnerId},'active',${who.partnerId},'test-app')`;
    }
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await sql`delete from outbox_events where tenant_id=${tenantId}`;
    await sql`delete from audit_events where tenant_id=${tenantId}`;
    await sql`delete from feishu_partner_bindings where tenant_id=${tenantId}`;
    await sql`delete from project_scope_backup_snapshots where tenant_id=${tenantId}`;
    await sql`delete from project_scope_entries where tenant_id=${tenantId}`;
    await sql`delete from project_scope_policies where tenant_id=${tenantId}`;
    await sql`delete from report_periods where tenant_id=${tenantId}`;
    await sql`delete from plugin_instances where tenant_id=${tenantId}`;
    await sql`delete from partners where tenant_id=${tenantId}`;
    await sql`delete from teams where id=${teamId}`;
    await sql`delete from tenants where id=${tenantId}`;
  });

  it("serves both members concurrently without sharing grants or shrinking 20 reviewed entries", async () => {
    const initial = await get(modern, 2);
    expect(initial.statusCode).toBe(200);
    const registered = await Promise.all([
      post(legacy, "/v1/project-scope/candidates", { periodKey, candidates }),
      post(modern, "/v2/project-scope/resolve", {
        periodKey,
        baseVersion: initial.json().version,
        candidates: modernCandidates,
      }),
    ]);
    for (const response of registered) expect(response.statusCode).toBe(200);
    for (const [i, who] of [legacy, modern].entries()) {
      await decideProjectScopes(
        {
          ...who,
          actorType: "feishu",
          actorId: "coexistence-test",
          userId: null,
        },
        who.pluginInstanceId,
        {
          baseVersion: registered[i]!.json().version,
          decisions: candidates.map((candidate, index) => ({
            scopeKey: candidate.scopeKey,
            decision: (who === modern ? index < 9 : index >= 9)
              ? "allow"
              : "deny",
          })),
        },
      );
    }
    const before = (await get(modern, 2)).json();
    const events =
      await sql`select count(*)::int as count from outbox_events where tenant_id=${tenantId}`;
    const responses = await Promise.all([
      post(legacy, "/v1/project-scope/candidates", {
        periodKey,
        candidates: candidates.slice(0, 15),
      }),
      post(modern, "/v2/project-scope/resolve", {
        periodKey,
        baseVersion: before.version,
        candidates: modernCandidates.slice(0, 15).map((candidate, index) => ({
          ...candidate,
          scopeKey: key(index + 101),
        })),
      }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json().entries).toHaveLength(20);
    }
    expect(responses[0]!.json()).not.toHaveProperty("identitySalt");
    const current = responses[1]!.json();
    expect(current.version).toBe(before.version);
    expect(
      current.entries.filter(
        (entry: { status: string }) => entry.status === "allowed",
      ),
    ).toHaveLength(9);
    expect(
      current.entries.filter(
        (entry: { status: string }) => entry.status === "denied",
      ),
    ).toHaveLength(11);
    expect(
      responses[0]!
        .json()
        .entries.find(
          (entry: { scopeKey: string }) => entry.scopeKey === key(1),
        ).status,
    ).toBe("denied");
    expect(
      current.entries.find(
        (entry: { scopeKey: string }) => entry.scopeKey === key(1),
      ).status,
    ).toBe("allowed");
    expect(
      await sql`select count(*)::int as count from outbox_events where tenant_id=${tenantId}`,
    ).toEqual(events);
    expect(
      (
        await sql`select minimum_plugin_version from teams where id=${teamId}`
      )[0]!.minimum_plugin_version,
    ).toBe("0.2.0");
  });

  it("keeps legacy reset and review working without affecting the modern member", async () => {
    const before = (await get(modern, 2)).json();
    const old = (await get(legacy, 1)).json();
    const reset = await post(legacy, "/v1/project-scope/bootstrap", {
      baseVersion: old.version,
      reason: "local_scope_identity_conflict",
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().entries).toHaveLength(0);
    const registered = await post(legacy, "/v1/project-scope/candidates", {
      periodKey,
      initialDiscovery: true,
      candidates: candidates.slice(0, 1),
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().entries[0].status).toBe("pending");
    expect((await get(modern, 2)).json()).toEqual(before);
    expect(
      (
        await sql`select entry_count from project_scope_backup_snapshots where plugin_instance_id=${legacy.pluginInstanceId}`
      )[0]!.entry_count,
    ).toBe(20);
  });

  it("rejects a concurrent stale update and succeeds after fetching the latest policy", async () => {
    const baseVersion = (await get(modern, 2)).json().version;
    const payloads = [31, 32].map((n) => ({
      periodKey,
      baseVersion,
      candidates: [
        {
          scopeKey: key(n),
          identityKey: key(n + 1000),
          displayName: `new-${n}`,
          sessionCount: 1,
        },
      ],
    }));
    const responses = await Promise.all(
      payloads.map((payload) =>
        post(modern, "/v2/project-scope/resolve", payload),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const rejected = responses.findIndex(
      (response) => response.statusCode === 409,
    );
    expect(responses[rejected]!.json().code).toBe("VERSION_CONFLICT");
    const latest = (await get(modern, 2)).json();
    const retried = await post(modern, "/v2/project-scope/resolve", {
      ...payloads[rejected],
      baseVersion: latest.version,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().entries).toHaveLength(22);
    expect(
      retried
        .json()
        .entries.filter(
          (entry: { status: string }) => entry.status === "pending",
        ),
    ).toHaveLength(2);
  });
});
