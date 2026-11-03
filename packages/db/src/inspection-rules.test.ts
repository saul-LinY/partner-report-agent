import { describe, expect, it } from "vitest";
import {
  appHeartbeatRule,
  appNotificationRule,
  appScanRule,
  appSyncRule,
  appUploadRule,
  evaluateInspection,
  lastScheduledUploadSlot,
  pipelineAnalysisNotQueuedRule,
  pipelineCardNotQueuedRule,
  pipelineNoReviewRule,
  systemCardGenerationRule,
  systemModelGatewayRule,
  systemNotificationDeliveryRule,
  systemProbeRule,
  systemQueueRule,
  systemReportRule,
  systemSessionAnalysisRule,
  systemWorkerRule,
  zonedTimeToUtc,
  type InspectionDevice,
  type InspectionInput,
  type InspectionJob,
  type InspectionLogEvent,
  type InspectionUpload,
} from "./inspection-rules.js";

const now = new Date("2026-11-03T04:00:00.000Z");
const minutesAgo = (minutes: number, from = now) => new Date(from.getTime() - minutes * 60_000);

const device = (overrides: Partial<InspectionDevice> = {}): InspectionDevice => ({
  id: "dev-1",
  partnerId: "partner-1",
  partnerName: "小李",
  deviceName: "MacBook",
  createdAt: minutesAgo(60 * 24 * 30),
  lastLogAt: minutesAgo(1),
  lastUploadAt: null,
  clientState: null,
  ...overrides,
});

let eventSeq = 0;
const event = (overrides: Partial<InspectionLogEvent> = {}): InspectionLogEvent => ({
  eventId: `event-${++eventSeq}`,
  deviceId: "dev-1",
  occurredAt: minutesAgo(10),
  receivedAt: minutesAgo(10),
  stage: "heartbeat",
  level: "info",
  code: "ALIVE",
  details: null,
  ...overrides,
});

const upload = (overrides: Partial<InspectionUpload> = {}): InspectionUpload => ({
  id: "upload-1",
  deviceId: "dev-1",
  partnerId: "partner-1",
  periodKey: "2026-W45",
  status: "completed",
  updatedAt: minutesAgo(5),
  completedAt: minutesAgo(5),
  analysisEnqueuedAt: minutesAgo(5),
  ...overrides,
});

const job = (overrides: Partial<InspectionJob> = {}): InspectionJob => ({
  id: "job-1",
  type: "EXTRACT_COLLECTOR_SESSION",
  status: "PENDING",
  partnerId: "partner-1",
  attemptCount: 0,
  maxAttempts: 3,
  errorCode: null,
  leaseUntil: null,
  nextRetryAt: null,
  createdAt: minutesAgo(1),
  updatedAt: minutesAgo(1),
  ...overrides,
});

const baseInput = (overrides: Partial<InspectionInput> = {}): InspectionInput => ({
  now,
  timezone: "Asia/Shanghai",
  devices: [],
  events: [],
  uploads: [],
  notifications: [],
  jobs: [],
  teamReports: [],
  memberPeriods: [],
  worker: { heartbeatAt: minutesAgo(0.1), status: "idle", errorCode: null },
  databaseProbe: { ok: true, durationMs: 3 },
  ...overrides,
});

