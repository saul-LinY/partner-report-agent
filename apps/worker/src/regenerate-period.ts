/**
 * Re-runs weekly card generation for selected members of a closed period, for
 * when collection was broken and the cutoff froze an incomplete week.
 *
 *   dry run: node --import tsx src/regenerate-period.ts --period 2026-W40 --team <id> --partner <name> ...
 *   apply:   add --apply
 *
 * Facts that happened inside the period but were uploaded after its cutoff are
 * moved back into it first (--reclaim). Each member's existing cards for the
 * period are replaced by a normal weekly_report job, which the worker generates
 * and then announces to Feishu through work_items.draft.created as usual.
 */
import { randomUUID } from "node:crypto";
import { stableJsonHash } from "@partner-report/contracts/hash";
import {
  closeDatabase,
  loadMemberProjectRedirects,
  sqlClient as sql,
} from "@partner-report/db";
import { buildProjectBuckets } from "./weekly.js";

const args = process.argv.slice(2);
const values = (name: string) =>
  args.flatMap((arg, at) => (args[at - 1] === name ? [arg] : []));
const periodKey = values("--period")[0];
const teamId = values("--team")[0];
const partnerNames = values("--partner");
const reclaimNames = values("--reclaim");
const apply = args.includes("--apply");
class DryRun extends Error {}
if (!periodKey || !teamId || partnerNames.length === 0)
  throw new Error("--period, --team and at least one --partner are required");

