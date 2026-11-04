import { sqlClient as sql } from "./client.js";
import { PROMPT_SAMPLE_TURNS } from "./session-judge.js";

export const PREVIEW_LENGTH = 240;
const PROMPT_SAMPLE_LENGTH = 200;

type Scope = {
  tenantId: string;
  teamId: string;
  partnerId?: string | undefined;
  periodId?: string | undefined;
};

// Every upload re-sends whole sessions, so one conversation appears in many
// packages; the newest copy (within the chosen period, if any) is canonical.
// Shared by the session list and the preprocessing pipeline so both agree on
// what "a session" is.
export function latestSessionsCte(scope: Scope) {
  return sql`
    latest as (
      select distinct on (d.partner_id, s.item->>'scopeKey', s.item->>'agent', s.item->>'id')
        u.id as upload_id, d.partner_id, d.team_id, d.tenant_id, d.scope_instance_id,
        rp.id as period_id, u.period_key,
        s.item->>'id' as session_id, s.item->>'scopeKey' as scope_key, s.item->>'agent' as agent,
        s.item->>'title' as title, (s.item->>'modifiedAt')::timestamptz as modified_at,
        jsonb_array_length(s.item->'turns')::int as turn_count,
        left(s.item->'turns'->0->>'prompt', ${PREVIEW_LENGTH}) as preview,
        (select coalesce(jsonb_agg(q.turn->>'questionTime' order by q.n), '[]'::jsonb)
           from jsonb_array_elements(s.item->'turns') with ordinality q(turn, n)) as question_times,
        (select coalesce(jsonb_agg(left(t.turn->>'prompt', ${PROMPT_SAMPLE_LENGTH}) order by t.n), '[]'::jsonb)
           from jsonb_array_elements(s.item->'turns') with ordinality t(turn, n)
          where t.n <= ${PROMPT_SAMPLE_TURNS}) as prompts
      from collector_uploads u
      join collector_devices d on d.id = u.device_id
      join report_periods rp on rp.tenant_id = d.tenant_id and rp.team_id = d.team_id
        and rp.period_key = u.period_key
      join collector_upload_parts p on p.upload_id = u.id
      cross join lateral jsonb_array_elements(p.sessions) s(item)
      where d.tenant_id = ${scope.tenantId} and d.team_id = ${scope.teamId}
        and u.status = 'completed' and d.status <> 'test'
        and (${scope.partnerId ?? null}::uuid is null or d.partner_id = ${scope.partnerId ?? null})
        and (${scope.periodId ?? null}::uuid is null or rp.id = ${scope.periodId ?? null})
      order by d.partner_id, s.item->>'scopeKey', s.item->>'agent', s.item->>'id',
        (s.item->>'modifiedAt')::timestamptz desc, u.ends_at desc, u.created_at desc
    )
  `;
}

// Resolves a session's scope to the admin-facing project name (via aliases).
export const projectNameJoin = sql`
  left join project_scope_aliases a on a.plugin_instance_id = l.scope_instance_id
    and a.alias_kind = 'scope' and a.alias_key = l.scope_key
  left join project_scope_entries e on e.plugin_instance_id = l.scope_instance_id
    and e.scope_key = coalesce(a.scope_key, l.scope_key)
`;