describe("app.heartbeat", () => {
  it("is quiet within five minutes", () => {
    expect(
      appHeartbeatRule({ now, devices: [device({ lastLogAt: minutesAgo(5) })] }),
    ).toEqual([]);
  });

  it("warns after five minutes and turns critical after thirty", () => {
    const [warning] = appHeartbeatRule({
      now,
      devices: [device({ lastLogAt: minutesAgo(6) })],
    });
    expect(warning).toMatchObject({
      rule: "app.heartbeat",
      severity: "warning",
      subject: "device:dev-1",
      fingerprint: "app.heartbeat:device:dev-1",
      chain: "app",
      partnerId: "partner-1",
    });
    expect(warning!.title).toContain("6 分钟");
    expect(
      appHeartbeatRule({ now, devices: [device({ lastLogAt: minutesAgo(30) })] })[0]!.severity,
    ).toBe("warning");
    expect(
      appHeartbeatRule({ now, devices: [device({ lastLogAt: minutesAgo(31) })] })[0]!.severity,
    ).toBe("critical");
  });

  it("falls back to the binding time for a device that never logged", () => {
    const [finding] = appHeartbeatRule({
      now,
      devices: [device({ lastLogAt: null, createdAt: minutesAgo(45) })],
    });
    expect(finding).toMatchObject({ severity: "critical" });
    expect(finding!.title).toContain("从未上报");
    expect(finding!.evidence.timestamps).toEqual({ boundAt: minutesAgo(45).toISOString() });
    expect(appHeartbeatRule({ now, devices: [device({ lastLogAt: null, createdAt: minutesAgo(2) })] })).toEqual([]);
  });
});

describe("app.sync", () => {
  it("reports a policy sync failure that has not recovered", () => {
    const failure = event({ stage: "permissions", level: "error", code: "POLICY_SYNC_FAILED" });
    const [finding] = appSyncRule({ now, devices: [device()], events: [failure] });
    expect(finding).toMatchObject({ rule: "app.sync", severity: "critical" });
    expect(finding!.evidence).toMatchObject({
      eventIds: [failure.eventId],
      codes: ["POLICY_SYNC_FAILED"],
      deviceId: "dev-1",
    });
  });

  it("treats an HTTP 401 error as an auth failure and ignores other errors", () => {
    const auth = event({ stage: "upload", level: "error", code: "UPLOAD_FAILED", details: { httpStatus: 401 } });
    expect(appSyncRule({ now, devices: [device()], events: [auth] })).toHaveLength(1);
    const server = event({ stage: "upload", level: "error", code: "UPLOAD_FAILED", details: { httpStatus: 500 } });
    expect(appSyncRule({ now, devices: [device()], events: [server] })).toEqual([]);
  });

  it("resolves once a later POLICY_SYNCED or BOUND arrives", () => {
    const failure = event({ stage: "permissions", level: "error", code: "POLICY_SYNC_FAILED", occurredAt: minutesAgo(10) });
    const recovered = event({ stage: "permissions", code: "POLICY_SYNCED", occurredAt: minutesAgo(5) });
    expect(appSyncRule({ now, devices: [device()], events: [failure, recovered] })).toEqual([]);
    const later = event({ stage: "permissions", level: "error", code: "UPLOAD_AUTH_FAILED", occurredAt: minutesAgo(2) });
    expect(appSyncRule({ now, devices: [device()], events: [failure, recovered, later] })).toHaveLength(1);
  });
});

describe("app.scan", () => {
  it("is critical when the latest scan-stage event failed", () => {
    const failed = event({ stage: "scan", level: "error", code: "SCAN_FAILED" });
    const [finding] = appScanRule({ now, devices: [device()], events: [failed] });
    expect(finding).toMatchObject({ rule: "app.scan", severity: "critical" });
    expect(finding!.evidence.codes).toEqual(["SCAN_FAILED"]);
  });

  it("clears the critical state when a newer scan completed", () => {
    const failed = event({ stage: "discovery", level: "error", code: "DISCOVERY_FAILED", occurredAt: minutesAgo(10) });
    const done = event({ stage: "scan", code: "SCAN_COMPLETED", occurredAt: minutesAgo(3) });
    expect(appScanRule({ now, devices: [device()], events: [failed, done] })).toEqual([]);
  });

  it("warns on unreadable sessions reported in client state", () => {
    const [finding] = appScanRule({
      now,
      devices: [device({ clientState: { unreadableSessionCount: 3 } })],
      events: [],
    });
    expect(finding).toMatchObject({ severity: "warning" });
    expect(finding!.evidence.counts).toMatchObject({ unreadableSessionCount: 3 });
  });

  it("warns on SESSION_READ_FAILED newer than the last completed scan only", () => {
    const stale = event({ stage: "scan", level: "warning", code: "SESSION_READ_FAILED", occurredAt: minutesAgo(20) });
    const done = event({ stage: "scan", code: "SCAN_COMPLETED", occurredAt: minutesAgo(10) });
    expect(appScanRule({ now, devices: [device()], events: [stale, done] })).toEqual([]);
    const fresh = event({ stage: "scan", level: "warning", code: "SESSION_READ_FAILED", occurredAt: minutesAgo(2) });
    const [finding] = appScanRule({ now, devices: [device()], events: [stale, done, fresh] });
    expect(finding).toMatchObject({ severity: "warning" });
    expect(finding!.evidence.eventIds).toEqual([fresh.eventId]);
  });
});

