\set ON_ERROR_STOP on

begin;

lock table
  tenants,
  users,
  teams,
  memberships,
  partners,
  external_identities,
  web_sessions
in share mode;

create temporary table google_auth_guard as
select
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from tenants t)
    as tenants_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from users t)
    as users_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from memberships t)
    as memberships_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from partners t)
    as partners_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from external_identities t)
    as external_identities_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from web_sessions t)
    as web_sessions_hash;

truncate table
  work_item_facts,
  work_item_versions,
  review_changes,
  team_report_versions,
  team_reports,
  agent_jobs,
  work_item_snapshots,
  work_items,
  reviews,
  fact_snapshots,
  coverage_snapshots,
  session_facts,
  session_records,
  sync_batches,
  collection_runs,
  report_periods,
  feishu_deliveries,
  feishu_inbox_events,
  feishu_partner_bindings,
  outbox_events,
  plugin_log_events,
  plugin_diagnostic_events,
  project_description_candidates,
  project_scope_entries,
  project_scope_policies,
  plugin_binding_codes,
  plugin_device_authorizations,
  plugin_instances,
  audit_events;

update projects
set
  description = null,
  description_source_fingerprint = null,
  description_updated_at = null
where
  description is not null
  or description_source_fingerprint is not null
  or description_updated_at is not null;

do $$
declare
  before_state google_auth_guard%rowtype;
  after_state google_auth_guard%rowtype;
begin
  select * into before_state from google_auth_guard;
  select
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from tenants t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from users t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from memberships t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from partners t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from external_identities t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from web_sessions t)
  into after_state;

  if before_state is distinct from after_state then
    raise exception 'Google auth guard failed; transaction will be rolled back';
  end if;
end
$$;

commit;

select 'external_identities' as entity, count(*) as remaining from external_identities
union all select 'memberships', count(*) from memberships
union all select 'plugin_instances', count(*) from plugin_instances
union all select 'project_descriptions', count(*) from projects where description is not null
union all select 'project_scope_entries', count(*) from project_scope_entries
union all select 'session_facts', count(*) from session_facts
union all select 'session_records', count(*) from session_records
union all select 'team_reports', count(*) from team_reports
union all select 'users', count(*) from users
union all select 'web_sessions', count(*) from web_sessions
order by entity;
