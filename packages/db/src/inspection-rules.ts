/**
 * Pure inspection rules. Every function maps plain row objects to finding drafts and never touches the
 * database, the clock or the environment, so each rule is unit tested in isolation.
 *
 * Evidence holds identifiers, fixed codes, counts and timestamps only. Session text, local paths and
 * free-form error strings never enter a draft.
 */

export type InspectionChain = "app" | "system" | "pipeline";
export type InspectionSeverity = "warning" | "critical";

export type InspectionEvidence = {
  eventIds?: string[];
  codes?: string[];
  counts?: Record<string, number>;
  timestamps?: Record<string, string>;
  jobIds?: string[];
  uploadId?: string;
  deviceId?: string;
  executionId?: string;
  partnerId?: string;
};

export type InspectionFindingDraft = {
  fingerprint: string;
  chain: InspectionChain;
  rule: string;
  severity: InspectionSeverity;
  partnerId: string | null;
  subject: string;
  title: string;
  evidence: InspectionEvidence;
};

export type InspectionClientState = {
  startupStage?: string;
  unreadableSessionCount?: number;
  autoUpload?: boolean;
  frequency?: "daily" | "weekly";
  uploadHour?: number;
  uploadMinute?: number;
  uploadWeekday?: number | null;
};

export type InspectionDevice = {
  id: string;
  partnerId: string;
  partnerName: string;
  deviceName: string;
  createdAt: Date;
  lastLogAt: Date | null;
  lastUploadAt: Date | null;
  clientState: InspectionClientState | null;
};

export type InspectionLogEvent = {
  eventId: string;
  deviceId: string;
  occurredAt: Date;
  receivedAt: Date;
  stage: string;
  level: string;
  code: string;
  details: { httpStatus?: number; errorKind?: string } | null;
};

export type InspectionUpload = {
  id: string;
  deviceId: string;
  partnerId: string;
  periodKey: string;
  status: string;
  updatedAt: Date;
  completedAt: Date | null;
  analysisEnqueuedAt: Date | null;
};

export type InspectionNotification = {
  id: string;
  partnerId: string;
  createdAt: Date;
  deliveredAt: Date | null;
};

export type InspectionJob = {
  id: string;
  type: string;
  status: string;
  partnerId: string | null;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  leaseUntil: Date | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InspectionTeamReport = {
  id: string;
  status: string;
  updatedAt: Date;
};

export type InspectionMemberPeriod = {
  partnerId: string;
  partnerName: string;
  periodKey: string;
  periodStatus: string;
  uploadId: string;
  /** Statuses of the analysis jobs linked to this member's completed uploads for the period. */
  analysisJobStatuses: string[];
  analysisFinishedAt: Date | null;
  currentFactCount: number;
  hasAggregateJob: boolean;
  hasReview: boolean;
};

export type InspectionWorkerHeartbeat = {
  heartbeatAt: Date;
  status: string;
  errorCode: string | null;
};

export type InspectionDatabaseProbe = { ok: boolean; durationMs: number };

export type InspectionInput = {
  now: Date;
  timezone: string;
  devices: InspectionDevice[];
  events: InspectionLogEvent[];
  uploads: InspectionUpload[];
  notifications: InspectionNotification[];
  jobs: InspectionJob[];
  teamReports: InspectionTeamReport[];
  memberPeriods: InspectionMemberPeriod[];
  worker: InspectionWorkerHeartbeat | null;
  databaseProbe: InspectionDatabaseProbe;
};

export const ONLINE_WINDOW_MS = 5 * 60_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const EVIDENCE_EVENT_LIMIT = 20;
const EVIDENCE_JOB_LIMIT = 50;
const FINDING_JOB_LIMIT = 50;

const SCAN_FAILED_CODES = ["SCAN_FAILED", "DISCOVERY_FAILED"];
const UPLOAD_FAILED_CODES = [
  "UPLOAD_FAILED",
  "UPLOAD_PART_FAILED",
  "UPLOAD_NETWORK_FAILED",
  "UPLOAD_POLICY_CHANGED",
  "UPLOAD_SERVER_FAILED",
  "UPLOAD_STORAGE_FAILED",
  "UPLOAD_TOO_LARGE",
];
const ANALYSIS_JOB_TYPES = ["ANALYZE_SYSTEM_LOGS", "ANALYZE_INSPECTION_FINDING"];
const OPEN_JOB_STATUSES = ["PENDING", "LEASED", "RETRY_WAIT"];

export function fingerprintOf(rule: string, subject: string) {
  return `${rule}:${subject}`;
}

function draft(
  chain: InspectionChain,
  rule: string,
  severity: InspectionSeverity,
  partnerId: string | null,
  subject: string,
  title: string,
  evidence: InspectionEvidence,
): InspectionFindingDraft {
  const clean = Object.fromEntries(
    Object.entries(evidence).filter(([, value]) => value !== undefined),
  ) as InspectionEvidence;
  return {
    fingerprint: fingerprintOf(rule, subject),
    chain,
    rule,
    severity,
    partnerId,
    subject,
    title,
    evidence: clean,
  };
}

const iso = (date: Date) => date.toISOString();
const minutesBetween = (later: Date, earlier: Date) =>
  Math.floor((later.getTime() - earlier.getTime()) / MINUTE);

/** Events are ordered by when they happened on the device; arrival time breaks ties. */
function compareEvents(a: InspectionLogEvent, b: InspectionLogEvent) {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime() ||
    a.receivedAt.getTime() - b.receivedAt.getTime()
  );
}