describe("auto-upload schedule slots", () => {
  it("converts team wall-clock time to UTC", () => {
    expect(zonedTimeToUtc(2026, 11, 3, 17, 0, "Asia/Shanghai").toISOString()).toBe("2026-11-03T09:00:00.000Z");
    // US daylight saving ended on 2026-11-01: New York is UTC-5 afterwards, UTC-4 before.
    expect(zonedTimeToUtc(2026, 11, 3, 9, 0, "America/New_York").toISOString()).toBe("2026-11-03T14:00:00.000Z");
    expect(zonedTimeToUtc(2026, 10, 30, 9, 0, "America/New_York").toISOString()).toBe("2026-10-30T13:00:00.000Z");
  });

  it("picks today's daily slot once it has passed", () => {
    // 2026-11-03 12:00 Shanghai; daily slot at 09:30 local.
    const at = new Date("2026-11-03T04:00:00.000Z");
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "daily", uploadHour: 9, uploadMinute: 30 }).toISOString(),
    ).toBe("2026-11-03T01:30:00.000Z");
  });

  it("uses yesterday's daily slot before today's has happened", () => {
    // 2026-11-03 02:00 Shanghai; daily slot at 09:30 local has not happened.
    const at = new Date("2026-11-02T18:00:00.000Z");
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "daily", uploadHour: 9, uploadMinute: 30 }).toISOString(),
    ).toBe("2026-11-02T01:30:00.000Z");
  });

  it("respects the team time zone rather than UTC for the local day", () => {
    // 2026-11-03T20:00Z is 2026-11-04 04:00 in Shanghai; daily 03:00 local slot is on Nov 4 local = Nov 3 19:00Z.
    const at = new Date("2026-11-03T20:00:00.000Z");
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "daily", uploadHour: 3, uploadMinute: 0 }).toISOString(),
    ).toBe("2026-11-03T19:00:00.000Z");
  });

  it("computes weekly slots with the App weekday numbering (1 = Sunday ... 7 = Saturday)", () => {
    // 2026-11-03 is a Tuesday. Friday (6) 17:00 Shanghai most recently happened on 2026-10-30.
    const at = new Date("2026-11-03T04:00:00.000Z");
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "weekly", uploadHour: 17, uploadMinute: 0, uploadWeekday: 6 }).toISOString(),
    ).toBe("2026-10-30T09:00:00.000Z");
    // Tuesday (3) 09:00 local has already happened today.
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "weekly", uploadHour: 9, uploadMinute: 0, uploadWeekday: 3 }).toISOString(),
    ).toBe("2026-11-03T01:00:00.000Z");
    // Tuesday (3) 23:00 local has not; fall back one week.
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "weekly", uploadHour: 23, uploadMinute: 0, uploadWeekday: 3 }).toISOString(),
    ).toBe("2026-10-27T15:00:00.000Z");
  });

  it("defaults the weekly weekday to Friday like the App", () => {
    const at = new Date("2026-11-03T04:00:00.000Z");
    expect(
      lastScheduledUploadSlot(at, "Asia/Shanghai", { frequency: "weekly", uploadHour: 17, uploadMinute: 0 }).toISOString(),
    ).toBe("2026-10-30T09:00:00.000Z");
  });
});

