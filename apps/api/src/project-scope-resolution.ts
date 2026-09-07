import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlClient as defaultDatabase } from "@partner-report/db";
import { ApiError } from "./common.js";
import {
  loadProjectScopePolicy,
  registerProjectScopeCandidates,
  type ScopeIdentity,
} from "./project-scope.js";

type Database = typeof defaultDatabase;
const key = z.string().regex(/^[a-f0-9]{64}$/);
export const projectScopeResolutionSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    periodKey: z.string().trim().min(1).max(120),
    initialDiscovery: z.boolean().default(false),
    candidates: z
      .array(
        z
          .object({
            scopeKey: key,
            identityKey: key.optional(),
            recoveryKeys: z.array(key).max(20).default([]),
            displayName: z.string().trim().min(1).max(120),
            sessionCount: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export async function loadResolvableProjectScope(
  identity: ScopeIdentity,
  database: Database = defaultDatabase,
) {
  const policy = await loadProjectScopePolicy(identity, database);
  const rows = await database<Array<{ identity_salt: string }>>`
    update project_scope_policies
    set identity_salt = coalesce(identity_salt, ${randomBytes(32).toString("hex")})
    where plugin_instance_id = ${identity.pluginInstanceId}
      and tenant_id = ${identity.tenantId}
    returning identity_salt
  `;
  return {
    ...policy,
    identitySalt: rows[0]!.identity_salt,
    resolutionVersion: 1 as const,
  };
}

// Only exact anonymous keys are recoverable from legacy backups. Names never
// establish identity, and a live decision (including pending) always wins.
async function restoreExactScope(
  identity: ScopeIdentity,
  scopeKey: string,
  tx: any,
) {
  const live = await tx`select scope_key from project_scope_entries
    where plugin_instance_id = ${identity.pluginInstanceId} and scope_key = ${scopeKey}`;
  if (live.length) return false;
  const historical = await tx`
    select e.*, s.id as source_snapshot_id
    from project_scope_backup_entries e
    join project_scope_backup_snapshots s on s.id = e.snapshot_id
    where s.plugin_instance_id = ${identity.pluginInstanceId}
      and s.tenant_id = ${identity.tenantId} and s.team_id = ${identity.teamId}
      and s.partner_id = ${identity.partnerId} and e.scope_key = ${scopeKey}
    order by s.created_at desc, s.id desc limit 1
  `;
  const old = historical[0];
  if (!old || !old.decided_at || !["allowed", "denied"].includes(old.status))
    return false;
  await tx`insert into project_scope_entries (
    id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
    display_name, status, effective_from, decided_at, first_seen_period_key, session_count
  ) values (
    ${randomUUID()}, ${identity.tenantId}, ${identity.teamId}, ${identity.partnerId},
    ${identity.pluginInstanceId}, ${scopeKey}, ${old.display_name}, ${old.status},
    ${old.effective_from}, ${old.decided_at}, ${old.first_seen_period_key}, ${old.session_count}
  )`;
  await tx`insert into audit_events (
    id, tenant_id, team_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata
  ) values (
    ${randomUUID()}, ${identity.tenantId}, ${identity.teamId}, 'plugin', ${identity.pluginInstanceId},
    'project_scope.permission_restored', 'plugin_instance', ${identity.pluginInstanceId},
    ${randomUUID()}, ${JSON.stringify({ sourceSnapshotId: old.source_snapshot_id, match: "exact_scope_key", status: old.status })}::jsonb
  )`;
  return true;
}

export async function resolveProjectScopes(
  identity: ScopeIdentity,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  const input = projectScopeResolutionSchema.parse(rawInput);
  const bindings: Array<{
    requestedScopeKey: string;
    scopeKey: string;
    resolution: string;
  }> = [];
  await database.begin(async (tx) => {
    const policy = await loadResolvableProjectScope(
      identity,
      tx as unknown as Database,
    );
    // The salt update above locks the policy row until resolution and registration commit.
    const versions = await tx<
      Array<{ version: number }>
    >`select version from project_scope_policies
      where plugin_instance_id = ${identity.pluginInstanceId} for update`;
    if (versions[0]!.version !== input.baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "项目权限已更新，请重新核对。",
        { currentVersion: versions[0]!.version },
      );
    const seen = new Set<string>();
    let restored = false;
    const candidates = [];
    for (const candidate of input.candidates) {
      if (seen.has(candidate.scopeKey))
        throw new ApiError(400, "DUPLICATE_SCOPE", "同一项目不能重复核对。");
      seen.add(candidate.scopeKey);
      const identities = await tx<
        Array<{ identity_key: string; scope_key: string }>
      >`
        select identity_key, scope_key from project_scope_identities
        where plugin_instance_id = ${identity.pluginInstanceId}
          and (scope_key = ${candidate.scopeKey} or identity_key = ${candidate.identityKey ?? ""})
      `;
      const byIdentity = identities.find(
        (row) => row.identity_key === candidate.identityKey,
      );
      const byKey = identities.find(
        (row) => row.scope_key === candidate.scopeKey,
      );
      let contradiction =
        !candidate.identityKey ||
        Boolean(byKey && byKey.identity_key !== candidate.identityKey);
      let scopeKey = candidate.scopeKey;
      let resolution = "exact_key";
      if (contradiction) {
        // A reused key must never carry an old allow decision to a new identity.
        // The replacement is deterministic, so retries share one approval card.
        scopeKey = createHmac("sha256", policy.identitySalt)
          .update(
            `scope-conflict:${candidate.scopeKey}:${candidate.identityKey ?? "unknown"}`,
          )
          .digest("hex");
        resolution = "identity_conflict";
      } else if (byIdentity) {
        scopeKey = byIdentity.scope_key;
        resolution = "identity_match";
      } else if (candidate.identityKey) {
        const keys = [
          ...new Set([candidate.scopeKey, ...candidate.recoveryKeys]),
        ];
        const live = await tx<Array<{ scope_key: string; status: string }>>`
          select scope_key, status from project_scope_entries
          where plugin_instance_id = ${identity.pluginInstanceId} and scope_key in ${tx(keys)}
        `;
        const incompatible = new Set(live.map((item) => item.status)).size > 1;
        if (incompatible) {
          scopeKey = createHmac("sha256", policy.identitySalt)
            .update(`scope-ambiguous:${candidate.identityKey}`)
            .digest("hex");
          resolution = "identity_conflict";
          contradiction = true;
        } else if (live.length > 0) {
          scopeKey =
            live.find((item) => item.scope_key === candidate.scopeKey)
              ?.scope_key ??
            [...live].sort((a, b) => a.scope_key.localeCompare(b.scope_key))[0]!
              .scope_key;
        } else if (live.length === 0) {
          const backups = await tx<
            Array<{ scope_key: string; status: string }>
          >`
            select distinct on (e.scope_key) e.scope_key, e.status from project_scope_backup_entries e
            join project_scope_backup_snapshots s on s.id = e.snapshot_id
            where s.plugin_instance_id = ${identity.pluginInstanceId}
              and s.tenant_id = ${identity.tenantId} and e.scope_key in ${tx(keys)}
            order by e.scope_key, s.created_at desc, s.id desc
          `;
          if (new Set(backups.map((item) => item.status)).size > 1) {
            scopeKey = createHmac("sha256", policy.identitySalt)
              .update(`scope-ambiguous:${candidate.identityKey}`)
              .digest("hex");
            resolution = "identity_conflict";
            contradiction = true;
          } else if (backups.length > 0) {
            scopeKey =
              backups.find((item) => item.scope_key === candidate.scopeKey)
                ?.scope_key ?? backups[0]!.scope_key;
          }
        }
      }
      let occupied = await tx<Array<{ identity_key: string }>>`
        select identity_key from project_scope_identities
        where plugin_instance_id = ${identity.pluginInstanceId} and scope_key = ${scopeKey}
      `;
      if (occupied[0] && occupied[0].identity_key !== candidate.identityKey) {
        scopeKey = createHmac("sha256", policy.identitySalt)
          .update(
            `scope-conflict:${scopeKey}:${candidate.identityKey ?? "unknown"}`,
          )
          .digest("hex");
        resolution = "identity_conflict";
        contradiction = true;
        occupied = await tx<
          Array<{ identity_key: string }>
        >`select identity_key from project_scope_identities
          where plugin_instance_id = ${identity.pluginInstanceId} and scope_key = ${scopeKey}`;
      }
      // Unknown or contradictory identities cannot recover historical grants.
      if (candidate.identityKey && !contradiction)
        restored =
          (await restoreExactScope(identity, scopeKey, tx)) || restored;
      if (candidate.identityKey && !occupied.length) {
        await tx`insert into project_scope_identities (id, plugin_instance_id, identity_key, scope_key)
          values (${randomUUID()}, ${identity.pluginInstanceId}, ${candidate.identityKey}, ${scopeKey})
          on conflict (plugin_instance_id, identity_key) do update
          set scope_key = excluded.scope_key, updated_at = now()`;
      }
      bindings.push({
        requestedScopeKey: candidate.scopeKey,
        scopeKey,
        resolution,
      });
      candidates.push({
        scopeKey,
        displayName: candidate.displayName,
        sessionCount: candidate.sessionCount,
      });
    }
    if (restored) {
      await tx`update project_scope_policies set version = version + 1,
        initialized = true, initialized_at = coalesce(initialized_at, now()), updated_at = now()
        where plugin_instance_id = ${identity.pluginInstanceId}`;
    }
    const unique = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.scopeKey);
      unique.set(candidate.scopeKey, {
        ...candidate,
        sessionCount: candidate.sessionCount + (previous?.sessionCount ?? 0),
      });
    }
    await registerProjectScopeCandidates(
      identity,
      {
        periodKey: input.periodKey,
        initialDiscovery: input.initialDiscovery,
        candidates: [...unique.values()],
      },
      tx as unknown as Database,
    );
  });
  return {
    ...(await loadResolvableProjectScope(identity, database)),
    bindings,
  };
}
