import { randomUUID } from "node:crypto";
import { stableJsonHash } from "@partner-report/contracts/hash";
import {
  enqueueCollectorUpload,
  sqlClient as sql,
  loadMemberProjectRedirects,
} from "@partner-report/db";
import { buildProjectBuckets } from "./weekly.js";

export async function backfillCollectorUploads(onlyTenantId?: string) {
  const uploads =
    await sql`select u.id from collector_uploads u join collector_devices d on d.id=u.device_id
    where u.status='completed' and u.analysis_enqueued_at is null and d.status<>'test'
      and (${onlyTenantId ?? null}::uuid is null or d.tenant_id=${onlyTenantId ?? null})
    order by u.created_at limit 20`;
  for (const upload of uploads)
    await sql.begin((tx) => enqueueCollectorUpload(tx, upload.id));
  return uploads.length;
}

export async function scheduleCollectorCards(onlyTenantId?: string) {
  const members =
    await sql`select distinct d.tenant_id,d.team_id,d.partner_id,rp.id as period_id
    from collector_uploads u join collector_devices d on d.id=u.device_id
    join report_periods rp on rp.tenant_id=d.tenant_id and rp.team_id=d.team_id and rp.period_key=u.period_key
    where u.status='completed' and d.status<>'test' and rp.status in ('open','closing')
      and (${onlyTenantId ?? null}::uuid is null or d.tenant_id=${onlyTenantId ?? null})`;
  let queued = 0;
  for (const member of members)
    queued += await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${member.tenant_id}:${member.partner_id}:${member.period_id}`},0))`;
      const pending =
        await tx`select 1 from agent_jobs where tenant_id=${member.tenant_id} and partner_id=${member.partner_id}
      and input_payload->'period'->>'id'=${member.period_id}
      and type in ('EXTRACT_COLLECTOR_SESSION','AGGREGATE_WORK_ITEMS')
      and status in ('PENDING','LEASED','RETRY_WAIT','FAILED') limit 1`;
      if (pending.length) return 0;
      const [period] =
        await tx`select * from report_periods where id=${member.period_id}`;
      if (!period) return 0;
      const projects = await tx<
        { id: string; name: string }[]
      >`select * from projects where tenant_id=${member.tenant_id} and team_id=${member.team_id} and status='active' order by name`;
      const facts: any[] =
        await tx`select id,payload,source_occurred_at from session_facts where tenant_id=${member.tenant_id}
      and partner_id=${member.partner_id} and period_id=${member.period_id} and current=true and excluded=false
      order by source_occurred_at,id`;
      const redirects = await loadMemberProjectRedirects(tx, {
        tenantId: member.tenant_id,
        teamId: member.team_id,
        partnerId: member.partner_id,
      });
      const buckets = buildProjectBuckets(facts, projects, redirects).map(
        (bucket) => ({
          ...bucket,
          sourceChecksum: stableJsonHash(bucket.facts),
        }),
      );
      const [review] =
        await tx`insert into reviews (id,tenant_id,team_id,partner_id,period_id)
      values (${randomUUID()},${member.tenant_id},${member.team_id},${member.partner_id},${member.period_id})
      on conflict (tenant_id,partner_id,period_id) do update set updated_at=reviews.updated_at returning *`;
      if (!review) throw new Error("COLLECTOR_REVIEW_NOT_CREATED");
      const [sessionCounts] =
        await tx`select count(*)::int as total,count(*) filter(where status='extracted')::int as included,
      count(*) filter(where status='ignored')::int as ignored from session_records
      where tenant_id=${member.tenant_id} and partner_id=${member.partner_id} and period_id=${member.period_id}`;
      const coverage = {
        source: "native_collector",
        periodKey: period.period_key,
        discovered: sessionCounts!.total,
        eligible: sessionCounts!.total,
        readable: sessionCounts!.total,
        extracted: sessionCounts!.included,
        skipped: sessionCounts!.ignored,
        deferred: 0,
        notProcessed: 0,
        failedRead: 0,
        failedExtract: 0,
        excluded: 0,
        pendingSync: 0,
        activeAtCutoff: 0,
        hookMissed: 0,
        warnings: [
          "此快照覆盖系统已完整接收的会话；本机未上传或未授权的会话不在统计内。",
        ],
        factCount: facts.length,
        projectCount: buckets.length,
      };
      const [latestCoverage] = await tx`select payload from coverage_snapshots
      where tenant_id=${member.tenant_id} and partner_id=${member.partner_id} and period_id=${member.period_id}
      order by created_at desc limit 1`;
      if (
        stableJsonHash(latestCoverage?.payload ?? {}) !==
        stableJsonHash(coverage)
      )
        await tx`insert into coverage_snapshots (id,tenant_id,team_id,partner_id,period_id,payload)
        values (${randomUUID()},${member.tenant_id},${member.team_id},${member.partner_id},${member.period_id},${JSON.stringify(coverage)}::jsonb)`;
      const cards =
        await tx`select * from work_items where tenant_id=${member.tenant_id} and review_id=${review.id}`;
      // An amended source can remove the last contribution for a project. Require a new decision on that card.
      const obsolete = cards.filter(
        (card: any) =>
          card.payload.collectorSourceChecksum &&
          !card.payload.collectorSourceRemoved &&
          !buckets.some(
            (bucket) => bucket.projectKey === card.payload.projectKey,
          ),
      );
      if (obsolete.length) {
        for (const card of obsolete) {
          await tx`update work_items set review_status='pending',status='awaiting_validation',fact_ids='[]'::jsonb,
          payload=${JSON.stringify({
            ...card.payload,
            collectorSourceRemoved: true,
            overview:
              "最新会话分析中已无此项目的有效贡献，请核实后排除或补充事实。",
            dailyProgress: [],
            outcomeDraftId: null,
          })}::jsonb,
          updated_at=now() where id=${card.id}`;
          await tx`delete from work_item_facts where work_item_id=${card.id}`;
        }
        const [counts] =
          await tx`select count(*) filter(where review_status='pending')::int as pending,
        count(*) filter(where review_status='approved')::int as approved,count(*) filter(where review_status='excluded')::int as excluded
        from work_items where review_id=${review.id}`;
        await tx`update reviews set state='IN_PROGRESS',version=version+1,pending_count=${counts!.pending},
        approved_count=${counts!.approved},excluded_count=${counts!.excluded},updated_at=now() where id=${review.id}`;
        review.version++;
      }
      const changed = buckets.filter(
        (bucket) =>
          !cards.some(
            (card: any) =>
              card.payload.projectKey === bucket.projectKey &&
              card.payload.collectorSourceChecksum === bucket.sourceChecksum,
          ),
      );
      if (!changed.length) return 0;
      const [locked] =
        await tx`select id from team_reports where tenant_id=${member.tenant_id} and period_id=${member.period_id} and status='LOCKED'`;
      if (locked) return 0;
      const currentCards = Object.fromEntries(
        cards.map((card: any) => [
          card.payload.projectKey,
          {
            ...card.payload,
            title: card.title,
            status: card.status,
          },
        ]),
      );
      const sourceChecksum = stableJsonHash(
        changed.map((bucket) => [bucket.projectKey, bucket.sourceChecksum]),
      );
      const [job] =
        await tx`insert into agent_jobs (id,tenant_id,team_id,partner_id,type,idempotency_key,input_payload)
      values (${randomUUID()},${member.tenant_id},${member.team_id},${member.partner_id},'AGGREGATE_WORK_ITEMS',
        ${`collector-cards:${member.partner_id}:${member.period_id}:${sourceChecksum}:${review.version}`},
        ${JSON.stringify({
          schemaVersion: "1.0",
          aggregationMode: "collector",
          reviewId: review.id,
          baseReviewVersion: review.version,
          sourceChecksum,
          currentCards,
          period: {
            id: period.id,
            key: period.period_key,
            startsAt: period.starts_at,
            endsAt: period.ends_at,
            cutoffAt: period.cutoff_at,
          },
          projectBuckets: changed,
        })}::jsonb)
      on conflict (tenant_id,idempotency_key) do nothing returning id`;
      return job ? 1 : 0;
    });
  return queued;
}