describe("app.upload", () => {
  const daily = { autoUpload: true, frequency: "daily" as const, uploadHour: 9, uploadMinute: 0 };

  it("is critical when the latest upload-stage event is a failure", () => {
    const failed = event({ stage: "upload", level: "error", code: "UPLOAD_NETWORK_FAILED" });
    const [finding] = appUploadRule({ now, timezone: "Asia/Shanghai", devices: [device()], events: [failed], uploads: [] });
    expect(finding).toMatchObject({ rule: "app.upload", severity: "critical" });
    expect(finding!.evidence.codes).toEqual(["UPLOAD_NETWORK_FAILED"]);
  });

  it("leaves auth failures to app.sync and ignores a failure superseded by completion", () => {
    const auth = event({ stage: "upload", level: "error", code: "UPLOAD_AUTH_FAILED" });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [device()], events: [auth], uploads: [] })).toEqual([]);
    const failed = event({ stage: "upload", level: "error", code: "UPLOAD_FAILED", occurredAt: minutesAgo(10) });
    const done = event({ stage: "upload", code: "UPLOAD_COMPLETED", occurredAt: minutesAgo(2) });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [device()], events: [failed, done], uploads: [] })).toEqual([]);
  });

  it("warns on a receiving upload that has not advanced for 15 minutes", () => {
    const fresh = upload({ status: "receiving", updatedAt: minutesAgo(15), completedAt: null });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [device()], events: [], uploads: [fresh] })).toEqual([]);
    const stuck = upload({ status: "receiving", updatedAt: minutesAgo(16), completedAt: null });
    const [finding] = appUploadRule({ now, timezone: "Asia/Shanghai", devices: [device()], events: [], uploads: [stuck] });
    expect(finding).toMatchObject({ severity: "warning" });
    expect(finding!.evidence.uploadId).toBe("upload-1");
  });

  it("warns when the scheduled slot passed over 30 minutes ago without a completed upload", () => {
    // now = 12:00 Shanghai, slot = 09:00 local.
    const state = device({ clientState: daily });
    const [finding] = appUploadRule({ now, timezone: "Asia/Shanghai", devices: [state], events: [], uploads: [] });
    expect(finding).toMatchObject({ severity: "warning", rule: "app.upload" });
    expect(finding!.evidence.timestamps).toMatchObject({ scheduledSlot: "2026-11-03T01:00:00.000Z" });
    expect(finding!.evidence.counts).toMatchObject({ minutesOverdue: 180 });
  });

  it("is quiet when an upload completed after the slot, within the grace window, or auto-upload is off", () => {
    const uploadedSince = device({ clientState: daily, lastUploadAt: minutesAgo(60) });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [uploadedSince], events: [], uploads: [] })).toEqual([]);
    const completed = upload({ completedAt: minutesAgo(90) });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [device({ clientState: daily })], events: [], uploads: [completed] })).toEqual([]);
    // Slot at 11:45 local; only 15 minutes have passed.
    const grace = device({ clientState: { ...daily, uploadHour: 11, uploadMinute: 45 } });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [grace], events: [], uploads: [] })).toEqual([]);
    const off = device({ clientState: { ...daily, autoUpload: false } });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [off], events: [], uploads: [] })).toEqual([]);
  });

  it("does not flag a missed slot for an offline App or one bound after the slot", () => {
    const offline = device({ clientState: daily, lastLogAt: minutesAgo(40) });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [offline], events: [], uploads: [] })).toEqual([]);
    const fresh = device({ clientState: daily, createdAt: minutesAgo(30) });
    expect(appUploadRule({ now, timezone: "Asia/Shanghai", devices: [fresh], events: [], uploads: [] })).toEqual([]);
  });
});