try {
  const [period] = await sql<any[]>`
    select * from report_periods where team_id = ${teamId} and period_key = ${periodKey}
  `;
  if (!period) throw new Error(`PERIOD_NOT_FOUND:${periodKey}`);
  if (period.status === "open") throw new Error("PERIOD_STILL_OPEN");
  const partners = await sql<Array<{ id: string; display_name: string }>>`
    select id, display_name from partners
    where team_id = ${teamId} and status = 'active'
      and display_name in ${sql([...partnerNames, ...reclaimNames])}
  `;
  const byName = new Map(partners.map((p) => [p.display_name, p]));
  for (const name of [...partnerNames, ...reclaimNames])
    if (!byName.has(name)) throw new Error(`PARTNER_NOT_FOUND:${name}`);

  await sql.begin(async (tx) => {
    for (const name of reclaimNames) {
      const partner = byName.get(name)!;
      const moved = await tx<Array<{ session_id: string; title: string }>>`
        update session_facts sf set period_id = ${period.id}, updated_at = now()
        from report_periods later
        where later.id = sf.period_id and later.team_id = ${teamId}
          and later.starts_at >= ${period.ends_at}
          and sf.partner_id = ${partner.id}
          and sf.source_occurred_at >= ${period.starts_at}
          and sf.source_occurred_at < ${period.ends_at}
        returning sf.session_id, sf.payload->>'title' as title
      `;
      if (moved.length)
        await tx`
          update session_records set period_id = ${period.id}, updated_at = now()
          where partner_id = ${partner.id}
            and session_id in ${tx(moved.map((fact) => fact.session_id))}
        `;
      // Completing a review needs coverage for its period; reclaimed work was
      // collected in a later period, so carry that collection's coverage back.
      if (moved.length)
        await tx`
          insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload, immutable)
          select ${randomUUID()}, c.tenant_id, c.team_id, c.partner_id, ${period.id}, c.payload, true
          from coverage_snapshots c
          join report_periods later on later.id = c.period_id
          where c.partner_id = ${partner.id} and later.team_id = ${teamId}
            and later.starts_at >= ${period.ends_at}
            and not exists (
              select 1 from coverage_snapshots existing
              where existing.partner_id = ${partner.id} and existing.period_id = ${period.id}
            )
          order by c.created_at desc limit 1
        `;
      console.log(
        `${name}: reclaimed ${moved.length} fact(s) into ${periodKey}`,
      );
      for (const fact of moved) console.log(`  - ${fact.title}`);
    }

    for (const name of partnerNames) {
      const partner = byName.get(name)!;
      const [review] = await tx<any[]>`
        select * from reviews where partner_id = ${partner.id} and period_id = ${period.id}
        for update
      `;
      if (!review) throw new Error(`REVIEW_NOT_FOUND:${name}`);
      const facts = await tx<any[]>`
        select id, payload, source_occurred_at from session_facts
        where partner_id = ${partner.id} and period_id = ${period.id}
          and current = true and excluded = false
        order by source_occurred_at nulls last, created_at, id
      `;
      if (facts.length === 0) {
        console.log(`${name}: no facts in ${periodKey}; left unchanged`);
        continue;
      }
      const projects = await tx<any[]>`
        select p.*,
          candidate.id as description_candidate_id,
          candidate.description as description_candidate,
          candidate.source_fingerprint as description_candidate_source_fingerprint
        from projects p
        left join lateral (
          select id, description, source_fingerprint
          from project_description_candidates
          where tenant_id = ${period.tenant_id} and partner_id = ${partner.id}
            and project_id = p.id and status = 'pending'
          order by created_at desc limit 1
        ) candidate on true
        where p.tenant_id = ${period.tenant_id} and p.team_id = ${teamId}
          and p.status = 'active'
        order by p.name
      `;
      const redirects = await loadMemberProjectRedirects(tx, {
        tenantId: period.tenant_id,
        teamId,
        partnerId: partner.id,
      });
      const projectBuckets = buildProjectBuckets(facts, projects, redirects);
      const factIds = facts.map((fact) => fact.id);
      const [snapshot] = await tx<{ id: string }[]>`
        insert into fact_snapshots (
          id, tenant_id, team_id, partner_id, period_id, fact_ids, checksum, coverage
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${teamId}, ${partner.id}, ${period.id},
          ${JSON.stringify(factIds)}::jsonb, ${stableJsonHash(factIds)}, '{}'::jsonb
        ) on conflict (tenant_id, partner_id, period_id) do update set
          fact_ids = excluded.fact_ids, checksum = excluded.checksum, frozen_at = now()
        returning id
      `;
      // Old cards are replaced; their versions stay in work_item_versions until
      // the delete cascades, so the backup dump is the record of what was there.
      await tx`
        delete from work_item_facts where work_item_id in (
          select id from work_items where review_id = ${review.id}
        )
      `;
      await tx`delete from work_items where review_id = ${review.id}`;
      await tx`
        update reviews set state = 'IN_PROGRESS', version = version + 1,
          approved_count = 0, excluded_count = 0, pending_count = 0,
          updated_at = now()
        where id = ${review.id}
      `;
      await tx`
        insert into agent_jobs (
          id, tenant_id, team_id, partner_id, plugin_instance_id,
          type, idempotency_key, input_payload
        ) values (
          ${randomUUID()}, ${period.tenant_id}, ${teamId}, ${partner.id}, null,
          'AGGREGATE_WORK_ITEMS',
          ${`weekly-aggregate:${partner.id}:${period.id}:rerun:${Date.now()}`},
          ${JSON.stringify({
            schemaVersion: "1.0",
            aggregationMode: "weekly_report",
            factSnapshotId: snapshot!.id,
            period: {
              id: period.id,
              key: period.period_key,
              startsAt: period.starts_at,
              endsAt: period.ends_at,
              cutoffAt: period.cutoff_at,
            },
            reviewId: review.id,
            projectBuckets,
          })}::jsonb
        )
      `;
      console.log(
        `${name}: ${facts.length} fact(s), ${projectBuckets.length} project(s) -> queued generation`,
      );
      for (const bucket of projectBuckets)
        console.log(`  - ${bucket.projectName} (${bucket.factIds.length})`);
    }
    if (!apply) {
      console.log("\nDry run: rolled back. Re-run with --apply to commit.");
      throw new DryRun();
    }
  });
  console.log(
    "\nCommitted. The worker will generate cards and send Feishu reviews.",
  );
} catch (error) {
  if (!(error instanceof DryRun)) throw error;
} finally {
  await closeDatabase();
}
