import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadMemberProjectRedirects,
  sqlClient as sql,
} from "@partner-report/db";
import {
  decideProjectScopes,
  loadProjectScopePolicy,
  registerProjectScopeCandidates,
  reopenProjectScopeReview,
} from "./project-scope.js";
import {
  loadResolvableProjectScope,
  resolveProjectScopes,
} from "./project-scope-resolution.js";
import { resolveProjectIdentity } from "./project-discovery.js";
import { buildProjectBuckets } from "../../worker/src/weekly.js";
// Exercise the shipped, unchanged 2.1 implementation against real API results.
import {
  applyScopeResolution,
  discoverProjectScopes,
  threadMayBeRead,
  type LocalProjectScope,
} from "../../../plugins/v2/partner-report/src/project-scope.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
const key = (n: number) => n.toString(16).padStart(64, "0");
const candidate = (n: number, displayName = "Headroom_MVP") => ({
  scopeKey: key(n),
  identityKey: key(n + 1000),
  displayName,
  sessionCount: 1,
});

suite("member project deduplication without a plugin update", () => {
  let identity: {
    tenantId: string;
    teamId: string;
    partnerId: string;
    pluginInstanceId: string;
  };
  let directory: string;
  const periodKey = "name-dedup-test";
  async function device(partnerId = identity.partnerId, version = "2.1.0") {
    const who = { ...identity, partnerId, pluginInstanceId: randomUUID() };
    // The platform permits one active device per member; model a replacement.
    await sql`update plugin_instances set status='revoked' where tenant_id=${who.tenantId} and partner_id=${partnerId}`;
    await sql`insert into partners (id,tenant_id,team_id,email,display_name)
      values (${partnerId},${who.tenantId},${who.teamId},${`${partnerId}@local.test`},'Dedup Member')
      on conflict (id) do nothing`;
    await sql`insert into plugin_instances
      (id,tenant_id,team_id,partner_id,device_name,version,access_token_hash,refresh_token_hash,access_expires_at)
      values (${who.pluginInstanceId},${who.tenantId},${who.teamId},${partnerId},'Test',${version},${randomUUID()},${randomUUID()},now()+interval '1 day')`;
    await sql`insert into feishu_partner_bindings (id,tenant_id,team_id,partner_id,status,open_id,app_id)
      values (${randomUUID()},${who.tenantId},${who.teamId},${partnerId},'active',${who.pluginInstanceId},'test-app')
      on conflict do nothing`;
    return who;
  }
  const actor = () => ({
    ...identity,
    actorType: "feishu" as const,
    actorId: "dedup-test",
    userId: null,
  });
  async function register(
    items: ReturnType<typeof candidate>[],
    who = identity,
  ) {
    await registerProjectScopeCandidates(who, {
      periodKey,
      candidates: items.map(({ identityKey: _, ...item }) => item),
    });
  }
  async function decide(n: number, decision: "allow" | "deny", who = identity) {
    await decideProjectScopes({ ...actor(), ...who }, who.pluginInstanceId, {
      baseVersion: (await loadProjectScopePolicy(who)).version,
      decisions: [{ scopeKey: key(n), decision }],
    });
  }
  async function resolve(items: unknown[], who = identity) {
    return resolveProjectScopes(who, {
      baseVersion: (await loadProjectScopePolicy(who)).version,
      periodKey,
      candidates: items,
    });
  }
  const events = () => sql`select count(*)::int as count from outbox_events
    where tenant_id=${identity.tenantId} and event_type='project_scope.candidates.changed'`;
  beforeEach(async () => {
    identity = {
      tenantId: randomUUID(),
      teamId: randomUUID(),
      partnerId: randomUUID(),
      pluginInstanceId: randomUUID(),
    };
    directory = mkdtempSync(join(tmpdir(), "member-dedup-"));
    await sql`insert into tenants (id,name) values (${identity.tenantId},'Dedup Tenant')`;
    await sql`insert into teams (id,tenant_id,name) values (${identity.teamId},${identity.tenantId},'Dedup Team')`;
    identity = await device();
    await sql`insert into report_periods
      (id,tenant_id,team_id,period_key,starts_at,ends_at,cutoff_at,submission_deadline_at,timezone,status)
      values (${randomUUID()},${identity.tenantId},${identity.teamId},${periodKey},now()-interval '1 day',now()+interval '7 days',now()+interval '7 days',now()+interval '7 days','Asia/Shanghai','open')`;
  });
  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true });
    await sql`delete from outbox_events where tenant_id=${identity.tenantId}`;
    await sql`delete from audit_events where tenant_id=${identity.tenantId}`;
    await sql`delete from feishu_partner_bindings where tenant_id=${identity.tenantId}`;
    await sql`delete from project_scope_backup_snapshots where tenant_id=${identity.tenantId}`;
    await sql`delete from project_scope_entries where tenant_id=${identity.tenantId}`;
    await sql`delete from project_scope_policies where tenant_id=${identity.tenantId}`;
    await sql`delete from projects where tenant_id=${identity.tenantId}`;
    await sql`delete from report_periods where tenant_id=${identity.tenantId}`;
    await sql`delete from plugin_instances where tenant_id=${identity.tenantId}`;
    await sql`delete from partners where tenant_id=${identity.tenantId}`;
    await sql`delete from teams where id=${identity.teamId}`;
    await sql`delete from tenants where id=${identity.tenantId}`;
  });

  it("recovers a dormant project never enrolled in 2.1 after local permission loss", async () => {
    await register([candidate(1), candidate(2, "Other")]);
    await decide(1, "allow");
    await decide(2, "deny");
    const before = await loadResolvableProjectScope(identity);
    expect(
      await sql`select * from project_scope_identities where plugin_instance_id=${identity.pluginInstanceId}`,
    ).toHaveLength(0);
    const originalEvents = await events();
    const result = await resolve([candidate(50)]);
    expect(result.entries).toHaveLength(2);
    expect(result.bindings[0]!.scopeKey).toBe(key(1));
    expect(result.entries.find((e) => e.scopeKey === key(1))).toMatchObject({
      status: "allowed",
      effectiveFrom: before.entries.find((e) => e.scopeKey === key(1))!
        .effectiveFrom,
    });
    expect(result.version).toBe(before.version);
    expect(await events()).toEqual(originalEvents);
  });

  it("cleans real 2.1 local duplicates and preserves the newest denial on repeated runs", async () => {
    await register([candidate(1), candidate(2)]);
    await decide(1, "allow");
    await decide(2, "deny");
    await sql`update project_scope_entries set first_seen_at=now()-interval '1 day'
      where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${key(1)}`;
    const root = join(directory, "Headroom_MVP");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(
      join(root, ".git", "config"),
      '[remote "origin"]\nurl = git@github.com:example/headroom.git\n',
    );
    const before = await loadResolvableProjectScope(identity);
    let local: LocalProjectScope = {
      ...before,
      schemaVersion: "1.0",
      scopeSalt: key(900),
      entries: before.entries.map((entry) => ({ ...entry, localRoot: root })),
    };
    const originalEvents = await events();
    let version: number | undefined;
    for (let run = 0; run < 2; run++) {
      const discovery = discoverProjectScopes(
        identity.pluginInstanceId,
        local,
        [{ id: "thread", cwd: root }],
        { temporaryRoots: [] },
      );
      const result = await resolve(
        discovery.candidates.map(
          ({ localRoot: _, localIdentity: _i, environmentKind: _e, ...item }) =>
            item,
        ),
      );
      local = applyScopeResolution(local, result, discovery);
      expect(local.entries).toHaveLength(1);
      expect(local.entries[0]).toMatchObject({
        scopeKey: key(1),
        status: "denied",
        localRoot: root,
      });
      expect(
        threadMayBeRead({ id: "thread", cwd: root, scopeKey: key(1) }, local, {
          temporaryRoots: [],
        }),
      ).toBe(false);
      if (version !== undefined) expect(result.version).toBe(version);
      version = result.version;
    }
    // Old backup keys and fresh identities cannot resurrect the removed allow.
    const replay = await resolve([
      { ...candidate(2), identityKey: key(9002), recoveryKeys: [key(2)] },
    ]);
    expect(replay.entries).toHaveLength(1);
    expect(replay.entries[0]!.status).toBe("denied");
    expect(await events()).toEqual(originalEvents);
    expect(
      await sql`select * from project_scope_backup_snapshots where plugin_instance_id=${identity.pluginInstanceId} and reason='before_member_name_deduplication'`,
    ).toHaveLength(1);
  });

  it("creates one pending project for a same-name batch and keeps genuinely new names separate", async () => {
    const first = await resolve([
      candidate(1),
      candidate(2),
      candidate(3, "Headroom_MVP_new"),
      candidate(4, "headroom_mvp"),
    ]);
    expect(first.entries).toHaveLength(3);
    expect(first.entries.every((e) => e.status === "pending")).toBe(true);
    expect(first.bindings[0]!.scopeKey).toBe(first.bindings[1]!.scopeKey);
    const originalEvents = await events();
    const next = await resolve([candidate(5), candidate(6)]);
    expect(next.entries).toHaveLength(3);
    expect(next.version).toBe(first.version);
    expect(await events()).toEqual(originalEvents);
    expect(originalEvents[0]!.count).toBe(1);
  });

  it("reuses the same member's decision across devices without borrowing another member's grant", async () => {
    await register([candidate(1)]);
    await decide(1, "allow");
    const secondDevice = await device();
    const same = await resolve([candidate(2)], secondDevice);
    expect(same.entries).toHaveLength(1);
    expect(same.entries[0]!.status).toBe("allowed");
    expect(same.initialized).toBe(true);
    const stranger = await device(randomUUID(), "2.0.0");
    const other = await resolve([candidate(1)], stranger);
    expect(other.entries[0]!.status).toBe("pending");
    expect((await loadProjectScopePolicy(identity)).entries[0]!.status).toBe(
      "allowed",
    );
  });

  it("keeps an administrator's reopened review pending despite a stale duplicate allow", async () => {
    await register([candidate(1)]);
    await decide(1, "allow");
    const old =
      await sql`select * from project_scope_entries where plugin_instance_id=${identity.pluginInstanceId}`;
    await reopenProjectScopeReview(actor(), identity.pluginInstanceId, {
      baseVersion: (await loadProjectScopePolicy(identity)).version,
    });
    await register([candidate(2)]);
    await sql`update project_scope_entries set status='allowed',effective_from=${old[0]!.effective_from},decided_at=${old[0]!.decided_at}
      where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${key(2)}`;
    const result = await resolve([candidate(3)]);
    expect(result.entries[0]!.status).toBe("pending");
    expect((await resolve([candidate(4)])).entries[0]!.status).toBe("pending");
  });

  it("rolls back cleanup and aliases if the request is invalid", async () => {
    await register([candidate(1), candidate(2)]);
    await decide(1, "allow");
    const before = await loadProjectScopePolicy(identity);
    await expect(resolve([candidate(10), candidate(10)])).rejects.toMatchObject(
      { code: "DUPLICATE_SCOPE" },
    );
    expect(await loadProjectScopePolicy(identity)).toEqual(before);
    expect(
      await sql`select * from project_scope_aliases where plugin_instance_id=${identity.pluginInstanceId}`,
    ).toHaveLength(0);
    expect(
      await sql`select * from project_scope_backup_snapshots where plugin_instance_id=${identity.pluginInstanceId}`,
    ).toHaveLength(0);
  });

  it("redirects future uploads and groups old facts into one project for this member only", async () => {
    await register([candidate(1), candidate(2)]);
    await decide(1, "allow");
    await decide(2, "allow");
    const firstId = randomUUID();
    const secondId = randomUUID();
    for (const [id, n] of [
      [firstId, 1],
      [secondId, 2],
    ] as const) {
      await sql`insert into projects (id,tenant_id,team_id,name,aliases,allowed_paths,external_ids,created_at)
        values (${id},${identity.tenantId},${identity.teamId},${n === 1 ? "Headroom_MVP" : "Headroom_MVP (2)"},
          '[]'::jsonb,'[]'::jsonb,
          ${JSON.stringify([`scope:${identity.pluginInstanceId}:${key(n)}`])}::jsonb,
          ${n === 1 ? "2026-09-01T00:00:00Z" : "2026-09-02T00:00:00Z"})`;
    }
    await resolve([candidate(50)]);
    const redirects = await loadMemberProjectRedirects(sql, identity);
    expect(redirects.get(secondId)!.id).toBe(firstId);
    for (const id of [null, secondId]) {
      const result = await sql.begin((tx) =>
        resolveProjectIdentity(tx, identity, {
          id,
          scopeKey: key(50),
          rootName: "Headroom_MVP",
          rootFingerprint: key(400),
          matchMethod: "path_discovered",
        }),
      );
      expect(result!.id).toBe(firstId);
    }
    await expect(
      sql.begin((tx) =>
        resolveProjectIdentity(tx, identity, {
          id: randomUUID(),
          scopeKey: key(50),
          rootName: "Headroom_MVP",
          rootFingerprint: key(400),
          matchMethod: "path_discovered",
        }),
      ),
    ).rejects.toMatchObject({ code: "PROJECT_ID_INVALID" });
    const facts = [
      { id: "f1", payload: { projectId: firstId } },
      { id: "f2", payload: { project: { id: secondId } } },
    ];
    const projects = [
      { id: firstId, name: "Headroom_MVP" },
      { id: secondId, name: "Headroom_MVP (2)" },
    ];
    const buckets = buildProjectBuckets(facts, projects, redirects);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      projectId: firstId,
      factIds: ["f1", "f2"],
    });
    const otherRedirects = await loadMemberProjectRedirects(sql, {
      ...identity,
      partnerId: randomUUID(),
    });
    expect(buildProjectBuckets(facts, projects, otherRedirects)).toHaveLength(
      2,
    );
    expect(facts[1]!.payload.project!.id).toBe(secondId);
  });
});
