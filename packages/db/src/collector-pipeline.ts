import { createHash, randomUUID } from "node:crypto";
import { stableJsonHash } from "@partner-report/contracts/hash";
import {
  collectorSessionSchema,
  type CollectorSession,
} from "@partner-report/contracts";

export function collectorSessionKey(session: CollectorSession) {
  return createHash("sha256")
    .update(JSON.stringify([session.scopeKey, session.agent, session.id]))
    .digest("hex");
}

/** Enqueue immutable sources in the same transaction that acknowledges the package. */
export async function enqueueCollectorUpload(tx: any, uploadId: string) {
  const [upload] =
    await tx`select u.*,d.tenant_id,d.team_id,d.partner_id,d.scope_instance_id,rp.id as period_id,rp.starts_at as period_starts_at
    from collector_uploads u join collector_devices d on d.id=u.device_id
    join report_periods rp on rp.tenant_id=d.tenant_id and rp.team_id=d.team_id and rp.period_key=u.period_key
    where u.id=${uploadId} and u.status='completed' for update of u`;
  if (!upload || upload.analysis_enqueued_at) return;
  const [device] =
    await tx`select status from collector_devices where id=${upload.device_id}`;
  if (device?.status === "test") return;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${upload.tenant_id}:${upload.partner_id}:${upload.period_id}`},0))`;
  const parts =
    await tx`select sessions from collector_upload_parts where upload_id=${uploadId} order by part_index`;
  for (const raw of parts.flatMap((part: any) => part.sessions)) {
    const session = collectorSessionSchema.parse(raw);
    // Retained only: a session last modified before the period has no in-period messages to analyse.
    if (Date.parse(session.modifiedAt) < new Date(upload.period_starts_at).getTime())
      continue;
    const sessionKey = stableJsonHash([
      upload.period_id,
      collectorSessionKey(session),
    ]);
    const contentHash = stableJsonHash({
      title: session.title,
      turns: session.turns,
      modifiedAt: session.modifiedAt,
    });
    const key = `collector-extract:${upload.partner_id}:${upload.period_id}:${sessionKey}:${contentHash}`;
    const input = {
      uploadId,
      sessionId: session.id,
      scopeKey: session.scopeKey,
      sessionKey,
      contentHash,
      sourceAt: new Date(upload.ends_at).toISOString(),
      period: { id: upload.period_id, key: upload.period_key },
    };
    await tx`insert into agent_jobs (id,tenant_id,team_id,partner_id,plugin_instance_id,type,idempotency_key,input_payload)
      values (${randomUUID()},${upload.tenant_id},${upload.team_id},${upload.partner_id},${upload.scope_instance_id},
        'EXTRACT_COLLECTOR_SESSION',${key},${JSON.stringify(input)}::jsonb)
      on conflict (tenant_id,idempotency_key) do nothing`;
    const [job] =
      await tx`select id,status from agent_jobs where tenant_id=${upload.tenant_id} and idempotency_key=${key}`;
    const [record] =
      await tx`select source_hash from session_records where tenant_id=${upload.tenant_id}
      and partner_id=${upload.partner_id} and session_id=${sessionKey}`;
    if (
      job.status === "COMPLETED" &&
      record &&
      record.source_hash !== contentHash
    )
      await tx`update agent_jobs set status='PENDING',input_payload=${JSON.stringify(input)}::jsonb,
        max_attempts=greatest(max_attempts,attempt_count+3),completed_at=null,updated_at=now() where id=${job.id}`;
    await tx`update agent_jobs set status='CANCELLED',error_code='COLLECTOR_SOURCE_SUPERSEDED',next_retry_at=null,updated_at=now()
      where tenant_id=${upload.tenant_id} and partner_id=${upload.partner_id} and type='EXTRACT_COLLECTOR_SESSION'
        and input_payload->>'sessionKey'=${sessionKey} and id<>${job.id}
        and status in ('PENDING','RETRY_WAIT','FAILED') and input_payload->>'sourceAt' <= ${input.sourceAt}`;
    await tx`insert into collector_upload_jobs (upload_id,job_id) values (${uploadId},${job.id}) on conflict do nothing`;
  }
  await tx`update collector_uploads set analysis_enqueued_at=now() where id=${uploadId}`;
}

