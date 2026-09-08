import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlClient as defaultDatabase } from "@partner-report/db";
import { ApiError } from "./common.js";
import {
  consolidateMemberProject,
  deduplicateExistingScopes,
  matchMemberProjectName,
  rememberScopeAlias,
} from "./project-scope-deduplication.js";
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

// After checking live member/name matches, backup recovery requires an exact
// anonymous key. A live decision (including pending) always wins over backups.
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
    // Serialize v2 resolution across devices belonging to the same member.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`scope-member:${identity.tenantId}:${identity.partnerId}`},0))`;
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
    await deduplicateExistingScopes(tx, identity);
    const seen = new Set<string>();
    const batchNames = new Map<string, string>();
    let restored = false;
    const candidates = [];
    for (const candidate of input.candidates) {
      if (seen.has(candidate.scopeKey))
        throw new ApiError(400, "DUPLICATE_SCOPE", "同一项目不能重复核对。");
      seen.add(candidate.scopeKey);
      const named = await matchMemberProjectName(
        tx,
        identity,
        candidate.displayName,
      );
      const namedKey = named
        ? await consolidateMemberProject(tx, identity, named)
        : batchNames.get(candidate.displayName);
      if (namedKey) {
        // Existing 2.1 clients already consume these bindings and replace their
        // local entries from the returned policy, so no client update is needed.
        await rememberScopeAlias(
          tx,
          identity,
          "scope",
          candidate.scopeKey,
          namedKey,
        );
        if (candidate.identityKey)
          await rememberScopeAlias(
            tx,
            identity,
            "identity",
            candidate.identityKey,
            namedKey,
          );
        bindings.push({
          requestedScopeKey: candidate.scopeKey,
          scopeKey: namedKey,
          resolution: "member_name_match",
        });
        candidates.push({
          scopeKey: namedKey,
          displayName: candidate.displayName,
          sessionCount: candidate.sessionCount,
        });
        batchNames.set(candidate.displayName, namedKey);
        continue;
      }
      const aliases = await tx`select scope_key from project_scope_aliases
        where plugin_instance_id=${identity.pluginInstanceId} and
          (alias_kind='identity' and alias_key=${candidate.identityKey ?? ""})
        order by (alias_kind='identity') desc limit 1`;
      if (aliases[0]) {
        const live = await tx`select scope_key from project_scope_entries
          where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${aliases[0].scope_key}`;
        if (live[0]) {
          const canonicalKey = live[0].scope_key;
          bindings.push({
            requestedScopeKey: candidate.scopeKey,
            scopeKey: canonicalKey,
            resolution: "alias_match",
          });
          candidates.push({
            scopeKey: canonicalKey,
            displayName: candidate.displayName,
            sessionCount: candidate.sessionCount,
          });
          batchNames.set(candidate.displayName, canonicalKey);
          continue;
        }
      }
      const identities = await tx<
        Array<{ identity_key: string; scope_key: string }>
      >`
        select identity_key, scope_key from project_scope_identities
        where plugin_instance_id = ${identity.pluginInstanceId}
          and (scope_key = ${candidate.scopeKey} or identity_key = ${candidate.identityKey ?? ""})
        union
        select alias_key as identity_key,scope_key from project_scope_aliases
        where plugin_instance_id=${identity.pluginInstanceId} and alias_kind='identity'
          and (scope_key=${candidate.scopeKey} or alias_key=${candidate.identityKey ?? ""})
      `;
      const byIdentity = identities.find(
        (row) => row.identity_key === candidate.identityKey,
      );
      const byKey =
        identities.find(
          (row) =>
            row.scope_key === candidate.scopeKey &&
            row.identity_key === candidate.identityKey,
        ) ?? identities.find((row) => row.scope_key === candidate.scopeKey);
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
        union select alias_key as identity_key from project_scope_aliases
        where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${scopeKey} and alias_kind='identity'
      `;
      if (
        occupied.length &&
        !occupied.some((row) => row.identity_key === candidate.identityKey)
      ) {
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
      batchNames.set(candidate.displayName, scopeKey);
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