describe("app.notification", () => {
  it("warns when notifications are denied or not configured, and clears when allowed later", () => {
    const denied = event({ stage: "notification", level: "warning", code: "NOTIFICATIONS_DENIED", occurredAt: minutesAgo(20) });
    const [finding] = appNotificationRule({ now, devices: [device()], events: [denied], notifications: [] });
    expect(finding).toMatchObject({ rule: "app.notification", severity: "warning" });
    const allowed = event({ stage: "notification", code: "NOTIFICATIONS_ALLOWED", occurredAt: minutesAgo(5) });
    expect(appNotificationRule({ now, devices: [device()], events: [denied, allowed], notifications: [] })).toEqual([]);
  });

  it("warns on a notification undelivered for over 15 minutes while the App is online", () => {
    const pending = { id: "n1", partnerId: "partner-1", createdAt: minutesAgo(16), deliveredAt: null };
    const [finding] = appNotificationRule({ now, devices: [device()], events: [], notifications: [pending] });
    expect(finding!.evidence.counts).toMatchObject({ undeliveredNotifications: 1 });
    const recent = { ...pending, createdAt: minutesAgo(10) };
    expect(appNotificationRule({ now, devices: [device()], events: [], notifications: [recent] })).toEqual([]);
    const delivered = { ...pending, deliveredAt: minutesAgo(1) };
    expect(appNotificationRule({ now, devices: [device()], events: [], notifications: [delivered] })).toEqual([]);
  });

  it("leaves partners without an online App to system.notification_delivery, avoiding duplicates", () => {
    const pending = { id: "n1", partnerId: "partner-1", createdAt: minutesAgo(20), deliveredAt: null };
    const offline = device({ lastLogAt: minutesAgo(60) });
    expect(appNotificationRule({ now, devices: [offline], events: [], notifications: [pending] })).toEqual([]);
    const [system] = systemNotificationDeliveryRule({ now, devices: [offline], notifications: [pending] });
    expect(system).toMatchObject({
      rule: "system.notification_delivery",
      chain: "system",
      severity: "warning",
      fingerprint: "system.notification_delivery:team",
    });
    expect(systemNotificationDeliveryRule({ now, devices: [device()], notifications: [pending] })).toEqual([]);
  });
});

describe("system.probe and system.worker", () => {
  it("flags a failed or very slow database probe", () => {
    expect(systemProbeRule({ databaseProbe: { ok: true, durationMs: 40 } })).toEqual([]);
    expect(systemProbeRule({ databaseProbe: { ok: false, durationMs: 40 } })[0]).toMatchObject({ severity: "critical", rule: "system.probe" });
    expect(systemProbeRule({ databaseProbe: { ok: true, durationMs: 6000 } })).toHaveLength(1);
  });

  it("applies the 90 s / 300 s heartbeat thresholds", () => {
    const worker = (seconds: number, status = "idle") => ({
      heartbeatAt: new Date(now.getTime() - seconds * 1000),
      status,
      errorCode: null,
    });
    expect(systemWorkerRule({ now, worker: worker(90) })).toEqual([]);
    expect(systemWorkerRule({ now, worker: worker(91) })[0]).toMatchObject({ severity: "warning" });
    expect(systemWorkerRule({ now, worker: worker(300) })[0]).toMatchObject({ severity: "warning" });
    expect(systemWorkerRule({ now, worker: worker(301) })[0]).toMatchObject({ severity: "critical" });
    expect(systemWorkerRule({ now, worker: worker(5, "error") })[0]).toMatchObject({ severity: "warning" });
    expect(systemWorkerRule({ now, worker: null })[0]).toMatchObject({ severity: "critical" });
  });
});

describe("system.queue", () => {
  it("reports expired leases as critical, old pending and retry-wait as warnings, with job ids", () => {
    const expired = job({ id: "j-expired", status: "LEASED", leaseUntil: minutesAgo(1) });
    const live = job({ id: "j-live", status: "LEASED", leaseUntil: new Date(now.getTime() + 60_000) });
    const old = job({ id: "j-old", status: "PENDING", createdAt: minutesAgo(61) });
    const young = job({ id: "j-young", status: "PENDING", createdAt: minutesAgo(59) });
    const retry = job({ id: "j-retry", status: "RETRY_WAIT", errorCode: "MODEL_RATE_LIMITED" });
    const findings = systemQueueRule({ now, jobs: [expired, live, old, young, retry] });
    const by = Object.fromEntries(findings.map((f) => [f.subject, f]));
    expect(by.expired_lease).toMatchObject({ severity: "critical" });
    expect(by.expired_lease!.evidence.jobIds).toEqual(["j-expired"]);
    expect(by.pending_backlog).toMatchObject({ severity: "warning" });
    expect(by.pending_backlog!.evidence.jobIds).toEqual(["j-old"]);
    expect(by.retry_wait).toMatchObject({ severity: "warning" });
    expect(by.retry_wait!.evidence.codes).toEqual(["MODEL_RATE_LIMITED"]);
  });

  it("ignores health-check jobs", () => {
    const health = job({ type: "SYSTEM_HEALTH_QUEUE", status: "RETRY_WAIT" });
    expect(systemQueueRule({ now, jobs: [health] })).toEqual([]);
  });
});