function latestOf(events: InspectionLogEvent[]) {
  return events.reduce<InspectionLogEvent | null>(
    (best, event) => (!best || compareEvents(event, best) > 0 ? event : best),
    null,
  );
}

function eventsByDevice(events: InspectionLogEvent[]) {
  const grouped = new Map<string, InspectionLogEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.deviceId);
    if (list) list.push(event);
    else grouped.set(event.deviceId, [event]);
  }
  return grouped;
}

const deviceLabel = (device: InspectionDevice) =>
  `${device.partnerName} 的 App（${device.deviceName}）`;

export function isDeviceOnline(device: InspectionDevice, now: Date) {
  return (
    device.lastLogAt !== null &&
    now.getTime() - device.lastLogAt.getTime() <= ONLINE_WINDOW_MS
  );
}

// ---------------------------------------------------------------------------------------------
// Auto-upload schedule slots (team time zone)
// ---------------------------------------------------------------------------------------------

const WEEKDAY_NUMBERS: Record<string, number> = {
  Sun: 1,
  Mon: 2,
  Tue: 3,
  Wed: 4,
  Thu: 5,
  Fri: 6,
  Sat: 7,
};

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    second: Number(read("second")),
    /** 1 = Sunday ... 7 = Saturday, the numbering the macOS App stores in uploadWeekday. */
    weekday: WEEKDAY_NUMBERS[read("weekday")] ?? 1,
  };
}

function zoneOffsetMs(date: Date, timeZone: string) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock time in `timeZone` converted to the UTC instant it denotes. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  const corrected = guess - zoneOffsetMs(new Date(result), timeZone);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

export type UploadSchedule = {
  frequency: "daily" | "weekly";
  uploadHour: number;
  uploadMinute: number;
  uploadWeekday?: number | null;
};

/** Most recent scheduled upload instant at or before `now`, evaluated in the team time zone. */
export function lastScheduledUploadSlot(
  now: Date,
  timeZone: string,
  schedule: UploadSchedule,
) {
  const today = localParts(now, timeZone);
  const slotOn = (offsetDays: number) => {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day - offsetDays));
    return zonedTimeToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      schedule.uploadHour,
      schedule.uploadMinute,
      timeZone,
    );
  };
  const weekday = schedule.uploadWeekday ?? 6;
  let back = schedule.frequency === "weekly" ? (today.weekday - weekday + 7) % 7 : 0;
  let slot = slotOn(back);
  if (slot.getTime() > now.getTime()) {
    back += schedule.frequency === "weekly" ? 7 : 1;
    slot = slotOn(back);
  }
  return slot;
}