export async function applyCollectorCards(
  job: any,
  result: any,
  payloadFor: (group: any, bucket: any) => any,
) {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${job.tenant_id}:${job.partner_id}:${job.input_payload.period.id}`},0))`;
    const [review] =
      await tx`select * from reviews where id=${job.input_payload.reviewId} and tenant_id=${job.tenant_id} for update`;
    if (!review) throw new Error("REVIEW_NOT_FOUND");
    if (review.version !== job.input_payload.baseReviewVersion)
      return { ...result, superseded: true };
    const [locked] =
      await tx`select id from team_reports where tenant_id=${job.tenant_id}
      and period_id=${job.input_payload.period.id} and status='LOCKED'`;
    if (locked) return { ...result, superseded: true };
    const [pendingSource] =
      await tx`select 1 from agent_jobs where tenant_id=${job.tenant_id} and partner_id=${job.partner_id}
      and type='EXTRACT_COLLECTOR_SESSION' and input_payload->'period'->>'id'=${job.input_payload.period.id}
      and status in ('PENDING','LEASED','RETRY_WAIT','FAILED') limit 1`;
    if (pendingSource) return { ...result, superseded: true };
    const facts = await tx<
      any[]
    >`select id,payload,source_occurred_at from session_facts where tenant_id=${job.tenant_id}
      and partner_id=${job.partner_id} and period_id=${job.input_payload.period.id} and current=true and excluded=false
      order by source_occurred_at,id`;
    const projects = await tx<
      { id: string; name: string }[]
    >`select id,name from projects where tenant_id=${job.tenant_id} and team_id=${job.team_id}`;
    const redirects = await loadMemberProjectRedirects(tx, {
      tenantId: job.tenant_id,
      teamId: job.team_id,
      partnerId: job.partner_id,
    });
    const currentBuckets = buildProjectBuckets(facts, projects, redirects);
    if (
      job.input_payload.projectBuckets.some(
        (bucket: any) =>
          stableJsonHash(
            currentBuckets.find(
              (current) => current.projectKey === bucket.projectKey,
            )?.facts ?? [],
          ) !== bucket.sourceChecksum,
      )
    )
      return { ...result, superseded: true };
    for (const group of result.groups) {
      const bucket = job.input_payload.projectBuckets.find(
        (b: any) => b.projectKey === group.projectKey,
      );
      const [old] =
        await tx`select * from work_items where tenant_id=${job.tenant_id} and review_id=${review.id}
        and payload->>'projectKey'=${bucket.projectKey} for update`;
      const id = old?.id ?? randomUUID();
      const payload = {
        ...old?.payload,
        ...payloadFor(group, bucket),
        collectorSourceChecksum: bucket.sourceChecksum,
        collectorSourceRemoved: false,
      };
      if (old) {
        await tx`update work_items set title=${bucket.projectName},status=${group.status},review_status='pending',
          fact_ids=${JSON.stringify(bucket.factIds)}::jsonb,payload=${JSON.stringify(payload)}::jsonb,updated_at=now() where id=${id}`;
        await tx`delete from work_item_facts where work_item_id=${id}`;
      } else {
        await tx`insert into work_items (id,tenant_id,team_id,partner_id,period_id,review_id,project_id,title,status,fact_ids,payload)
          values (${id},${job.tenant_id},${job.team_id},${job.partner_id},${job.input_payload.period.id},${review.id},${bucket.projectId},
            ${bucket.projectName},${group.status},${JSON.stringify(bucket.factIds)}::jsonb,${JSON.stringify(payload)}::jsonb)`;
      }
      const [latest] =
        await tx`select coalesce(max(version),0)::int as version from work_item_versions where work_item_id=${id}`;
      await tx`insert into work_item_versions (id,tenant_id,team_id,partner_id,period_id,review_id,work_item_id,version,title,status,payload,source)
        values (${randomUUID()},${job.tenant_id},${job.team_id},${job.partner_id},${job.input_payload.period.id},${review.id},${id},
          ${latest!.version + 1},${bucket.projectName},${group.status},${JSON.stringify(payload)}::jsonb,'collector_generated')`;
      for (const factId of bucket.factIds)
        await tx`insert into work_item_facts (work_item_id,fact_id) values (${id},${factId}) on conflict do nothing`;
    }
    const [counts] =
      await tx`select count(*) filter(where review_status='pending')::int as pending,
      count(*) filter(where review_status='approved')::int as approved,count(*) filter(where review_status='excluded')::int as excluded
      from work_items where review_id=${review.id}`;
    await tx`update reviews set state='IN_PROGRESS',version=version+1,pending_count=${counts!.pending},
      approved_count=${counts!.approved},excluded_count=${counts!.excluded},updated_at=now() where id=${review.id}`;
    await tx`insert into outbox_events (id,tenant_id,event_type,aggregate_type,aggregate_id,payload)
      values (${randomUUID()},${job.tenant_id},'work_items.draft.created','review',${review.id},
        ${JSON.stringify({ count: result.groups.length, freshMessage: true, collector: true })}::jsonb)`;
    return result;
  });
}
