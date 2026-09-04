import { randomUUID } from "node:crypto";
import { sqlClient as defaultDatabase } from "@partner-report/db";

type Database = typeof defaultDatabase;

type ScopeBackupIdentity = {
  tenantId: string;
  teamId: string;
  partnerId: string;
  pluginInstanceId: string;
};

export async function createProjectScopeBackup(
  identity: ScopeBackupIdentity,
  reason: string,
  database: any = defaultDatabase,
) {
  const sources = await database<
    Array<{
      partner_name: string;
      device_name: string;
      plugin_version: string;
      policy_version: number;
      entry_count: number;
      allowed_count: number;
      denied_count: number;
      pending_count: number;
    }>
  >`
    select p.display_name as partner_name, pi.device_name,
      pi.version as plugin_version, psp.version as policy_version,
      count(pse.id)::int as entry_count,
      count(*) filter (where pse.status = 'allowed')::int as allowed_count,
      count(*) filter (where pse.status = 'denied')::int as denied_count,
      count(*) filter (where pse.status = 'pending')::int as pending_count
    from plugin_instances pi
    join partners p on p.id = pi.partner_id and p.tenant_id = pi.tenant_id
    join project_scope_policies psp on psp.plugin_instance_id = pi.id
      and psp.tenant_id = pi.tenant_id
    join project_scope_entries pse on pse.plugin_instance_id = pi.id
      and pse.tenant_id = pi.tenant_id
    where pi.id = ${identity.pluginInstanceId}
      and pi.tenant_id = ${identity.tenantId}
      and pi.team_id = ${identity.teamId}
      and pi.partner_id = ${identity.partnerId}
    group by p.display_name, pi.device_name, pi.version, psp.version
  `;
  const source = sources[0];
  if (!source || source.entry_count === 0) return null;

  const snapshotId = randomUUID();
  const snapshots = await database<Array<{ created_at: Date | string }>>`
    insert into project_scope_backup_snapshots (
      id, tenant_id, team_id, partner_id, plugin_instance_id, partner_name,
      device_name, plugin_version, policy_version, reason, entry_count,
      allowed_count, denied_count, pending_count
    ) values (
      ${snapshotId}, ${identity.tenantId}, ${identity.teamId},
      ${identity.partnerId}, ${identity.pluginInstanceId},
      ${source.partner_name}, ${source.device_name}, ${source.plugin_version},
      ${source.policy_version}, ${reason}, ${source.entry_count},
      ${source.allowed_count}, ${source.denied_count}, ${source.pending_count}
    )
    returning created_at
  `;
  await database`
    insert into project_scope_backup_entries (
      id, snapshot_id, scope_key, display_name, status, effective_from,
      decided_at, first_seen_period_key, session_count
    )
    select gen_random_uuid(), ${snapshotId}, scope_key, display_name, status,
      effective_from, decided_at, first_seen_period_key, session_count
    from project_scope_entries
    where plugin_instance_id = ${identity.pluginInstanceId}
      and tenant_id = ${identity.tenantId}
  `;
  return {
    id: snapshotId,
    createdAt: new Date(snapshots[0]!.created_at).toISOString(),
  };
}

export async function loadLatestProjectScopeBackups(
  identity: { tenantId: string; teamId: string },
  database: Database = defaultDatabase,
) {
  const snapshots = await database<
    Array<{
      id: string;
      partner_name: string;
      device_name: string;
      plugin_version: string;
      policy_version: number;
      reason: string;
      entry_count: number;
      allowed_count: number;
      denied_count: number;
      pending_count: number;
      created_at: Date | string;
    }>
  >`
    select id, partner_name, device_name, plugin_version, policy_version,
      reason, entry_count, allowed_count, denied_count, pending_count,
      created_at
    from (
      select backups.*,
        row_number() over (
          partition by plugin_instance_id
          order by created_at desc, id desc
        ) as position
      from project_scope_backup_snapshots backups
      where tenant_id = ${identity.tenantId} and team_id = ${identity.teamId}
    ) latest
    where position = 1
    order by partner_name, device_name
  `;
  if (snapshots.length === 0) {
    return {
      backedUpAt: null,
      summary: { total: 0, allowed: 0, denied: 0, pending: 0 },
      plugins: [],
    };
  }

  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  const entries = await database<
    Array<{
      snapshot_id: string;
      display_name: string;
      status: "pending" | "allowed" | "denied";
      effective_from: Date | string | null;
      decided_at: Date | string | null;
      first_seen_period_key: string;
      session_count: number;
    }>
  >`
    select snapshot_id, display_name, status, effective_from, decided_at,
      first_seen_period_key, session_count
    from project_scope_backup_entries
    where snapshot_id in ${database(snapshotIds)}
    order by display_name
  `;
  const backedUpAt = snapshots.reduce((latest, snapshot) => {
    const value = new Date(snapshot.created_at);
    return value > latest ? value : latest;
  }, new Date(0));

  return {
    backedUpAt: backedUpAt.toISOString(),
    summary: snapshots.reduce(
      (summary, snapshot) => ({
        total: summary.total + snapshot.entry_count,
        allowed: summary.allowed + snapshot.allowed_count,
        denied: summary.denied + snapshot.denied_count,
        pending: summary.pending + snapshot.pending_count,
      }),
      { total: 0, allowed: 0, denied: 0, pending: 0 },
    ),
    plugins: snapshots.map((snapshot) => ({
      partnerName: snapshot.partner_name,
      deviceName: snapshot.device_name,
      pluginVersion: snapshot.plugin_version,
      policyVersion: snapshot.policy_version,
      reason: snapshot.reason,
      backedUpAt: new Date(snapshot.created_at).toISOString(),
      summary: {
        total: snapshot.entry_count,
        allowed: snapshot.allowed_count,
        denied: snapshot.denied_count,
        pending: snapshot.pending_count,
      },
      projects: entries
        .filter((entry) => entry.snapshot_id === snapshot.id)
        .map((entry) => ({
          name: entry.display_name,
          permission: entry.status,
          effectiveFrom: entry.effective_from
            ? new Date(entry.effective_from).toISOString()
            : null,
          decidedAt: entry.decided_at
            ? new Date(entry.decided_at).toISOString()
            : null,
          firstSeenPeriodKey: entry.first_seen_period_key,
          sessionCount: entry.session_count,
        })),
    })),
  };
}