// ---------------------------------------------------------------------------------------------
// App chain
// ---------------------------------------------------------------------------------------------

type AppInput = Pick<InspectionInput, "now" | "devices" | "events">;

export function appHeartbeatRule({ now, devices }: Pick<InspectionInput, "now" | "devices">) {
  const drafts: InspectionFindingDraft[] = [];
  for (const device of devices) {
    const reference = device.lastLogAt ?? device.createdAt;
    const age = now.getTime() - reference.getTime();
    if (age <= ONLINE_WINDOW_MS) continue;
    const critical = age > 30 * MINUTE;
    const minutes = minutesBetween(now, reference);
    drafts.push(
      draft(
        "app",
        "app.heartbeat",
        critical ? "critical" : "warning",
        device.partnerId,
        `device:${device.id}`,
        device.lastLogAt
          ? `${deviceLabel(device)}已 ${minutes} 分钟没有上报日志`
          : `${deviceLabel(device)}绑定后从未上报日志`,
        {
          deviceId: device.id,
          partnerId: device.partnerId,
          counts: { minutesSinceLastLog: minutes },
          timestamps: device.lastLogAt
            ? { lastLogAt: iso(device.lastLogAt) }
            : { boundAt: iso(device.createdAt) },
        },
      ),
    );
  }
  return drafts;
}

export function appSyncRule({ devices, events }: AppInput) {
  const byDevice = eventsByDevice(events);
  const drafts: InspectionFindingDraft[] = [];
  for (const device of devices) {
    const own = byDevice.get(device.id) ?? [];
    const failures = own.filter(
      (event) =>
        event.code === "POLICY_SYNC_FAILED" ||
        event.code === "UPLOAD_AUTH_FAILED" ||
        (event.level === "error" &&
          (event.details?.httpStatus === 401 || event.details?.errorKind === "auth")),
    );
    const failure = latestOf(failures);
    if (!failure) continue;
    const recovery = latestOf(
      own.filter((event) =>
        ["POLICY_SYNCED", "BOUND", "UPLOAD_COMPLETED"].includes(event.code),
      ),
    );
    if (recovery && compareEvents(recovery, failure) > 0) continue;
    drafts.push(
      draft(
        "app",
        "app.sync",
        "critical",
        device.partnerId,
        `device:${device.id}`,
        `${deviceLabel(device)}无法同步权限或认证失败`,
        {
          deviceId: device.id,
          partnerId: device.partnerId,
          eventIds: [failure.eventId],
          codes: [failure.code],
          timestamps: { failedAt: iso(failure.occurredAt) },
        },
      ),
    );
  }
  return drafts;
}

export function appScanRule({ devices, events }: AppInput) {
  const byDevice = eventsByDevice(events);
  const drafts: InspectionFindingDraft[] = [];
  for (const device of devices) {
    const own = byDevice.get(device.id) ?? [];
    const lifecycle = own.filter(
      (event) =>
        (event.stage === "scan" || event.stage === "discovery") &&
        event.code !== "SESSION_READ_FAILED",
    );
    const latest = latestOf(lifecycle);
    if (latest && SCAN_FAILED_CODES.includes(latest.code)) {
      drafts.push(
        draft(
          "app",
          "app.scan",
          "critical",
          device.partnerId,
          `device:${device.id}`,
          `${deviceLabel(device)}扫描会话失败`,
          {
            deviceId: device.id,
            partnerId: device.partnerId,
            eventIds: [latest.eventId],
            codes: [latest.code],
            timestamps: { failedAt: iso(latest.occurredAt) },
          },
        ),
      );
      continue;
    }
    const lastCompleted = latestOf(own.filter((event) => event.code === "SCAN_COMPLETED"));
    const readFailures = own.filter(
      (event) =>
        event.code === "SESSION_READ_FAILED" &&
        (!lastCompleted || compareEvents(event, lastCompleted) > 0),
    );
    const unreadable = device.clientState?.unreadableSessionCount ?? 0;
    if (readFailures.length === 0 && unreadable <= 0) continue;
    drafts.push(
      draft(
        "app",
        "app.scan",
        "warning",
        device.partnerId,
        `device:${device.id}`,
        `${deviceLabel(device)}有会话无法读取`,
        {
          deviceId: device.id,
          partnerId: device.partnerId,
          eventIds: readFailures
            .sort((a, b) => compareEvents(b, a))
            .slice(0, EVIDENCE_EVENT_LIMIT)
            .map((event) => event.eventId),
          codes: readFailures.length > 0 ? ["SESSION_READ_FAILED"] : [],
          counts: { unreadableSessionCount: unreadable, readFailureEvents: readFailures.length },
        },
      ),
    );
  }
  return drafts;
}

