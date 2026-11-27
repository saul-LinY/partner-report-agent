import type { Activity, ProjectProfileItem } from "./member-overview.js";
import type { ProjectProgressResponse } from "./project-progress.js";

/** The weekly schedule of one review's period; every instant is an ISO timestamp. */
export type ReviewPeriod = {
  periodKey: string;
  startsAt: string;
  cutoffAt: string;
  /** Monday 12:00 after the cutoff: pending cards are approved automatically. */
  autoApproveAt: string;
  /** Monday 13:00 after the cutoff: the leadership panel updates. */
  publishAt: string;
  timezone: string;
};

/** Where the weekly leadership panel is in its cycle; every instant is an ISO timestamp. */
export type LeadershipSchedule = {
  timezone: string;
  /** The published snapshot the panel shows; null before the first publication. */
  current: null | {
    periodKey: string;
    startsAt: string;
    cutoffAt: string;
    publishedAt: string;
  };
  /** The upcoming update: collect until cutoff, review until autoApproveAt, then publish at publishAt. */
  next: {
    periodKey: string;
    startsAt: string;
    cutoffAt: string;
    autoApproveAt: string;
    publishAt: string;
    step: "collecting" | "reviewing" | "publishing";
  };
};

/** One member's review of the period behind the snapshot. */
export type LeadershipReview = {
  partnerId: string;
  approvedBy: "member" | "auto" | "none";
  approvedAt: string | null;
};

/** The weekly leadership panel's data; leadership pages read nothing else. */
export type LeadershipSnapshot = {
  schedule: LeadershipSchedule;
  /** Computed with today = the cutoff's local date. */
  progress: ProjectProgressResponse | null;
  /** The 90 days ending at the cutoff's local date. */
  activity: Activity | null;
  profiles: ProjectProfileItem[];
  reviews: LeadershipReview[];
};

/** What a published snapshot row stores; the schedule is derived on read. */
export type LeadershipSnapshotPayload = Omit<LeadershipSnapshot, "schedule">;
