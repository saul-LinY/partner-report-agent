import { randomUUID } from "node:crypto";
import { sqlClient as sql } from "./client.js";
import { judgeSession, RULE_VERSION } from "./session-judge.js";
import { latestSessionsCte } from "./latest-sessions.js";

type PendingRow = {
  partner_id: string;
  scope_key: string;
  agent: string;
  session_id: string;
  modified_at: Date;
  turn_count: number;
  prompts: Array<string | null>;
};

/**
 * Judges sessions that have no verdict yet or whose machine verdict is stale
 * (older rules, or the session changed). Human verdicts are never touched.
 */
export async function syncSessionPreprocess(scope: {
  tenantId: string;
  teamId: string;
}) {
  const pending = await sql<PendingRow[]>`
    with ${latestSessionsCte(scope)}
    select l.partner_id, coalesce(l.scope_key, '') as scope_key, l.agent, l.session_id,
      l.modified_at, l.turn_count, l.prompts
    from latest l
    left join session_preprocess sp on sp.tenant_id = ${scope.tenantId}
      and sp.partner_id = l.partner_id and sp.scope_key = coalesce(l.scope_key, '')
      and sp.agent = l.agent and sp.session_id = l.session_id
    where sp.id is null
      or (sp.decided_by <> 'human'
        and (sp.rule_version <> ${RULE_VERSION}
          or sp.source_modified_at is distinct from l.modified_at))
  `;
  if (!pending.length) return 0;
  await sql.begin(async (tx) => {
    for (const row of pending) {
      const judged = judgeSession({
        turnCount: row.turn_count,
        prompts: row.prompts,
      });
      const reason = judged.verdict === "drop" ? judged.reason : null;
      await tx`
        insert into session_preprocess (id, tenant_id, team_id, partner_id, scope_key, agent,
          session_id, verdict, reason, decided_by, rule_version, source_modified_at)
        values (${randomUUID()}, ${scope.tenantId}, ${scope.teamId}, ${row.partner_id},
          ${row.scope_key}, ${row.agent}, ${row.session_id}, ${judged.verdict}, ${reason},
          'rule', ${RULE_VERSION}, ${row.modified_at})
        on conflict (tenant_id, partner_id, scope_key, agent, session_id) do update set
          verdict = excluded.verdict, reason = excluded.reason, decided_by = 'rule',
          rule_version = excluded.rule_version,
          source_modified_at = excluded.source_modified_at, updated_at = now()
        where session_preprocess.decided_by <> 'human'
      `;
    }
  });
  return pending.length;
}
