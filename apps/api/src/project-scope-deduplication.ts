import { randomUUID } from "node:crypto";
import type { ScopeIdentity } from "./project-scope.js";
import { createProjectScopeBackup } from "./project-scope-backup.js";

export async function rememberScopeAlias(
  tx: any,
  identity: ScopeIdentity,
  kind: "scope" | "identity" | "project",
  alias: string,
  scopeKey: string,
) {
  await tx`insert into project_scope_aliases (id,plugin_instance_id,alias_kind,alias_key,scope_key)
    values (${randomUUID()},${identity.pluginInstanceId},${kind},${alias},${scopeKey})
    on conflict (plugin_instance_id,alias_kind,alias_key) do update
    set scope_key=excluded.scope_key,updated_at=now()
    where project_scope_aliases.scope_key<>excluded.scope_key`;
}

// Name equality is an explicit member-scoped business rule. No fuzzy or
// case-insensitive matching, and no authorization based on another member.
export async function matchMemberProjectName(
  tx: any,
  identity: ScopeIdentity,
  name: string,
) {
  const rows =
    await tx`select e.*,reapproval.created_at as reopened_at from project_scope_entries e
    left join lateral (
      select s.created_at from project_scope_backup_snapshots s
      join project_scope_backup_entries b on b.snapshot_id=s.id and b.scope_key=e.scope_key
      where s.plugin_instance_id=e.plugin_instance_id and s.reason='admin_reapproval'
        and e.status='pending'
      order by s.created_at desc limit 1
    ) reapproval on true
    where e.tenant_id=${identity.tenantId} and e.team_id=${identity.teamId}
      and e.partner_id=${identity.partnerId} and e.display_name=${name}
    order by (e.plugin_instance_id=${identity.pluginInstanceId}) desc,e.first_seen_at,e.scope_key`;
  if (!rows.length) return null;
  const canonical = rows[0];
  const decisions = [...rows]
    .filter((row: any) => row.decided_at || row.reopened_at)
    .sort(
      (a: any, b: any) =>
        new Date(b.reopened_at ?? b.decided_at).getTime() -
          new Date(a.reopened_at ?? a.decided_at).getTime() ||
        (a.status === "denied" ? -1 : b.status === "denied" ? 1 : 0),
    );
  const decision = decisions[0] ?? canonical;
  return { canonical, decision, rows };
}

async function attachFormalProject(
  tx: any,
  identity: ScopeIdentity,
  canonicalKey: string,
  rows: any[],
) {
  const externalIds = [
    ...new Set(
      rows.map((row) => `scope:${row.plugin_instance_id}:${row.scope_key}`),
    ),
  ];
  const projects = await tx`select p.* from projects p
    where p.tenant_id=${identity.tenantId} and p.team_id=${identity.teamId} and p.status='active'
      and p.external_ids ?| ${externalIds}
    order by p.created_at,p.id`;
  if (!projects.length) return;
  const project = projects[0];
  const canonicalId = `scope:${identity.pluginInstanceId}:${canonicalKey}`;
  const combined = [
    ...new Set([...project.external_ids, ...externalIds, canonicalId]),
  ];
  await tx`update projects set external_ids=${JSON.stringify(combined)}::jsonb,updated_at=now()
    where id=${project.id} and external_ids<>${JSON.stringify(combined)}::jsonb`;
  // Preserve historical project records; redirect this member's future grouping.
  for (const old of projects)
    await rememberScopeAlias(tx, identity, "project", old.id, canonicalKey);
}

export async function consolidateMemberProject(
  tx: any,
  identity: ScopeIdentity,
  match: NonNullable<Awaited<ReturnType<typeof matchMemberProjectName>>>,
) {
  const { canonical, decision, rows } = match;
  const own = rows.filter(
    (row: any) => row.plugin_instance_id === identity.pluginInstanceId,
  );
  const changed =
    own.length !== 1 ||
    own[0].status !== decision.status ||
    String(own[0].decided_at) !== String(decision.decided_at) ||
    String(own[0].effective_from) !== String(decision.effective_from);
  if (changed && own.length)
    await createProjectScopeBackup(
      identity,
      "before_member_name_deduplication",
      tx,
    );
  if (!own.length) {
    await tx`insert into project_scope_entries
      (id,tenant_id,team_id,partner_id,plugin_instance_id,scope_key,display_name,status,
       effective_from,decided_at,first_seen_period_key,session_count)
      values (${randomUUID()},${identity.tenantId},${identity.teamId},${identity.partnerId},
        ${identity.pluginInstanceId},${canonical.scope_key},${canonical.display_name},${decision.status},
        ${decision.effective_from},${decision.decided_at},${canonical.first_seen_period_key},${canonical.session_count})`;
  } else if (changed) {
    await tx`update project_scope_entries set status=${decision.status},effective_from=${decision.effective_from},
      decided_at=${decision.decided_at},session_count=${Math.max(...own.map((row: any) => row.session_count))},updated_at=now()
      where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${canonical.scope_key}`;
  }
  for (const row of own) {
    if (row.scope_key === canonical.scope_key) continue;
    await rememberScopeAlias(
      tx,
      identity,
      "scope",
      row.scope_key,
      canonical.scope_key,
    );
    await tx`update project_scope_aliases set scope_key=${canonical.scope_key},updated_at=now()
      where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${row.scope_key}`;
    const identities =
      await tx`select identity_key from project_scope_identities
      where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${row.scope_key}`;
    for (const item of identities)
      await rememberScopeAlias(
        tx,
        identity,
        "identity",
        item.identity_key,
        canonical.scope_key,
      );
    await tx`delete from project_scope_identities where plugin_instance_id=${identity.pluginInstanceId} and scope_key=${row.scope_key}`;
    await tx`delete from project_scope_entries where id=${row.id}`;
  }
  await attachFormalProject(tx, identity, canonical.scope_key, rows);
  if (changed) {
    await tx`update project_scope_policies set version=version+1,updated_at=now(),
      initialized=case when ${decision.status !== "pending"} then true else initialized end,
      initialized_at=case when ${decision.status !== "pending"} then coalesce(initialized_at,now()) else initialized_at end
      where plugin_instance_id=${identity.pluginInstanceId}`;
    await tx`insert into audit_events
      (id,tenant_id,team_id,actor_type,actor_id,action,target_type,target_id,request_id,metadata)
      values (${randomUUID()},${identity.tenantId},${identity.teamId},'plugin',${identity.pluginInstanceId},
       'project_scope.name_deduplicated','plugin_instance',${identity.pluginInstanceId},${randomUUID()},
       ${JSON.stringify({ canonicalScopeKey: canonical.scope_key, removed: Math.max(0, own.length - 1), status: decision.status })}::jsonb)`;
  }
  return canonical.scope_key as string;
}

export async function deduplicateExistingScopes(
  tx: any,
  identity: ScopeIdentity,
) {
  const names = await tx`select distinct display_name from project_scope_entries
    where plugin_instance_id=${identity.pluginInstanceId}`;
  for (const row of names) {
    const match = await matchMemberProjectName(tx, identity, row.display_name);
    if (match) await consolidateMemberProject(tx, identity, match);
  }
}