describe("job-based system rules", () => {
  it("reports each failed extraction and card job separately without error text", () => {
    const failed = job({ id: "a", status: "FAILED", errorCode: "MODEL_AUTH_FAILED", attemptCount: 3 });
    const other = job({ id: "b", status: "FAILED", type: "AGGREGATE_WORK_ITEMS", errorCode: "CENTRAL_GENERATION_FAILED" });
    const [extract] = systemSessionAnalysisRule({ jobs: [failed, other] });
    expect(extract).toMatchObject({ rule: "system.session_analysis", severity: "critical", subject: "job:a" });
    expect(extract!.evidence).toMatchObject({ jobIds: ["a"], executionId: "job:a", codes: ["MODEL_AUTH_FAILED"], partnerId: "partner-1" });
    const [card] = systemCardGenerationRule({ jobs: [failed, other] });
    expect(card).toMatchObject({ rule: "system.card_generation", subject: "job:b" });
    expect(systemSessionAnalysisRule({ jobs: [job({ status: "RETRY_WAIT" })] })).toEqual([]);
  });

  it("flags reports aggregating over an hour and failed report jobs", () => {
    const stuck = { id: "r1", status: "AGGREGATING", updatedAt: minutesAgo(61) };
    const fine = { id: "r2", status: "AGGREGATING", updatedAt: minutesAgo(59) };
    const locked = { id: "r3", status: "LOCKED", updatedAt: minutesAgo(600) };
    const failedJob = job({ id: "rep", type: "GENERATE_TEAM_REPORT", status: "FAILED", errorCode: "X" });
    const findings = systemReportRule({ now, jobs: [failedJob], teamReports: [stuck, fine, locked] });
    expect(findings.map((f) => f.subject).sort()).toEqual(["job:rep", "report:r1"]);
    expect(findings.every((f) => f.severity === "critical" && f.rule === "system.report")).toBe(true);
  });

  it("escalates repeated model errors at 2 and 5 jobs inside 30 minutes", () => {
    const make = (count: number, code = "MODEL_RATE_LIMITED", age = 5) =>
      Array.from({ length: count }, (_, i) =>
        job({ id: `m${i}`, status: i % 2 ? "FAILED" : "RETRY_WAIT", errorCode: code, updatedAt: minutesAgo(age) }),
      );
    expect(systemModelGatewayRule({ now, jobs: make(1) })).toEqual([]);
    expect(systemModelGatewayRule({ now, jobs: make(2) })[0]).toMatchObject({ severity: "warning", subject: "code:MODEL_RATE_LIMITED" });
    expect(systemModelGatewayRule({ now, jobs: make(4) })[0]!.severity).toBe("warning");
    expect(systemModelGatewayRule({ now, jobs: make(5) })[0]!.severity).toBe("critical");
    expect(systemModelGatewayRule({ now, jobs: make(5, "MODEL_RATE_LIMITED", 31) })).toEqual([]);
    expect(systemModelGatewayRule({ now, jobs: make(5, "CENTRAL_GENERATION_FAILED") })).toEqual([]);
  });
});

