import { z } from "zod";
import { sqlClient as sql } from "@partner-report/db";
import { generateStructured, ModelGatewayError } from "./model.js";

/**
 * Failures caused by the gateway rather than the input: wrong key, a model or endpoint the gateway does not serve,
 * exhausted quota, or an outage that outlasted every retry. The same request succeeds once the gateway answers again.
 */
export const GATEWAY_FAILURE_CODES = [
  "MODEL_NOT_CONFIGURED",
  "MODEL_AUTH_FAILED",
  "MODEL_NOT_FOUND",
  "MODEL_QUOTA_EXHAUSTED",
  "MODEL_RATE_LIMITED",
  "MODEL_SERVICE_UNAVAILABLE",
  "MODEL_REQUEST_TIMEOUT",
  "MODEL_NETWORK_ERROR",
];
const PIPELINE_JOB_TYPES = [
  "EXTRACT_COLLECTOR_SESSION",
  "AGGREGATE_WORK_ITEMS",
  "GENERATE_TEAM_REPORT",
  "REGENERATE_TEAM_REPORT",
];
const PROBE_INTERVAL_MS = 5 * 60_000;
// Each recovery grants three more attempts, like an admin retry; past this a job waits for a person.
const MAX_RECOVERED_ATTEMPTS = 12;
const RECOVERY_WINDOW = "30 days";

const lastProbe = new Map<string, number>();

/** One tiny structured call on exactly this model: proves key, endpoint and model all work. */
export async function probeModel(model: string) {
  await generateStructured({
    name: "partner_report_system_health",
    schema: z.object({ ok: z.literal(true) }),
    instructions: 'Return {"ok":true}.',
    input: { probe: "content_generation" },
    model,
    timeoutMs: 25_000,
    maxOutputTokens: 4096,
    noFallback: true,
  });
}

/**
 * Puts pipeline jobs that failed because the gateway was unusable back in the queue as soon as a probe of the team's
 * model succeeds. Probes run at most every five minutes per team and only while such jobs exist.
 */
export async function recoverGatewayFailures(
  tenantId?: string,
  now = Date.now(),
) {
  const teams = await sql<
    { tenant_id: string; team_id: string; central_model: string }[]
  >`
    select distinct j.tenant_id, j.team_id, t.central_model
    from agent_jobs j join teams t on t.id = j.team_id and t.tenant_id = j.tenant_id
    where j.status = 'FAILED' and j.type in ${sql(PIPELINE_JOB_TYPES)}
      and j.error_code in ${sql(GATEWAY_FAILURE_CODES)}
      and j.attempt_count < ${MAX_RECOVERED_ATTEMPTS}
      and j.updated_at > now() - ${RECOVERY_WINDOW}::interval
      and (${tenantId ?? null}::uuid is null or j.tenant_id = ${tenantId ?? null}::uuid)
  `;
  let requeued = 0;
  for (const team of teams) {
    const key = `${team.tenant_id}:${team.team_id}`;
    if (now - (lastProbe.get(key) ?? 0) < PROBE_INTERVAL_MS) continue;
    lastProbe.set(key, now);
    try {
      await probeModel(team.central_model);
    } catch (error) {
      console.warn("Model gateway still unusable; failed jobs wait for it", {
        teamId: team.team_id,
        model: team.central_model,
        code: error instanceof ModelGatewayError ? error.code : "UNKNOWN",
      });
      continue;
    }
    const rows = await sql<{ id: string }[]>`
      update agent_jobs set status = 'PENDING',
        max_attempts = greatest(max_attempts, attempt_count + 3),
        lease_token_hash = null, lease_until = null, completed_at = null,
        next_retry_at = null, updated_at = now()
      where tenant_id = ${team.tenant_id} and team_id = ${team.team_id}
        and status = 'FAILED' and type in ${sql(PIPELINE_JOB_TYPES)}
        and error_code in ${sql(GATEWAY_FAILURE_CODES)}
        and attempt_count < ${MAX_RECOVERED_ATTEMPTS}
        and updated_at > now() - ${RECOVERY_WINDOW}::interval
      returning id
    `;
    requeued += rows.length;
    console.log("Model gateway answers again; requeued failed jobs", {
      teamId: team.team_id,
      model: team.central_model,
      jobs: rows.length,
    });
  }
  return requeued;
}
