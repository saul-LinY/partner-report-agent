import type {
  LeadershipReview,
  LeadershipSchedule,
  LeadershipSnapshot,
  LeadershipSnapshotPayload,
  ReviewPeriod,
} from "@partner-report/contracts/leadership";
import { progressToday } from "@partner-report/contracts/project-progress";
import { sqlClient as sql } from "./client.js";
import {
  LeadershipDataError,
  loadAiActivity,
  loadProjectProfiles,
  loadProjectProgress,
  type TeamScope,
} from "./leadership-data.js";
import {
  weeklyPeriodAt,
  weeklyReviewSchedule,
  type WeeklyPeriodRule,
} from "./period.js";

/** Audit/approval actor of cards approved automatically at the Monday deadline. */
export const REVIEW_DEADLINE_ACTOR = "review-deadline-monday";
/** Actor of cards approved by the previous 3-day timeout; still reported as automatic approval. */
const LEGACY_TIMEOUT_ACTOR = "review-timeout-3d";
/** Actor of the empty review closed at the cutoff for a member with nothing to report. */
const NO_ACTIVITY_ACTOR = "weekly-cutoff";

/** The activity chart on the leadership page covers this many days ending at the cutoff day. */
export const LEADERSHIP_ACTIVITY_DAYS = 90;

type PeriodTiming = {
  periodKey: string;
  startsAt: Date;
  cutoffAt: Date;
  timezone: string;
};

export function reviewPeriodSchedule(period: PeriodTiming): ReviewPeriod {
  const { autoApproveAt, publishAt } = weeklyReviewSchedule(
    period.cutoffAt,
    period.timezone,
  );
  return {
    periodKey: period.periodKey,
    startsAt: period.startsAt.toISOString(),
    cutoffAt: period.cutoffAt.toISOString(),
    autoApproveAt: autoApproveAt.toISOString(),
    publishAt: publishAt.toISOString(),
    timezone: period.timezone,
  };
}

/** Where an unpublished period stands: collecting until the cutoff, then reviewing, then waiting to publish. */
export function leadershipStep(
  now: Date,
  period: Pick<ReviewPeriod, "cutoffAt" | "autoApproveAt">,
): LeadershipSchedule["next"]["step"] {
  if (now.getTime() < Date.parse(period.cutoffAt)) return "collecting";
  if (now.getTime() < Date.parse(period.autoApproveAt)) return "reviewing";
  return "publishing";
}

/** Raw query rows: the shared client returns timestamps as strings (drizzle replaces the driver's date parsers). */
type PeriodRow = {
  period_key: string;
  starts_at: string;
  cutoff_at: string;
  timezone: string;
};

const timing = (row: PeriodRow): PeriodTiming => ({
  periodKey: row.period_key,
  startsAt: new Date(row.starts_at),
  cutoffAt: new Date(row.cutoff_at),
  timezone: row.timezone,
});

async function latestPublished(scope: TeamScope) {
  const [row] = await sql<
    {
      period_key: string;
      starts_at: string;
      cutoff_at: string;
      published_at: string;
    }[]
  >`
    select s.period_key, rp.starts_at, s.cutoff_at, s.published_at
    from leadership_snapshots s
    join report_periods rp on rp.id = s.period_id and rp.tenant_id = s.tenant_id
    where s.tenant_id = ${scope.tenantId} and s.team_id = ${scope.teamId}
    order by s.cutoff_at desc limit 1
  `;
  return row;
}

/**
 * The published snapshot and the update that follows it. The next update is the newest closed period
 * that is not yet published (reviewing, then publishing); otherwise the period still collecting.
 */