export async function loadCollectorPipeline(
  database: any,
  identity: { tenantId: string; teamId: string; partnerId?: string },
) {
  return database`select u.id,u.device_id,u.period_key,u.session_count,u.status,u.created_at,u.completed_at,
      u.analysis_enqueued_at,p.display_name as partner_name,d.device_name,d.status as device_status,
      coalesce(j.total,0)::int as analysis_total,coalesce(j.completed,0)::int as analysis_completed,
      coalesce(j.ignored,0)::int as analysis_ignored,coalesce(j.failed,0)::int as analysis_failed,
      coalesce(j.superseded,0)::int as analysis_superseded,
      coalesce(j.running,0)::int as analysis_running,coalesce(j.retrying,0)::int as analysis_retrying,
      j.error_code,coalesce(j.next_retry_at,card_job.next_retry_at,report_job.next_retry_at) as next_retry_at,
      r.id as review_id,r.state as review_state,
      coalesce(r.pending_count,0)::int as pending_cards,coalesce(r.approved_count,0)::int as approved_cards,
      card_job.id as card_job_id,card_job.status as card_job_status,card_job.error_code as card_error_code,
      report_job.status as report_job_status,report_job.error_code as report_error_code,
      tr.id as report_id,tr.status as report_status,rp.id as period_id,rp.cutoff_at,rp.status as period_status
    from collector_uploads u join collector_devices d on d.id=u.device_id
    join partners p on p.id=d.partner_id
    left join report_periods rp on rp.tenant_id=d.tenant_id and rp.team_id=d.team_id and rp.period_key=u.period_key
    left join reviews r on r.tenant_id=d.tenant_id and r.partner_id=d.partner_id and r.period_id=rp.id
    left join team_reports tr on tr.tenant_id=d.tenant_id and tr.team_id=d.team_id and tr.period_id=rp.id
    left join lateral (select count(*) as total,
        count(*) filter(where a.status='COMPLETED') as completed,
        count(*) filter(where a.status='COMPLETED' and a.output_payload->>'decision'='ignore') as ignored,
        count(*) filter(where a.status='FAILED') as failed,count(*) filter(where a.status='LEASED') as running,
        count(*) filter(where a.status='CANCELLED' and a.error_code='COLLECTOR_SOURCE_SUPERSEDED') as superseded,
        count(*) filter(where a.status='RETRY_WAIT') as retrying,
        max(a.error_code) filter(where a.status in ('FAILED','RETRY_WAIT')) as error_code,
        min(a.next_retry_at) filter(where a.status='RETRY_WAIT') as next_retry_at
      from collector_upload_jobs l join agent_jobs a on a.id=l.job_id where l.upload_id=u.id) j on true
    left join lateral (select a.id,a.status,
        case when a.status in ('FAILED','RETRY_WAIT') then a.error_code end as error_code,
        case when a.status='RETRY_WAIT' then a.next_retry_at end as next_retry_at
      from agent_jobs a where a.tenant_id=d.tenant_id
        and a.partner_id=d.partner_id and a.type='AGGREGATE_WORK_ITEMS' and a.input_payload->'period'->>'id'=rp.id::text
      order by a.created_at desc limit 1) card_job on true
    left join lateral (select a.status,
        case when a.status in ('FAILED','RETRY_WAIT') then a.error_code end as error_code,
        case when a.status='RETRY_WAIT' then a.next_retry_at end as next_retry_at
      from agent_jobs a where a.tenant_id=d.tenant_id
        and a.team_id=d.team_id and a.type in ('GENERATE_TEAM_REPORT','REGENERATE_TEAM_REPORT')
        and a.input_payload->>'reportId'=tr.id::text order by a.created_at desc limit 1) report_job on true
    where d.tenant_id=${identity.tenantId} and d.team_id=${identity.teamId}
      and (${identity.partnerId ?? null}::uuid is null or d.partner_id=${identity.partnerId ?? null})
    order by u.created_at desc,u.id limit 100`;
}
