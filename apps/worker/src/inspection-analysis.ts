import {
  InspectionRunningError,
  queueInspectionAnalysis,
  runInspection,
  sqlClient as sql,
} from "@partner-report/db";

export const INSPECTION_INTERVAL_MS = 5 * 60_000;

/** Last scheduled attempt per team; a restart simply inspects again on the next tick. */
const lastAttempt = new Map<string, number>();

type ActiveTeam = { tenant_id: string; team_id: string };

/** Teams with a bound collector device, or with findings that still need to be resolved. */
async function activeTeams() {
  return sql<ActiveTeam[]>`
    select tenant_id, team_id from collector_devices where status = 'active'
    union
    select tenant_id, team_id from inspection_findings where status = 'open'`;
}

export async function runScheduledInspections(now = new Date()) {
  const summary = { teams: 0, opened: 0, escalated: 0, resolved: 0, analysisQueued: 0 };
  for (const team of await activeTeams()) {
    const key = `${team.tenant_id}:${team.team_id}`;
    const previous = lastAttempt.get(key);
    if (previous !== undefined && now.getTime() - previous < INSPECTION_INTERVAL_MS) continue;
    lastAttempt.set(key, now.getTime());
    try {
      const result = await runInspection(
        sql,
        { tenantId: team.tenant_id, teamId: team.team_id, trigger: "schedule" },
        now,
      );
      summary.teams += 1;
      summary.opened += result.opened.length;
      summary.escalated += result.escalated.length;
      summary.resolved += result.resolvedCount;
      summary.analysisQueued += await queueAnalysisFor(
        team.tenant_id,
        team.team_id,
        [...result.opened, ...result.escalated],
        now,
      );
    } catch (error) {
      if (error instanceof InspectionRunningError) continue;
      console.error(
        "Scheduled inspection failed",
        key,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return summary;
}

/** Queues one analysis job per newly opened or escalated finding; the key makes retries idempotent. */
export async function queueAnalysisFor(
  tenantId: string,
  teamId: string,
  findingIds: string[],
  detectedAt: Date,
) {
  let queued = 0;
  for (const findingId of findingIds) {
    const result = await queueInspectionAnalysis(sql, {
      tenantId,
      teamId,
      findingId,
      reason: "detected",
      detectedAt,
    });
    if (result?.created) queued += 1;
  }
  return queued;
}

export function resetInspectionScheduleForTests() {
  lastAttempt.clear();
}
