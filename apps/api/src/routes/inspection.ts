import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  InspectionRunningError,
  queueInspectionAnalysis,
  runInspection,
  sqlClient as sql,
} from "@partner-report/db";
import { ApiError, audit, requireWebActor } from "../common.js";

const listQuerySchema = z
  .object({
    status: z.enum(["open", "resolved"]).optional(),
    chain: z.enum(["app", "system", "pipeline"]).optional(),
    partnerId: z.string().uuid().optional(),
  })
  .strict();

type FindingRow = {
  id: string;
  chain: string;
  rule: string;
  severity: string;
  partner_id: string | null;
  partner_name: string | null;
  subject: string;
  title: string;
  evidence: { jobIds?: unknown } | null;
  status: string;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  occurrences: number;
  analysis: unknown;
  analysis_status: string;
};
type JobStatusRow = {
  id: string;
  type: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: Date | null;
};
type AnalysisJobRow = {
  finding_id: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
};

const modelConfiguredInApi = () =>
  Boolean(process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY);

export async function inspectionRoutes(app: FastifyInstance) {
  app.get("/v1/admin/inspection", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = listQuerySchema.parse(request.query);
    const status = query.status ?? "open";
    const [findings, counts, members, runs, running, worker] = await Promise.all([
      sql<FindingRow[]>`
        select f.id, f.chain, f.rule, f.severity, f.partner_id, p.display_name as partner_name, f.subject, f.title,
          f.evidence, f.status, f.first_seen_at, f.last_seen_at, f.resolved_at, f.occurrences, f.analysis,
          f.analysis_status
        from inspection_findings f left join partners p on p.id = f.partner_id and p.tenant_id = f.tenant_id
        where f.tenant_id = ${actor.tenantId} and f.team_id = ${actor.teamId} and f.status = ${status}
          and (${query.chain ?? null}::text is null or f.chain = ${query.chain ?? null})
          and (${query.partnerId ?? null}::uuid is null or f.partner_id = ${query.partnerId ?? null})
        order by case f.severity when 'critical' then 0 else 1 end, f.last_seen_at desc
        limit 500`,
      sql<{ status: string; chain: string; severity: string; count: number }[]>`
        select status, chain, severity, count(*)::int as count from inspection_findings
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        group by status, chain, severity`,
      sql<{ id: string; name: string }[]>`
        select id, display_name as name from partners
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and status = 'active'
        order by display_name`,
      sql<
        {
          id: string;
          trigger: string;
          started_at: Date;
          finished_at: Date | null;
          opened_count: number;
          resolved_count: number;
          open_count: number;
          error: string | null;
        }[]
      >`
        select id, trigger, started_at, finished_at, opened_count, resolved_count, open_count, error
        from inspection_runs where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        order by started_at desc limit 1`,
      sql<{ id: string }[]>`
        select id from inspection_runs
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and finished_at is null
          and started_at > now() - interval '10 minutes' limit 1`,
      sql<{ capabilities: { modelConfigured?: boolean } | null }[]>`
        select capabilities from service_heartbeats where name = 'worker'`,
    ]);

    const jobIdsOf = (finding: FindingRow) =>
      Array.isArray(finding.evidence?.jobIds)
        ? finding.evidence.jobIds.filter((id): id is string => typeof id === "string")
        : [];
    const allJobIds = [...new Set(findings.flatMap(jobIdsOf))];
    const findingIds = findings.map((finding) => finding.id);
    const [jobs, analysisJobs] = await Promise.all([
      allJobIds.length
        ? sql<JobStatusRow[]>`
            select id, type, status, error_code, error_message, attempt_count, max_attempts, next_retry_at
            from agent_jobs
            where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and id = any(${allJobIds}::uuid[])`
        : Promise.resolve([] as JobStatusRow[]),
      findingIds.length
        ? sql<AnalysisJobRow[]>`
            select distinct on (input_payload->>'findingId') input_payload->>'findingId' as finding_id,
              status, error_code, error_message
            from agent_jobs
            where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
              and type = 'ANALYZE_INSPECTION_FINDING' and input_payload->>'findingId' = any(${findingIds}::text[])
            order by input_payload->>'findingId', created_at desc`
        : Promise.resolve([] as AnalysisJobRow[]),
    ]);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const analysisByFinding = new Map(analysisJobs.map((job) => [job.finding_id, job]));

    const summary = {
      open: {
        app: { warning: 0, critical: 0 },
        system: { warning: 0, critical: 0 },
        pipeline: { warning: 0, critical: 0 },
      } as Record<string, { warning: number; critical: number }>,
      openTotal: 0,
      resolvedTotal: 0,
    };
    for (const row of counts) {
      if (row.status === "resolved") summary.resolvedTotal += row.count;
      else if (row.status === "open") {
        summary.openTotal += row.count;
        const bucket = summary.open[row.chain];
        if (bucket && (row.severity === "warning" || row.severity === "critical"))
          bucket[row.severity] += row.count;
      }
    }

    const lastRun = runs[0];
    return {
      checkedAt: new Date().toISOString(),
      running: running.length > 0,
      modelConfigured:
        modelConfiguredInApi() || worker[0]?.capabilities?.modelConfigured === true,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            trigger: lastRun.trigger,
            startedAt: lastRun.started_at,
            finishedAt: lastRun.finished_at,
            openedCount: lastRun.opened_count,
            resolvedCount: lastRun.resolved_count,
            openCount: lastRun.open_count,
            error: lastRun.error,
          }
        : null,
      summary,
      members,
      findings: findings.map((finding) => {
        const analysisJob = analysisByFinding.get(finding.id);
        return {
          id: finding.id,
          chain: finding.chain,
          rule: finding.rule,
          severity: finding.severity,
          partnerId: finding.partner_id,
          partnerName: finding.partner_name,
          subject: finding.subject,
          title: finding.title,
          evidence: finding.evidence ?? {},
          status: finding.status,
          firstSeenAt: finding.first_seen_at,
          lastSeenAt: finding.last_seen_at,
          resolvedAt: finding.resolved_at,
          occurrences: finding.occurrences,
          analysis: finding.analysis ?? null,
          analysisStatus: finding.analysis_status,
          analysisError:
            finding.analysis_status === "failed" && analysisJob?.error_code
              ? { code: analysisJob.error_code, message: analysisJob.error_message ?? "" }
              : null,
          jobs: jobIdsOf(finding).flatMap((id) => {
            const job = jobsById.get(id);
            return job
              ? [
                  {
                    id: job.id,
                    type: job.type,
                    status: job.status,
                    errorCode: job.error_code,
                    errorMessage: job.error_message,
                    attemptCount: job.attempt_count,
                    maxAttempts: job.max_attempts,
                    nextRetryAt: job.next_retry_at,
                  },
                ]
              : [];
          }),
        };
      }),
    };
  });

  app.post("/v1/admin/inspection/run", async (request) => {
    const actor = await requireWebActor(request, "admin");
    try {
      const result = await runInspection(sql, {
        tenantId: actor.tenantId,
        teamId: actor.teamId,
        trigger: "manual",
      });
      for (const findingId of [...result.opened, ...result.escalated])
        await queueInspectionAnalysis(sql, {
          tenantId: actor.tenantId,
          teamId: actor.teamId,
          findingId,
          reason: "detected",
          detectedAt: result.run.startedAt,
        });
      await audit(request, actor, "inspection.run", "inspection_run", result.run.id, {
        opened: result.opened.length,
        resolved: result.resolvedCount,
      });
      return { ok: true, run: result.run };
    } catch (error) {
      if (error instanceof InspectionRunningError)
        throw new ApiError(409, "INSPECTION_RUNNING", "巡检正在进行，请稍后再试。");
      throw error;
    }
  });

  app.post("/v1/admin/inspection/findings/:id/analyze", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const queued = await queueInspectionAnalysis(sql, {
      tenantId: actor.tenantId,
      teamId: actor.teamId,
      findingId: id,
      reason: "manual",
    });
    if (!queued) throw new ApiError(404, "NOT_FOUND", "巡检发现不存在。");
    await audit(request, actor, "inspection.analysis_requested", "inspection_finding", id, {
      jobId: queued.jobId,
    });
    return { ok: true, analysisStatus: "queued" as const };
  });
}
