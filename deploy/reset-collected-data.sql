\set ON_ERROR_STOP on

begin;

lock table
  users,
  memberships,
  partners,
  plugin_instances,
  feishu_partner_bindings,
  project_scope_policies,
  project_scope_entries
in share mode;

create temporary table binding_guard as
select
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from users t)
    as users_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from memberships t)
    as memberships_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from partners t)
    as partners_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from plugin_instances t)
    as plugin_instances_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from feishu_partner_bindings t)
    as feishu_bindings_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by plugin_instance_id), '')) from project_scope_policies t)
    as project_scope_policies_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from project_scope_entries t)
    as project_scope_entries_hash;

truncate table
  work_item_facts,
  review_changes,
  individual_reports,
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
  outbox_events;

do $$
declare
  before_state binding_guard%rowtype;
  after_state binding_guard%rowtype;
begin
  select * into before_state from binding_guard;
  select
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from users t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from memberships t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from partners t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from plugin_instances t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from feishu_partner_bindings t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by plugin_instance_id), '')) from project_scope_policies t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from project_scope_entries t)
  into after_state;

  if before_state is distinct from after_state then
    raise exception 'Binding guard failed; transaction will be rolled back';
  end if;
end
$$;

commit;

select 'users' as entity, count(*) as remaining from users
union all select 'partners', count(*) from partners
union all select 'plugin_instances', count(*) from plugin_instances
union all select 'feishu_partner_bindings', count(*) from feishu_partner_bindings
union all select 'project_scope_entries', count(*) from project_scope_entries
union all select 'session_records', count(*) from session_records
union all select 'session_facts', count(*) from session_facts
union all select 'individual_reports', count(*) from individual_reports
union all select 'team_reports', count(*) from team_reports
order by entity;