export function appUploadRule({
  now,
  timezone,
  devices,
  events,
  uploads,
}: Pick<InspectionInput, "now" | "timezone" | "devices" | "events" | "uploads">) {
  const byDevice = eventsByDevice(events);
  const drafts: InspectionFindingDraft[] = [];
  for (const device of devices) {
    const own = byDevice.get(device.id) ?? [];
    const reasons: Array<{ severity: InspectionSeverity; title: string }> = [];
    const evidence: InspectionEvidence = { deviceId: device.id, partnerId: device.partnerId };
    const latest = latestOf(own.filter((event) => event.stage === "upload"));
    if (
      latest &&
      latest.level === "error" &&
      latest.code !== "UPLOAD_AUTH_FAILED" &&
      UPLOAD_FAILED_CODES.includes(latest.code)
    ) {
      reasons.push({ severity: "critical", title: `${deviceLabel(device)}上传失败` });
      evidence.eventIds = [latest.eventId];
      evidence.codes = [latest.code];
      evidence.timestamps = { ...evidence.timestamps, failedAt: iso(latest.occurredAt) };
    }
    const stuck = uploads.filter(
      (upload) =>
        upload.deviceId === device.id &&
        upload.status === "receiving" &&
        now.getTime() - upload.updatedAt.getTime() > 15 * MINUTE,
    );
    if (stuck.length > 0) {
      const oldest = stuck.reduce((a, b) => (a.updatedAt < b.updatedAt ? a : b));
      reasons.push({ severity: "warning", title: `${deviceLabel(device)}有分包批次超过 15 分钟未推进` });
      evidence.uploadId = oldest.id;
      evidence.counts = { ...evidence.counts, stalledUploads: stuck.length };
      evidence.timestamps = { ...evidence.timestamps, stalledSince: iso(oldest.updatedAt) };
    }
    const state = device.clientState;
    if (
      state?.autoUpload === true &&
      state.frequency &&
      typeof state.uploadHour === "number" &&
      typeof state.uploadMinute === "number" &&
      isDeviceOnline(device, now)
    ) {
      const slot = lastScheduledUploadSlot(now, timezone, {
        frequency: state.frequency,
        uploadHour: state.uploadHour,
        uploadMinute: state.uploadMinute,
        uploadWeekday: state.uploadWeekday ?? null,
      });
      const overdue = now.getTime() - slot.getTime() > 30 * MINUTE;
      const boundBeforeSlot = device.createdAt.getTime() <= slot.getTime();
      const uploadedSince =
        (device.lastUploadAt !== null && device.lastUploadAt.getTime() >= slot.getTime()) ||
        uploads.some(
          (upload) =>
            upload.deviceId === device.id &&
            upload.completedAt !== null &&
            upload.completedAt.getTime() >= slot.getTime(),
        ) ||
        own.some(
          (event) => event.code === "UPLOAD_COMPLETED" && event.occurredAt.getTime() >= slot.getTime(),
        );
      if (overdue && boundBeforeSlot && !uploadedSince) {
        reasons.push({ severity: "warning", title: `${deviceLabel(device)}已错过定时上传` });
        evidence.timestamps = { ...evidence.timestamps, scheduledSlot: iso(slot) };
        evidence.counts = {
          ...evidence.counts,
          minutesOverdue: minutesBetween(now, slot),
        };
      }
    }
    if (reasons.length === 0) continue;
    const top = reasons.find((reason) => reason.severity === "critical") ?? reasons[0]!;
    drafts.push(
      draft(
        "app",
        "app.upload",
        top.severity,
        device.partnerId,
        `device:${device.id}`,
        top.title,
        evidence,
      ),
    );
  }
  return drafts;
}

