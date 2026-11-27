import { randomUUID } from "node:crypto";
import {
  defaultProjectStatus,
  readProjectStatus,
} from "@partner-report/contracts/project-status";
import { stableJsonHash } from "@partner-report/contracts/hash";
import {
  REVIEW_DEADLINE_ACTOR,
  sqlClient as sql,
  weeklyReviewSchedule,
} from "@partner-report/db";

type ExpiredReview = {
  id: string;
  tenant_id: string;
  team_id: string;
  partner_id: string;
  period_id: string;
  version: number;
  /** The shared client returns timestamps as strings (drizzle replaces the driver's date parsers). */
  cutoff_at: string;
  timezone: string;
};

export type AutoApprovalResult = {
  approvedReviews: number;
  approvedItems: number;
  skippedReviews: number;
};

/** The instant unanswered cards of a period are approved: Monday 12:00 (team time) after its cutoff. */
export function reviewAutoApprovalAt(cutoffAt: Date, timezone: string) {
  return weeklyReviewSchedule(cutoffAt, timezone).autoApproveAt;
}

export function isReviewAutoApprovalDue(
  cutoffAt: Date,
  timezone: string,
  now = new Date(),
) {
  return reviewAutoApprovalAt(cutoffAt, timezone).getTime() <= now.getTime();
}

function autoApprovedPayload(
  payload: Record<string, unknown>,
  workStatus: string,
  confirmedAt: string,
) {
  return {
    ...payload,
    autoApproved: true,
    projectStatus:
      readProjectStatus(payload) ?? defaultProjectStatus(workStatus),
    projectStatusConfirmedAt: confirmedAt,
  };
}

