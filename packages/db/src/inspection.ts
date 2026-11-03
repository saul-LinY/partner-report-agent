import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { suppressedAppNotificationKinds } from "./app-notifications.js";
import {
  evaluateInspection,
  type InspectionClientState,
  type InspectionDatabaseProbe,
  type InspectionFindingDraft,
  type InspectionInput,
} from "./inspection-rules.js";

// postgres.js types TransactionSql as a subset of Sql; it is callable identically as a tagged template.
type Database = Sql;

type DeviceRow = {
  id: string;
  partner_id: string;
  partner_name: string;
  device_name: string;
  created_at: Date;
  last_log_at: Date | null;
  last_upload_at: Date | null;
  client_state: InspectionClientState | null;
};
type EventRow = {
  event_id: string;
  device_id: string;
  occurred_at: Date;
  received_at: Date;
  stage: string;
  level: string;
  code: string;
  details: { httpStatus?: number; errorKind?: string } | null;
};
type UploadRow = {
  id: string;
  device_id: string;
  partner_id: string;
  period_key: string;
  status: string;
  updated_at: Date;
  completed_at: Date | null;
  analysis_enqueued_at: Date | null;
};
type NotificationRow = {
  id: string;
  partner_id: string;
  created_at: Date;
  delivered_at: Date | null;
};
type JobRow = {
  id: string;
  type: string;
  status: string;
  partner_id: string | null;
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  lease_until: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type TeamReportRow = { id: string; status: string; updated_at: Date };
type MemberPeriodRow = {
  partner_id: string;
  partner_name: string;
  period_key: string;
  period_status: string;
  upload_id: string;
  job_statuses: string[];
  analysis_finished_at: Date | null;
  fact_count: number;
  has_aggregate_job: boolean;
  has_review: boolean;
};
type HeartbeatRow = { heartbeat_at: Date; status: string; error_code: string | null };
type RunRow = {
  id: string;
  trigger: InspectionTrigger;
  started_at: Date;
  finished_at: Date | null;
  opened_count: number;
  resolved_count: number;
  open_count: number;
  error: string | null;
};
type FindingPayloadRow = {
  id: string;
  chain: string;
  rule: string;
  severity: string;
  partner_id: string | null;
  subject: string;
  title: string;
  evidence: Record<string, unknown> | null;
  status: string;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrences: number;
};
type PayloadEventRow = {
  occurred_at: Date;
  stage: string;
  level: string;
  code: string;
  session_count: number;
  message: string | null;
  details: Record<string, unknown> | null;
  device_name: string;
};
type PayloadJobRow = {
  id: string;
  type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type InspectionTrigger = "schedule" | "manual";

export type InspectionRunRecord = {
  id: string;
  trigger: InspectionTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  openedCount: number;
  resolvedCount: number;
  openCount: number;
  error: string | null;
};

export type InspectionRunResult = {
  run: InspectionRunRecord;
  /** Finding ids that were newly created or reopened by this run. */
  opened: string[];
  /** Finding ids whose severity rose from warning to critical in this run. */
  escalated: string[];
  resolvedCount: number;
};

export class InspectionRunningError extends Error {
  constructor() {
    super("INSPECTION_RUNNING");
    this.name = "InspectionRunningError";
  }
}

/** A run left unfinished longer than this (for example after a crash) no longer blocks new runs. */
const STALE_RUN_MINUTES = 10;
export const INSPECTION_ANALYSIS_JOB_TYPE = "ANALYZE_INSPECTION_FINDING";
const CENTRAL_JOB_TYPES = [
  "EXTRACT_COLLECTOR_SESSION",
  "AGGREGATE_WORK_ITEMS",
  "GENERATE_TEAM_REPORT",
  "REGENERATE_TEAM_REPORT",
];

/** Findings are unique per tenant in the database; team-level subjects such as `team` need the team in the key. */
const storedFingerprint = (teamId: string, fingerprint: string) =>
  `${teamId}:${fingerprint}`;

// The driver may hand timestamps back as ISO-like strings; rules require real Dates.
const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: Date | string | null) => (value === null ? null : toDate(value));

type Identity = { tenantId: string; teamId: string };

async function probeDatabase(database: Database): Promise<InspectionDatabaseProbe> {
  const started = Date.now();
  try {
    await database`select 1`;
    return { ok: true, durationMs: Date.now() - started };
  } catch {
    return { ok: false, durationMs: Date.now() - started };
  }
}

export async function loadInspectionInput(
  database: Database,
  { tenantId, teamId }: Identity,
  now: Date,
): Promise<InspectionInput> {
  const at = now.toISOString();
  const [team] = await database<{ timezone: string }[]>`
    select timezone from teams where id = ${teamId} and tenant_id = ${tenantId}`;
  if (!team) throw new Error("TEAM_NOT_FOUND");
  const [devices, events, uploads, notifications, jobs, teamReports, memberPeriods, workers, databaseProbe] =
    await Promise.all([
      database<DeviceRow[]>`
        select d.id, d.partner_id, p.display_name as partner_name, d.device_name, d.created_at,
          d.last_log_at, d.last_upload_at, d.client_state
        from collector_devices d
          join partners p on p.id = d.partner_id
          join plugin_binding_codes b on b.id = d.binding_code_id and b.status <> 'revoked'
          join plugin_instances scope on scope.id = d.scope_instance_id and scope.status in ('active', 'collector')
        where d.tenant_id = ${tenantId} and d.team_id = ${teamId} and d.status = 'active' and p.status = 'active'`,
      database<EventRow[]>`
        select l.event_id, l.device_id, l.occurred_at, l.received_at, l.stage, l.level, l.code, l.details
        from collector_logs l join collector_devices d on d.id = l.device_id
        where d.tenant_id = ${tenantId} and d.team_id = ${teamId} and d.status = 'active'
          and l.code <> 'ALIVE' and l.received_at > ${at}::timestamptz - interval '24 hours'
        order by l.occurred_at desc limit 5000`,
      database<UploadRow[]>`
        select u.id, u.device_id, d.partner_id, u.period_key, u.status, u.updated_at, u.completed_at, u.analysis_enqueued_at
        from collector_uploads u join collector_devices d on d.id = u.device_id
        where d.tenant_id = ${tenantId} and d.team_id = ${teamId} and d.status = 'active'
          and (u.status = 'receiving' or u.created_at > ${at}::timestamptz - interval '7 days')`,
      database<NotificationRow[]>`
        select id, partner_id, created_at, delivered_at from app_notifications
        where tenant_id = ${tenantId} and team_id = ${teamId} and delivered_at is null
          and kind not in ${database(suppressedAppNotificationKinds)}
        order by created_at limit 1000`,
      database<JobRow[]>`
        select id, type, status, partner_id, attempt_count, max_attempts, error_code, lease_until, next_retry_at,
          created_at, updated_at
        from agent_jobs
        where tenant_id = ${tenantId} and team_id = ${teamId} and type = any(${CENTRAL_JOB_TYPES}::text[])
          and (status in ('PENDING', 'LEASED', 'RETRY_WAIT')
            or (status = 'FAILED' and updated_at > ${at}::timestamptz - interval '7 days'))
        order by updated_at desc limit 2000`,
      database<TeamReportRow[]>`
        select id, status, updated_at from team_reports
        where tenant_id = ${tenantId} and team_id = ${teamId} and status = 'AGGREGATING'`,
      database<MemberPeriodRow[]>`
        select mp.partner_id, mp.partner_name, mp.period_key, mp.period_status, mp.upload_id,
          coalesce((
            select array_agg(distinct j.status)
            from collector_uploads u2
              join collector_devices d2 on d2.id = u2.device_id
              join collector_upload_jobs cuj on cuj.upload_id = u2.id
              join agent_jobs j on j.id = cuj.job_id
            where d2.tenant_id = ${tenantId} and d2.partner_id = mp.partner_id
              and u2.period_key = mp.period_key and u2.status = 'completed'
          ), '{}') as job_statuses,
          (
            select max(j.updated_at)
            from collector_uploads u2
              join collector_devices d2 on d2.id = u2.device_id
              join collector_upload_jobs cuj on cuj.upload_id = u2.id
              join agent_jobs j on j.id = cuj.job_id
            where d2.tenant_id = ${tenantId} and d2.partner_id = mp.partner_id
              and u2.period_key = mp.period_key and u2.status = 'completed'
          ) as analysis_finished_at,
          (
            select count(*)::int from session_facts sf
            where sf.tenant_id = ${tenantId} and sf.partner_id = mp.partner_id and sf.period_id = mp.period_id
              and sf.current = true and sf.excluded = false
          ) as fact_count,
          exists(
            select 1 from agent_jobs a
            where a.tenant_id = ${tenantId} and a.partner_id = mp.partner_id and a.type = 'AGGREGATE_WORK_ITEMS'
              and a.input_payload->'period'->>'id' = mp.period_id::text and a.status <> 'CANCELLED'
          ) as has_aggregate_job,
          exists(
            select 1 from reviews r
            where r.tenant_id = ${tenantId} and r.partner_id = mp.partner_id and r.period_id = mp.period_id
          ) as has_review
        from (
          select d.partner_id, p.display_name as partner_name, u.period_key, rp.id as period_id,
            rp.status as period_status, (array_agg(u.id order by u.completed_at desc))[1] as upload_id
          from collector_uploads u
            join collector_devices d on d.id = u.device_id
            join partners p on p.id = d.partner_id
            join report_periods rp on rp.tenant_id = d.tenant_id and rp.team_id = d.team_id and rp.period_key = u.period_key
          where d.tenant_id = ${tenantId} and d.team_id = ${teamId} and d.status = 'active'
            and u.status = 'completed' and u.analysis_enqueued_at is not null and rp.status in ('open', 'closing')
          group by d.partner_id, p.display_name, u.period_key, rp.id, rp.status
        ) mp`,
      database<HeartbeatRow[]>`select heartbeat_at, status, error_code from service_heartbeats where name = 'worker'`,
      probeDatabase(database),
    ]);
  return {
    now,
    timezone: team.timezone,
    devices: devices.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      deviceName: row.device_name,
      createdAt: toDate(row.created_at),
      lastLogAt: toDateOrNull(row.last_log_at),
      lastUploadAt: toDateOrNull(row.last_upload_at),
      clientState: row.client_state,
    })),
    events: events.map((row) => ({
      eventId: row.event_id,
      deviceId: row.device_id,
      occurredAt: toDate(row.occurred_at),
      receivedAt: toDate(row.received_at),
      stage: row.stage,
      level: row.level,
      code: row.code,
      details: row.details,
    })),
    uploads: uploads.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      partnerId: row.partner_id,
      periodKey: row.period_key,
      status: row.status,
      updatedAt: toDate(row.updated_at),
      completedAt: toDateOrNull(row.completed_at),
      analysisEnqueuedAt: toDateOrNull(row.analysis_enqueued_at),
    })),
    notifications: notifications.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      createdAt: toDate(row.created_at),
      deliveredAt: toDateOrNull(row.delivered_at),
    })),
    jobs: jobs.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      partnerId: row.partner_id,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      errorCode: row.error_code,
      leaseUntil: toDateOrNull(row.lease_until),
      nextRetryAt: toDateOrNull(row.next_retry_at),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    })),
    teamReports: teamReports.map((row) => ({
      id: row.id,
      status: row.status,
      updatedAt: toDate(row.updated_at),
    })),
    memberPeriods: memberPeriods.map((row) => ({
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      periodKey: row.period_key,
      periodStatus: row.period_status,
      uploadId: row.upload_id,
      analysisJobStatuses: row.job_statuses,
      analysisFinishedAt: toDateOrNull(row.analysis_finished_at),
      currentFactCount: row.fact_count,
      hasAggregateJob: row.has_aggregate_job,
      hasReview: row.has_review,
    })),
    worker: workers[0]
      ? {
          heartbeatAt: toDate(workers[0].heartbeat_at),
          status: workers[0].status,
          errorCode: workers[0].error_code,
        }
      : null,
    databaseProbe,
  };
}