/** Partners with an undelivered notification older than 15 minutes. */
export function staleNotificationsByPartner(
  notifications: InspectionNotification[],
  now: Date,
) {
  const grouped = new Map<string, InspectionNotification[]>();
  for (const notification of notifications) {
    if (notification.deliveredAt !== null) continue;
    if (now.getTime() - notification.createdAt.getTime() <= 15 * MINUTE) continue;
    const list = grouped.get(notification.partnerId);
    if (list) list.push(notification);
    else grouped.set(notification.partnerId, [notification]);
  }
  return grouped;
}

export function appNotificationRule({
  now,
  devices,
  events,
  notifications,
}: Pick<InspectionInput, "now" | "devices" | "events" | "notifications">) {
  const byDevice = eventsByDevice(events);
  const stale = staleNotificationsByPartner(notifications, now);
  const drafts = new Map<string, InspectionFindingDraft>();
  for (const device of devices) {
    const own = byDevice.get(device.id) ?? [];
    const permission = latestOf(
      own.filter(
        (event) =>
          event.stage === "notification" &&
          ["NOTIFICATIONS_ALLOWED", "NOTIFICATIONS_DENIED", "NOTIFICATIONS_NOT_CONFIGURED"].includes(
            event.code,
          ),
      ),
    );
    if (permission && permission.code !== "NOTIFICATIONS_ALLOWED") {
      drafts.set(
        device.id,
        draft(
          "app",
          "app.notification",
          "warning",
          device.partnerId,
          `device:${device.id}`,
          `${deviceLabel(device)}未开启系统通知`,
          {
            deviceId: device.id,
            partnerId: device.partnerId,
            eventIds: [permission.eventId],
            codes: [permission.code],
            timestamps: { reportedAt: iso(permission.occurredAt) },
          },
        ),
      );
    }
  }
  // A partner whose notifications are stuck while an App is online is an App problem; with no online
  // App it is reported once by system.notification_delivery instead.
  for (const [partnerId, pending] of stale) {
    const online = devices
      .filter((device) => device.partnerId === partnerId && isDeviceOnline(device, now))
      .sort((a, b) => (b.lastLogAt?.getTime() ?? 0) - (a.lastLogAt?.getTime() ?? 0));
    const device = online[0];
    if (!device) continue;
    const oldest = pending.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const existing = drafts.get(device.id);
    const counts = { ...existing?.evidence.counts, undeliveredNotifications: pending.length };
    const timestamps = { ...existing?.evidence.timestamps, oldestUndeliveredAt: iso(oldest.createdAt) };
    drafts.set(
      device.id,
      draft(
        "app",
        "app.notification",
        "warning",
        partnerId,
        `device:${device.id}`,
        existing?.title ?? `${deviceLabel(device)}的通知超过 15 分钟未投递`,
        { ...existing?.evidence, deviceId: device.id, partnerId, counts, timestamps },
      ),
    );
  }
  return [...drafts.values()];
}

// ---------------------------------------------------------------------------------------------
// System chain
// ---------------------------------------------------------------------------------------------

export function systemProbeRule({ databaseProbe }: Pick<InspectionInput, "databaseProbe">) {
  if (databaseProbe.ok && databaseProbe.durationMs <= 5_000) return [];
  return [
    draft(
      "system",
      "system.probe",
      "critical",
      null,
      "database",
      databaseProbe.ok ? "数据库响应过慢" : "数据库探测失败",
      { counts: { durationMs: databaseProbe.durationMs } },
    ),
  ];
}