export async function loadLeadershipSchedule(
  scope: TeamScope,
  now = new Date(),
): Promise<LeadershipSchedule> {
  const [team] = await sql<{ timezone: string; period_rule: WeeklyPeriodRule }[]>`
    select timezone, period_rule from teams
    where id = ${scope.teamId} and tenant_id = ${scope.tenantId}
  `;
  if (!team) throw new LeadershipDataError("TEAM_NOT_FOUND", "团队不存在。");
  const published = await latestPublished(scope);
  const [unpublished] = await sql<PeriodRow[]>`
    select rp.period_key, rp.starts_at, rp.cutoff_at, rp.timezone
    from report_periods rp
    where rp.tenant_id = ${scope.tenantId} and rp.team_id = ${scope.teamId}
      and rp.cutoff_at <= ${now.toISOString()}
      and rp.cutoff_at > ${published ? new Date(published.cutoff_at).toISOString() : new Date(0).toISOString()}
    order by rp.cutoff_at desc limit 1
  `;
  let upcoming = unpublished;
  if (!upcoming) {
    [upcoming] = await sql<PeriodRow[]>`
      select rp.period_key, rp.starts_at, rp.cutoff_at, rp.timezone
      from report_periods rp
      where rp.tenant_id = ${scope.tenantId} and rp.team_id = ${scope.teamId}
        and rp.cutoff_at > ${now.toISOString()}
      order by rp.cutoff_at limit 1
    `;
  }
  const period = upcoming
    ? timing(upcoming)
    : (() => {
        const week = weeklyPeriodAt(now, team.timezone, team.period_rule);
        return {
          periodKey: week.periodKey,
          startsAt: week.startsAt,
          cutoffAt: week.cutoffAt,
          timezone: team.timezone,
        };
      })();
  const next = reviewPeriodSchedule(period);
  return {
    timezone: team.timezone,
    current: published
      ? {
          periodKey: published.period_key,
          startsAt: new Date(published.starts_at).toISOString(),
          cutoffAt: new Date(published.cutoff_at).toISOString(),
          publishedAt: new Date(published.published_at).toISOString(),
        }
      : null,
    next: { ...next, step: leadershipStep(now, next) },
  };
}

/** Who approved each member's cards for the period behind a snapshot. */
async function loadReviews(
  scope: TeamScope,
  periodId: string,
): Promise<LeadershipReview[]> {
  const rows = await sql<
    {
      partner_id: string;
      actor_id: string | null;
      approved_at: string | null;
    }[]
  >`
    select r.partner_id, s.approved_by_actor_id as actor_id, s.approved_at
    from reviews r
    left join lateral (
      select approved_by_actor_id, approved_at from work_item_snapshots w
      where w.review_id = r.id and w.tenant_id = r.tenant_id
      order by w.review_version desc limit 1
    ) s on true
    where r.tenant_id = ${scope.tenantId} and r.team_id = ${scope.teamId}
      and r.period_id = ${periodId}
    order by r.partner_id
  `;
  return rows.map((row) => ({
    partnerId: row.partner_id,
    approvedBy:
      row.approved_at === null || row.actor_id === NO_ACTIVITY_ACTOR
        ? "none"
        : row.actor_id === REVIEW_DEADLINE_ACTOR ||
            row.actor_id === LEGACY_TIMEOUT_ACTOR
          ? "auto"
          : "member",
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
  }));
}

/** Everything the leadership pages show for one period, computed as of its cutoff day. */
export async function computeLeadershipSnapshotPayload(
  scope: TeamScope,
  period: { id: string; cutoffAt: Date; timezone: string },
): Promise<LeadershipSnapshotPayload> {
  const asOf = progressToday(period.timezone, period.cutoffAt);
  const [progress, activity, profiles, reviews] = await Promise.all([
    loadProjectProgress(scope, { asOf }),
    loadAiActivity(scope, LEADERSHIP_ACTIVITY_DAYS, period.cutoffAt),
    loadProjectProfiles(scope),
    loadReviews(scope, period.id),
  ]);
  return { progress, activity, profiles, reviews };
}

/** The latest published snapshot with the live schedule; empty data before the first publication. */
export async function loadLeadershipSnapshot(
  scope: TeamScope,
  now = new Date(),
): Promise<LeadershipSnapshot> {
  const schedule = await loadLeadershipSchedule(scope, now);
  const [row] = await sql<{ payload: LeadershipSnapshotPayload }[]>`
    select payload from leadership_snapshots
    where tenant_id = ${scope.tenantId} and team_id = ${scope.teamId}
    order by cutoff_at desc limit 1
  `;
  return {
    schedule,
    ...(row?.payload ?? {
      progress: null,
      activity: null,
      profiles: [],
      reviews: [],
    }),
  };
}