/** Reserves the per-team run slot; throws when a run started in the last 10 minutes has not finished. */
async function startRun(
  database: Database,
  { tenantId, teamId }: Identity,
  trigger: InspectionTrigger,
  now: Date,
) {
  const id = randomUUID();
  await database.begin(async (tx) => {
    const [lock] = await tx<{ ok: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtextextended(${`inspection:${tenantId}:${teamId}`}, 0)) as ok`;
    if (!lock?.ok) throw new InspectionRunningError();
    const running = await tx`
      select id from inspection_runs
      where tenant_id = ${tenantId} and team_id = ${teamId} and finished_at is null
        and started_at > ${now.toISOString()}::timestamptz - ${STALE_RUN_MINUTES} * interval '1 minute'
      limit 1`;
    if (running.length > 0) throw new InspectionRunningError();
    await tx`
      insert into inspection_runs (id, tenant_id, team_id, trigger, started_at)
      values (${id}, ${tenantId}, ${teamId}, ${trigger}, ${now.toISOString()}::timestamptz)`;
  });
  return id;
}

async function applyFindings(
  tx: Database,
  { tenantId, teamId }: Identity,
  drafts: InspectionFindingDraft[],
  now: Date,
) {
  const at = now.toISOString();
  const opened: string[] = [];
  const escalated: string[] = [];
  const fingerprints = drafts.map((draft) => storedFingerprint(teamId, draft.fingerprint));
  const existing = new Map(
    (
      await tx<{ id: string; fingerprint: string; status: string; severity: string }[]>`
        select id, fingerprint, status, severity from inspection_findings
        where tenant_id = ${tenantId} and team_id = ${teamId} and fingerprint = any(${fingerprints}::text[])
        for update`
    ).map((row) => [row.fingerprint, row]),
  );
  for (const draft of drafts) {
    const fingerprint = storedFingerprint(teamId, draft.fingerprint);
    const previous = existing.get(fingerprint);
    if (!previous) {
      const id = randomUUID();
      await tx`
        insert into inspection_findings (
          id, tenant_id, team_id, fingerprint, chain, rule, severity, partner_id, subject, title, evidence,
          status, first_seen_at, last_seen_at, occurrences
        ) values (
          ${id}, ${tenantId}, ${teamId}, ${fingerprint}, ${draft.chain}, ${draft.rule}, ${draft.severity},
          ${draft.partnerId}, ${draft.subject}, ${draft.title}, ${JSON.stringify(draft.evidence)}::jsonb,
          'open', ${at}::timestamptz, ${at}::timestamptz, 1
        )`;
      opened.push(id);
      continue;
    }
    await tx`
      update inspection_findings set
        severity = ${draft.severity}, title = ${draft.title}, evidence = ${JSON.stringify(draft.evidence)}::jsonb,
        partner_id = ${draft.partnerId}, status = 'open', resolved_at = null,
        last_seen_at = ${at}::timestamptz, occurrences = occurrences + 1
      where id = ${previous.id}`;
    if (previous.status === "resolved") opened.push(previous.id);
    else if (previous.severity === "warning" && draft.severity === "critical")
      escalated.push(previous.id);
  }
  const resolved = await tx<{ id: string }[]>`
    update inspection_findings set status = 'resolved', resolved_at = ${at}::timestamptz
    where tenant_id = ${tenantId} and team_id = ${teamId} and status = 'open'
      and not (fingerprint = any(${fingerprints}::text[]))
    returning id`;
  return { opened, escalated, resolvedCount: resolved.length };
}

/**
 * Runs every inspection rule for one team and reconciles the stored findings. Throws
 * `InspectionRunningError` when another run for the team is in progress.
 */
export async function runInspection(
  database: Database,
  identity: Identity & { trigger: InspectionTrigger },
  now: Date = new Date(),
): Promise<InspectionRunResult> {
  const runId = await startRun(database, identity, identity.trigger, now);
  try {
    const input = await loadInspectionInput(database, identity, now);
    const drafts = evaluateInspection(input);
    return await database.begin(async (tx) => {
      const applied = await applyFindings(tx as unknown as Database, identity, drafts, now);
      const [counts] = await tx<{ open: number }[]>`
        select count(*)::int as open from inspection_findings
        where tenant_id = ${identity.tenantId} and team_id = ${identity.teamId} and status = 'open'`;
      const [row] = await tx<RunRow[]>`
        update inspection_runs set finished_at = now(), opened_count = ${applied.opened.length},
          resolved_count = ${applied.resolvedCount}, open_count = ${counts!.open}
        where id = ${runId}
        returning id, trigger, started_at, finished_at, opened_count, resolved_count, open_count, error`;
      return {
        run: toRunRecord(row!),
        opened: applied.opened,
        escalated: applied.escalated,
        resolvedCount: applied.resolvedCount,
      };
    });
  } catch (error) {
    await database`
      update inspection_runs set finished_at = now(), error = ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}
      where id = ${runId}`.catch(() => {});
    throw error;
  }
}

export function toRunRecord(row: RunRow): InspectionRunRecord {
  return {
    id: row.id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    openedCount: row.opened_count,
    resolvedCount: row.resolved_count,
    openCount: row.open_count,
    error: row.error,
  };
}

// ---------------------------------------------------------------------------------------------
// Analysis jobs
// ---------------------------------------------------------------------------------------------

/** Paths and long opaque tokens never reach the model, even if an upstream message carried them. */
export function sanitizeDiagnosticText(value: unknown, max = 300) {
  if (typeof value !== "string") return null;
  return value
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~+-]+){2,}[\\/]?/g, "[路径]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[令牌]")
    .slice(0, max);
}

/** Recent device events and related job rows for one finding; no session text or paths. */
export async function buildInspectionAnalysisPayload(
  database: Database,
  { tenantId, teamId, findingId }: Identity & { findingId: string },
) {
  const [finding] = await database<FindingPayloadRow[]>`
    select id, chain, rule, severity, partner_id, subject, title, evidence, status, first_seen_at, last_seen_at, occurrences
    from inspection_findings where id = ${findingId} and tenant_id = ${tenantId} and team_id = ${teamId}`;
  if (!finding) return null;
  const evidence = finding.evidence ?? {};
  const deviceId = typeof evidence.deviceId === "string" ? evidence.deviceId : null;
  const jobIds: string[] = Array.isArray(evidence.jobIds) ? evidence.jobIds.slice(0, 20) : [];
  const events =
    deviceId || finding.partner_id
      ? await database<PayloadEventRow[]>`
          select l.occurred_at, l.stage, l.level, l.code, l.session_count, l.message, l.details, d.device_name
          from collector_logs l join collector_devices d on d.id = l.device_id
          where d.tenant_id = ${tenantId} and d.team_id = ${teamId}
            and (${deviceId}::uuid is not null and l.device_id = ${deviceId}
              or ${deviceId}::uuid is null and d.partner_id = ${finding.partner_id})
            and l.code <> 'ALIVE'
          order by l.occurred_at desc limit 50`
      : [];
  const jobs = jobIds.length
    ? await database<PayloadJobRow[]>`
        select id, type, status, attempt_count, max_attempts, error_code, error_message, created_at, updated_at
        from agent_jobs
        where tenant_id = ${tenantId} and team_id = ${teamId} and id = any(${jobIds}::uuid[])`
    : [];
  return {
    findingId: finding.id,
    chain: finding.chain,
    rule: finding.rule,
    severity: finding.severity,
    subject: finding.subject,
    title: finding.title,
    status: finding.status,
    occurrences: finding.occurrences,
    firstSeenAt: finding.first_seen_at,
    lastSeenAt: finding.last_seen_at,
    evidence,
    events: events.map((event) => ({
      occurredAt: event.occurred_at,
      stage: event.stage,
      level: event.level,
      code: event.code,
      sessionCount: event.session_count,
      message: sanitizeDiagnosticText(event.message),
      details: event.details ?? {},
      deviceName: event.device_name,
    })),
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      errorCode: job.error_code,
      errorMessage: sanitizeDiagnosticText(job.error_message),
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })),
  };
}

/**
 * Queues one analysis job for a finding. `detected` (run side) is idempotent per detection time; `manual`
 * returns the job already in flight, otherwise queues a fresh one.
 */
export async function queueInspectionAnalysis(
  database: Database,
  input: Identity & { findingId: string } & (
      | { reason: "detected"; detectedAt: Date }
      | { reason: "manual" }
    ),
) {
  return database.begin(async (tx) => {
    const db = tx as unknown as Database;
    const [finding] = await db<{ id: string; partner_id: string | null }[]>`
      select id, partner_id from inspection_findings
      where id = ${input.findingId} and tenant_id = ${input.tenantId} and team_id = ${input.teamId}
      for update`;
    if (!finding) return null;
    if (input.reason === "manual") {
      const [active] = await db<{ id: string }[]>`
        select id from agent_jobs
        where tenant_id = ${input.tenantId} and team_id = ${input.teamId} and type = ${INSPECTION_ANALYSIS_JOB_TYPE}
          and input_payload->>'findingId' = ${input.findingId} and status in ('PENDING', 'LEASED', 'RETRY_WAIT')
        limit 1`;
      if (active) {
        await db`update inspection_findings set analysis_status = 'queued' where id = ${input.findingId}
          and analysis_status in ('none', 'failed')`;
        return { jobId: active.id, created: false };
      }
    }
    const payload = await buildInspectionAnalysisPayload(db, input);
    const key =
      input.reason === "detected"
        ? `inspection-analysis:${input.findingId}:${input.detectedAt.toISOString()}`
        : `inspection-analysis:${input.findingId}:manual:${randomUUID()}`;
    const jobId = randomUUID();
    const inserted = await db<{ id: string }[]>`
      insert into agent_jobs (id, tenant_id, team_id, partner_id, type, status, idempotency_key, input_payload)
      values (${jobId}, ${input.tenantId}, ${input.teamId}, ${finding.partner_id}, ${INSPECTION_ANALYSIS_JOB_TYPE},
        'PENDING', ${key}, ${JSON.stringify(payload)}::jsonb)
      on conflict (tenant_id, idempotency_key) do nothing
      returning id`;
    if (inserted.length === 0) return { jobId: null, created: false };
    await db`update inspection_findings set analysis_status = 'queued' where id = ${input.findingId}`;
    return { jobId, created: true };
  });
}