export function systemWorkerRule({ now, worker }: Pick<InspectionInput, "now" | "worker">) {
  if (!worker) {
    return [
      draft("system", "system.worker", "critical", null, "worker", "Worker 从未上报心跳", {}),
    ];
  }
  const age = now.getTime() - worker.heartbeatAt.getTime();
  const seconds = Math.floor(age / 1000);
  const evidence: InspectionEvidence = {
    counts: { secondsSinceHeartbeat: seconds },
    timestamps: { heartbeatAt: iso(worker.heartbeatAt) },
    codes: worker.errorCode ? [worker.errorCode] : [],
  };
  if (age > 300_000) {
    return [
      draft("system", "system.worker", "critical", null, "worker", `Worker 已 ${Math.floor(seconds / 60)} 分钟没有心跳`, evidence),
    ];
  }
  if (age > 90_000) {
    return [
      draft("system", "system.worker", "warning", null, "worker", `Worker 已 ${seconds} 秒没有心跳`, evidence),
    ];
  }
  if (worker.status === "error") {
    return [
      draft("system", "system.worker", "warning", null, "worker", "Worker 最近一次处理报错", evidence),
    ];
  }
  return [];
}

const isCentralJob = (job: InspectionJob) => !job.type.startsWith("SYSTEM_HEALTH_");

function jobIds(jobs: InspectionJob[]) {
  return jobs
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, EVIDENCE_JOB_LIMIT)
    .map((job) => job.id);
}

export function systemQueueRule({ now, jobs }: Pick<InspectionInput, "now" | "jobs">) {
  const central = jobs.filter(isCentralJob);
  const drafts: InspectionFindingDraft[] = [];
  const expired = central.filter(
    (job) =>
      job.status === "LEASED" && job.leaseUntil !== null && job.leaseUntil.getTime() < now.getTime(),
  );
  if (expired.length > 0)
    drafts.push(
      draft(
        "system",
        "system.queue",
        "critical",
        null,
        "expired_lease",
        `${expired.length} 个任务租约已过期`,
        { jobIds: jobIds(expired), counts: { jobs: expired.length } },
      ),
    );
  const pending = central.filter(
    (job) => job.status === "PENDING" && now.getTime() - job.createdAt.getTime() > HOUR,
  );
  if (pending.length > 0)
    drafts.push(
      draft(
        "system",
        "system.queue",
        "warning",
        null,
        "pending_backlog",
        `${pending.length} 个任务排队超过 1 小时`,
        { jobIds: jobIds(pending), counts: { jobs: pending.length } },
      ),
    );
  const retrying = central.filter((job) => job.status === "RETRY_WAIT");
  if (retrying.length > 0)
    drafts.push(
      draft(
        "system",
        "system.queue",
        "warning",
        null,
        "retry_wait",
        `${retrying.length} 个任务正在等待重试`,
        {
          jobIds: jobIds(retrying),
          counts: { jobs: retrying.length },
          codes: [...new Set(retrying.map((job) => job.errorCode).filter((c): c is string => !!c))].slice(0, 10),
        },
      ),
    );
  return drafts;
}

function failedJobDrafts(
  jobs: InspectionJob[],
  type: string,
  rule: string,
  title: (job: InspectionJob) => string,
) {
  return jobs
    .filter((job) => job.type === type && job.status === "FAILED")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, FINDING_JOB_LIMIT)
    .map((job) =>
      draft("system", rule, "critical", job.partnerId, `job:${job.id}`, title(job), {
        jobIds: [job.id],
        executionId: `job:${job.id}`,
        ...(job.partnerId ? { partnerId: job.partnerId } : {}),
        codes: job.errorCode ? [job.errorCode] : [],
        counts: { attemptCount: job.attemptCount, maxAttempts: job.maxAttempts },
        timestamps: { failedAt: iso(job.updatedAt) },
      }),
    );
}

export function systemSessionAnalysisRule({ jobs }: Pick<InspectionInput, "jobs">) {
  return failedJobDrafts(jobs, "EXTRACT_COLLECTOR_SESSION", "system.session_analysis", () => "会话分析任务失败");
}