describe("pipeline rules", () => {
  it("flags uploads completed over 10 minutes ago whose analysis was never queued", () => {
    const stuck = upload({ analysisEnqueuedAt: null, completedAt: minutesAgo(11) });
    const [finding] = pipelineAnalysisNotQueuedRule({ now, uploads: [stuck] });
    expect(finding).toMatchObject({ rule: "pipeline.analysis_not_queued", severity: "critical", chain: "pipeline", subject: "upload:upload-1" });
    expect(finding!.evidence.uploadId).toBe("upload-1");
    expect(pipelineAnalysisNotQueuedRule({ now, uploads: [upload({ analysisEnqueuedAt: null, completedAt: minutesAgo(9) })] })).toEqual([]);
    expect(pipelineAnalysisNotQueuedRule({ now, uploads: [upload()] })).toEqual([]);
  });

  const member = (overrides = {}) => ({
    partnerId: "partner-1",
    partnerName: "小李",
    periodKey: "2026-W45",
    periodStatus: "open",
    uploadId: "upload-1",
    analysisJobStatuses: ["COMPLETED", "CANCELLED"],
    analysisFinishedAt: minutesAgo(11),
    currentFactCount: 4,
    hasAggregateJob: false,
    hasReview: false,
    ...overrides,
  });

  it("flags finished analysis without a card job after 10 minutes", () => {
    const [finding] = pipelineCardNotQueuedRule({ now, memberPeriods: [member()] });
    expect(finding).toMatchObject({ rule: "pipeline.card_not_queued", severity: "warning", subject: "member:partner-1:2026-W45" });
    expect(pipelineCardNotQueuedRule({ now, memberPeriods: [member({ hasAggregateJob: true })] })).toEqual([]);
    expect(pipelineCardNotQueuedRule({ now, memberPeriods: [member({ analysisJobStatuses: ["COMPLETED", "PENDING"] })] })).toEqual([]);
    expect(pipelineCardNotQueuedRule({ now, memberPeriods: [member({ analysisFinishedAt: minutesAgo(9) })] })).toEqual([]);
    expect(pipelineCardNotQueuedRule({ now, memberPeriods: [member({ currentFactCount: 0 })] })).toEqual([]);
  });

  it("flags a missing review row after analysis completes", () => {
    const [finding] = pipelineNoReviewRule({ now, memberPeriods: [member()] });
    expect(finding).toMatchObject({ rule: "pipeline.no_review", severity: "warning" });
    expect(pipelineNoReviewRule({ now, memberPeriods: [member({ hasReview: true })] })).toEqual([]);
    expect(pipelineNoReviewRule({ now, memberPeriods: [member({ periodStatus: "archived" })] })).toEqual([]);
  });
});

describe("evaluateInspection", () => {
  it("produces stable fingerprints across runs and no evidence leaks beyond the allowed keys", () => {
    const input = baseInput({
      devices: [device({ lastLogAt: minutesAgo(40) })],
      events: [event({ stage: "scan", level: "error", code: "SCAN_FAILED" })],
      jobs: [job({ id: "j1", status: "FAILED", errorCode: "MODEL_AUTH_FAILED" })],
    });
    const first = evaluateInspection(input);
    const second = evaluateInspection({ ...input, now: new Date(now.getTime() + 60_000) });
    expect(first.map((f) => f.fingerprint).sort()).toEqual(second.map((f) => f.fingerprint).sort());
    expect(first.map((f) => f.fingerprint)).toEqual(
      expect.arrayContaining([
        "app.heartbeat:device:dev-1",
        "app.scan:device:dev-1",
        "system.session_analysis:job:j1",
      ]),
    );
    const allowed = new Set(["eventIds", "codes", "counts", "timestamps", "jobIds", "uploadId", "deviceId", "executionId", "partnerId"]);
    for (const finding of first) {
      expect(Object.keys(finding.evidence).every((key) => allowed.has(key))).toBe(true);
      expect(finding.fingerprint).toBe(`${finding.rule}:${finding.subject}`);
      expect(finding.title).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("returns nothing for a healthy team and unique fingerprints otherwise", () => {
    expect(evaluateInspection(baseInput({ devices: [device()] }))).toEqual([]);
    const findings = evaluateInspection(
      baseInput({
        devices: [device({ lastLogAt: minutesAgo(40) }), device({ id: "dev-2", lastLogAt: minutesAgo(10) })],
      }),
    );
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
  });
});
