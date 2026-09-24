import { randomUUID } from "node:crypto";
import {
  defaultProjectStatus,
  readProjectStatus,
} from "@partner-report/contracts/project-status";
import { stableJsonHash } from "@partner-report/contracts/hash";
import { sqlClient as sql } from "@partner-report/db";

export const REVIEW_AUTO_APPROVAL_DELAY_MS = 3 * 24 * 60 * 60 * 1_000;

type ExpiredReview = {
  id: string;
  tenant_id: string;
  team_id: string;
  partner_id: string;
  period_id: string;
  first_sent_at: Date | string;
};

export type AutoApprovalResult = {
  approvedReviews: number;
  approvedItems: number;
  skippedReviews: number;
};

export function isReviewAutoApprovalDue(
  firstSentAt: Date | string | null | undefined,
  now = new Date(),
) {
  if (!firstSentAt) return false;
  const timestamp =
    firstSentAt instanceof Date
      ? firstSentAt.getTime()
      : Date.parse(firstSentAt);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now.getTime() - REVIEW_AUTO_APPROVAL_DELAY_MS
  );
}

function autoApprovedPayload(
  payload: Record<string, unknown>,
  workStatus: string,
  confirmedAt: string,
) {
  return {
    ...payload,
    projectStatus:
      readProjectStatus(payload) ?? defaultProjectStatus(workStatus),
    projectStatusConfirmedAt: confirmedAt,
  };
}

/** Approve unanswered work cards after three days and enqueue the normal completion flow. */
export async function autoApproveExpiredReviews(
  now = new Date(),
): Promise<AutoApprovalResult> {
  const deadline = new Date(now.getTime() - REVIEW_AUTO_APPROVAL_DELAY_MS);
  const candidates = await sql<ExpiredReview[]>`
    select r.id, r.tenant_id, r.team_id, r.partner_id, r.period_id,
      first_delivery.first_sent_at
    from reviews r
    join lateral (
      select min(d.sent_at) as first_sent_at
      from feishu_deliveries d
      where d.tenant_id = r.tenant_id and d.team_id = r.team_id
        and d.partner_id = r.partner_id and d.kind = 'review'
        and d.aggregate_type = 'review' and d.aggregate_id = r.id::text
        and d.sent_at is not null
    ) first_delivery on true
    where r.state = 'IN_PROGRESS' and r.pending_count > 0
      and first_delivery.first_sent_at <= ${deadline.toISOString()}
    order by first_delivery.first_sent_at, r.id
  `;

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
      if (!review || review.pending_count < 1) return null;

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
          null, 'system', 'review-timeout-3d', now()
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
            source: "review-timeout-3d",
          })}::jsonb
        )
      `;
      await tx`
        insert into audit_events (
          id, tenant_id, team_id, actor_type, actor_id, action,
          target_type, target_id, request_id, metadata
        ) values (
          ${randomUUID()}, ${candidate.tenant_id}, ${candidate.team_id},
          'system', 'review-timeout-3d', 'review.auto_approved_after_timeout',
          'review', ${candidate.id}, ${randomUUID()},
          ${JSON.stringify({
            firstSentAt: candidate.first_sent_at,
            delayHours: 72,
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