export function systemCardGenerationRule({ jobs }: Pick<InspectionInput, "jobs">) {
  return failedJobDrafts(jobs, "AGGREGATE_WORK_ITEMS", "system.card_generation", () => "工作卡片生成任务失败");
}

export function systemReportRule({
  now,
  jobs,
  teamReports,
}: Pick<InspectionInput, "now" | "jobs" | "teamReports">) {
  const drafts: InspectionFindingDraft[] = [];
  for (const report of teamReports) {
    if (report.status !== "AGGREGATING") continue;
    if (now.getTime() - report.updatedAt.getTime() <= HOUR) continue;
    drafts.push(
      draft(
        "system",
        "system.report",
        "critical",
        null,
        `report:${report.id}`,
        "团队周报汇总超过 1 小时未完成",
        {
          counts: { minutesAggregating: minutesBetween(now, report.updatedAt) },
          timestamps: { aggregatingSince: iso(report.updatedAt) },
        },
      ),
    );
  }
  drafts.push(
    ...["GENERATE_TEAM_REPORT", "REGENERATE_TEAM_REPORT"].flatMap((type) =>
      failedJobDrafts(jobs, type, "system.report", () => "团队周报生成任务失败"),
    ),
  );
  return drafts;
}

export function systemNotificationDeliveryRule({
  now,
  devices,
  notifications,
}: Pick<InspectionInput, "now" | "devices" | "notifications">) {
  const stale = staleNotificationsByPartner(notifications, now);
  const offline = [...stale.entries()].filter(
    ([partnerId]) =>
      !devices.some((device) => device.partnerId === partnerId && isDeviceOnline(device, now)),
  );
  if (offline.length === 0) return [];
  const total = offline.reduce((sum, [, pending]) => sum + pending.length, 0);
  const oldest = offline
    .flatMap(([, pending]) => pending)
    .reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
  return [
    draft(
      "system",
      "system.notification_delivery",
      "warning",
      null,
      "team",
      `${offline.length} 位成员的通知超过 15 分钟未投递且 App 不在线`,
      {
        counts: { members: offline.length, undeliveredNotifications: total },
        timestamps: { oldestUndeliveredAt: iso(oldest.createdAt) },
      },
    ),
  ];
}

const isModelError = (code: string | null): code is string => !!code && code.startsWith("MODEL_");

