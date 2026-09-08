// Project redirects are scoped to a member's plugin instances. Existing facts
// remain immutable; the worker resolves their project before building cards.
export async function loadMemberProjectRedirects(
  database: any,
  identity: {
    tenantId: string;
    teamId: string;
    partnerId: string;
  },
) {
  const rows = await database`select distinct on (a.alias_key)
      a.alias_key as old_project_id,p.id as project_id,p.name
    from project_scope_aliases a
    join plugin_instances pi on pi.id=a.plugin_instance_id
    join projects p on p.tenant_id=pi.tenant_id and p.team_id=pi.team_id
      and p.status='active' and p.external_ids @>
        jsonb_build_array('scope:' || a.plugin_instance_id::text || ':' || a.scope_key)
    where pi.tenant_id=${identity.tenantId} and pi.team_id=${identity.teamId}
      and pi.partner_id=${identity.partnerId} and a.alias_kind='project'
    order by a.alias_key,p.created_at,p.id`;
  return new Map<string, { id: string; name: string }>(
    rows.map((row: any) => [
      row.old_project_id,
      { id: row.project_id, name: row.name },
    ]),
  );
}