/** Approve still-pending work cards once the period's Monday 12:00 deadline has passed. */
export async function autoApproveExpiredReviews(
  now = new Date(),
): Promise<AutoApprovalResult> {
  // The deadline always falls after the cutoff, so a future cutoff can never be due.
  const open = await sql<ExpiredReview[]>`
    select r.id, r.tenant_id, r.team_id, r.partner_id, r.period_id, r.version,
      rp.cutoff_at, rp.timezone
    from reviews r
    join report_periods rp on rp.id = r.period_id and rp.tenant_id = r.tenant_id
    where r.state = 'IN_PROGRESS' and r.pending_count > 0
      and rp.cutoff_at <= ${now.toISOString()}
      -- A card being regenerated is not final; wait for the new content.
      and not exists (
        select 1 from agent_jobs j
        where j.tenant_id = r.tenant_id and j.type = 'AGGREGATE_WORK_ITEMS'
          and j.status in ('PENDING', 'LEASED', 'RETRY_WAIT')
          and j.input_payload->>'reviewId' = r.id::text
      )
    order by rp.cutoff_at, r.id
  `;
  const candidates = open.filter((review) =>
    isReviewAutoApprovalDue(new Date(review.cutoff_at), review.timezone, now),
  );

  let approvedReviews = 0;
  let approvedItems = 0;
  let skippedReviews = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      const reviews = await tx<any[]>`
        select * from reviews
        where id = ${candidate.id} and tenant_id = ${candidate.tenant_id}
          and team_id = ${candidate.team_id} and state = 'IN_PROGRESS'
        for update
      `;
      const review = reviews[0];
      if (
        !review ||
        review.pending_count < 1 ||
        review.version !== candidate.version
      )
        return null;

      const items = await tx<any[]>`
        select * from work_items
        where review_id = ${candidate.id} and tenant_id = ${candidate.tenant_id}
          and team_id = ${candidate.team_id} and partner_id = ${candidate.partner_id}
        order by created_at, id
        for update
      `;
      const pendingItems = items.filter(
        (item) => item.review_status === "pending",
      );
      if (pendingItems.length === 0) return null;

      const coverageRows = await tx<any[]>`
        select * from coverage_snapshots
        where tenant_id = ${candidate.tenant_id}
          and team_id = ${candidate.team_id}
          and partner_id = ${candidate.partner_id}
          and period_id = ${candidate.period_id}
        order by created_at desc
        limit 1
      `;
      const coverage = coverageRows[0];
      if (!coverage) return { skipped: true };

      const confirmedAt = now.toISOString();
      for (const item of pendingItems) {
        await tx`
          update work_items set
            review_status = 'approved',
            payload = ${JSON.stringify(
              autoApprovedPayload(item.payload ?? {}, item.status, confirmedAt),
            )}::jsonb,
            updated_at = now()
          where id = ${item.id} and review_id = ${candidate.id}
            and tenant_id = ${candidate.tenant_id} and review_status = 'pending'
        `;
      }

      for (const item of pendingItems) {
        const candidateId = item.payload?.projectDescriptionCandidateId;
        const description = item.payload?.projectDescription;
        const sourceFingerprint =
          item.payload?.projectDescriptionSourceFingerprint;
        if (
          !item.project_id ||
          typeof description !== "string" ||
          !description.trim() ||
          typeof sourceFingerprint !== "string"
        )
          continue;
        if (typeof candidateId === "string") {
          const promoted = await tx<{ id: string }[]>`
            update project_description_candidates set
              description = ${description.trim()}, status = 'approved',
              reviewed_at = now(), updated_at = now()
            where id = ${candidateId} and tenant_id = ${candidate.tenant_id}
              and partner_id = ${candidate.partner_id} and project_id = ${item.project_id}
              and status = 'pending'
            returning id
          `;
          if (!promoted[0]) continue;
        }
        await tx`
          update projects set description = ${description.trim()},
            description_source_fingerprint = ${sourceFingerprint},
            description_updated_at = now(), updated_at = now()
          where id = ${item.project_id} and tenant_id = ${candidate.tenant_id}
            and team_id = ${candidate.team_id}
            and (
              description is distinct from ${description.trim()}
              or description_source_fingerprint is distinct from ${sourceFingerprint}
            )
        `;
        await tx`
          update project_description_candidates set status = 'superseded',
            reviewed_at = now(), updated_at = now()
          where tenant_id = ${candidate.tenant_id} and project_id = ${item.project_id}
            and (${typeof candidateId === "string" ? candidateId : null}::uuid is null
              or id <> ${typeof candidateId === "string" ? candidateId : null})
            and status = 'pending'
        `;
      }

      const approvedItems = items.map((item) =>
        pendingItems.some((pending) => pending.id === item.id)
          ? {
              ...item,
              review_status: "approved",
              payload: autoApprovedPayload(
                item.payload ?? {},
                item.status,
                confirmedAt,
              ),
            }
          : item,
      );
      const excludedWorkItemIds = approvedItems
        .filter((item) => item.review_status === "excluded")
        .map((item) => item.id);
      const nextVersion = review.version + 1;
      const snapshotPayload = {
        reviewId: candidate.id,
        reviewVersion: nextVersion,
        periodId: candidate.period_id,
        workItems: approvedItems.filter(
          (item) => item.review_status === "approved",
        ),
        excludedWorkItemIds,
        coverage: coverage.payload,
        noReportableActivity: false,
      };
      const checksum = stableJsonHash(snapshotPayload);
      const snapshotId = randomUUID();
      await tx`
        update reviews set
          state = 'ITEMS_APPROVED', version = ${nextVersion},
          approved_count = ${approvedItems.filter((item) => item.review_status === "approved").length},
          excluded_count = ${excludedWorkItemIds.length}, pending_count = 0,
          updated_at = now()
        where id = ${candidate.id} and tenant_id = ${candidate.tenant_id}
          and state = 'IN_PROGRESS'
      `;
      await tx`
        update coverage_snapshots set immutable = true
        where id = ${coverage.id} and tenant_id = ${candidate.tenant_id}
      `;
      await tx`
        insert into work_item_snapshots (
          id, tenant_id, team_id, partner_id, period_id, review_id, review_version,
          checksum, payload, approved_by, approved_by_actor_type,
          approved_by_actor_id, approved_at
        ) values (
          ${snapshotId}, ${candidate.tenant_id}, ${candidate.team_id},
          ${candidate.partner_id}, ${candidate.period_id}, ${candidate.id},
          ${nextVersion}, ${checksum}, ${JSON.stringify(snapshotPayload)}::jsonb,
          null, 'system', ${REVIEW_DEADLINE_ACTOR}, now()
        )
      `;
      await tx`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${randomUUID()}, ${candidate.tenant_id}, 'work_items.snapshot.approved',
          'work_item_snapshot', ${snapshotId},
          ${JSON.stringify({
            reviewId: candidate.id,
            snapshotId,
            checksum,
            excludedWorkItemIds,
            source: REVIEW_DEADLINE_ACTOR,
          })}::jsonb
        )
      `;
      await tx`
        insert into audit_events (
          id, tenant_id, team_id, actor_type, actor_id, action,
          target_type, target_id, request_id, metadata
        ) values (
          ${randomUUID()}, ${candidate.tenant_id}, ${candidate.team_id},
          'system', ${REVIEW_DEADLINE_ACTOR}, 'review.auto_approved_at_deadline',
          'review', ${candidate.id}, ${randomUUID()},
          ${JSON.stringify({
            autoApproveAt: reviewAutoApprovalAt(
              new Date(candidate.cutoff_at),
              candidate.timezone,
            ).toISOString(),
            approvedItemCount: pendingItems.length,
          })}::jsonb
        )
      `;
      return { approved: pendingItems.length };
    });
    if (!result) continue;
    if ("skipped" in result) {
      skippedReviews += 1;
      continue;
    }
    approvedReviews += 1;
    approvedItems += result.approved;
  }

  return { approvedReviews, approvedItems, skippedReviews };
}