export function systemModelGatewayRule({ now, jobs }: Pick<InspectionInput, "now" | "jobs">) {
  const since = now.getTime() - 30 * MINUTE;
  const byCode = new Map<string, InspectionJob[]>();
  for (const job of jobs) {
    if (!["FAILED", "RETRY_WAIT"].includes(job.status)) continue;
    if (!isModelError(job.errorCode) || job.updatedAt.getTime() < since) continue;
    const list = byCode.get(job.errorCode);
    if (list) list.push(job);
    else byCode.set(job.errorCode, [job]);
  }
  const drafts: InspectionFindingDraft[] = [];
  for (const [code, group] of [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    drafts.push(
      draft(
        "system",
        "system.model_gateway",
        group.length >= 5 ? "critical" : "warning",
        null,
        `code:${code}`,
        `近 30 分钟有 ${group.length} 个任务因模型错误 ${code} 失败或重试`,
        { codes: [code], jobIds: jobIds(group), counts: { jobs: group.length } },
      ),
    );
  }
  return drafts;
}

// ---------------------------------------------------------------------------------------------
// Pipeline chain
// ---------------------------------------------------------------------------------------------

export function pipelineAnalysisNotQueuedRule({
  now,
  uploads,
}: Pick<InspectionInput, "now" | "uploads">) {
  return uploads
    .filter(
      (upload) =>
        upload.status === "completed" &&
        upload.analysisEnqueuedAt === null &&
        upload.completedAt !== null &&
        now.getTime() - upload.completedAt.getTime() > 10 * MINUTE,
    )
    .map((upload) =>
      draft(
        "pipeline",
        "pipeline.analysis_not_queued",
        "critical",
        upload.partnerId,
        `upload:${upload.id}`,
        "上传已完整接收，但会话分析任务超过 10 分钟仍未登记",
        {
          uploadId: upload.id,
          deviceId: upload.deviceId,
          partnerId: upload.partnerId,
          timestamps: { completedAt: iso(upload.completedAt!) },
          counts: { minutesWaiting: minutesBetween(now, upload.completedAt!) },
        },
      ),
    );
}

const FINISHED_JOB_STATUSES = ["COMPLETED", "CANCELLED"];

export function pipelineCardNotQueuedRule({
  now,
  memberPeriods,
}: Pick<InspectionInput, "now" | "memberPeriods">) {
  return memberPeriods
    .filter(
      (member) =>
        ["open", "closing"].includes(member.periodStatus) &&
        member.analysisJobStatuses.length > 0 &&
        member.analysisJobStatuses.every((status) => FINISHED_JOB_STATUSES.includes(status)) &&
        member.currentFactCount > 0 &&
        !member.hasAggregateJob &&
        member.analysisFinishedAt !== null &&
        now.getTime() - member.analysisFinishedAt.getTime() > 10 * MINUTE,
    )
    .map((member) =>
      draft(
        "pipeline",
        "pipeline.card_not_queued",
        "warning",
        member.partnerId,
        `member:${member.partnerId}:${member.periodKey}`,
        `${member.partnerName} 的会话分析已完成，但超过 10 分钟没有生成工作卡片任务`,
        {
          partnerId: member.partnerId,
          uploadId: member.uploadId,
          counts: { currentFacts: member.currentFactCount },
          timestamps: { analysisFinishedAt: iso(member.analysisFinishedAt!) },
        },
      ),
    );
}

export function pipelineNoReviewRule({
  now,
  memberPeriods,
}: Pick<InspectionInput, "now" | "memberPeriods">) {
  return memberPeriods
    .filter(
      (member) =>
        ["open", "closing"].includes(member.periodStatus) &&
        member.analysisJobStatuses.length > 0 &&
        member.analysisJobStatuses.every((status) => FINISHED_JOB_STATUSES.includes(status)) &&
        member.currentFactCount > 0 &&
        !member.hasReview &&
        member.analysisFinishedAt !== null &&
        now.getTime() - member.analysisFinishedAt.getTime() > 10 * MINUTE,
    )
    .map((member) =>
      draft(
        "pipeline",
        "pipeline.no_review",
        "warning",
        member.partnerId,
        `member:${member.partnerId}:${member.periodKey}`,
        `${member.partnerName} 本期已有上传，但超过 10 分钟没有生成审核记录`,
        {
          partnerId: member.partnerId,
          uploadId: member.uploadId,
          counts: { currentFacts: member.currentFactCount },
          timestamps: { analysisFinishedAt: iso(member.analysisFinishedAt!) },
        },
      ),
    );
}

export const inspectionRules = [
  appHeartbeatRule,
  appSyncRule,
  appScanRule,
  appUploadRule,
  appNotificationRule,
  systemProbeRule,
  systemWorkerRule,
  systemQueueRule,
  systemSessionAnalysisRule,
  systemCardGenerationRule,
  systemReportRule,
  systemNotificationDeliveryRule,
  systemModelGatewayRule,
  pipelineAnalysisNotQueuedRule,
  pipelineCardNotQueuedRule,
  pipelineNoReviewRule,
] as const;

/** Runs every rule; fingerprints are unique, and the more severe draft wins on a collision. */
export function evaluateInspection(input: InspectionInput): InspectionFindingDraft[] {
  const byFingerprint = new Map<string, InspectionFindingDraft>();
  for (const rule of inspectionRules) {
    for (const finding of (rule as (input: InspectionInput) => InspectionFindingDraft[])(input)) {
      const existing = byFingerprint.get(finding.fingerprint);
      if (!existing || (existing.severity === "warning" && finding.severity === "critical"))
        byFingerprint.set(finding.fingerprint, finding);
    }
  }
  return [...byFingerprint.values()];
}
