import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: text("status").notNull().default("active"),
    ...timestamps(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    reportType: text("report_type").notNull().default("weekly"),
    periodRule: jsonb("period_rule").notNull().default({
      frequency: "weekly",
      weekStartsOn: 1,
      factCutoffWeekday: 5,
      factCutoffTime: "14:00",
    }),
    evidenceExcerptEnabled: boolean("evidence_excerpt_enabled")
      .notNull()
      .default(false),
    evidenceExcerptMaxChars: integer("evidence_excerpt_max_chars")
      .notNull()
      .default(240),
    sessionQuietPeriodMinutes: integer("session_quiet_period_minutes")
      .notNull()
      .default(120),
    collectionGraceMinutes: integer("collection_grace_minutes")
      .notNull()
      .default(120),
    minimumPluginVersion: text("minimum_plugin_version")
      .notNull()
      .default("0.2.0"),
    centralModel: text("central_model")
      .notNull()
      .default("deepseek-v4-flash:cloud"),
    ...timestamps(),
  },
  (table) => [index("teams_tenant_idx").on(table.tenantId)],
);

export const partners = pgTable(
  "partners",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    userId: uuid("user_id").references(() => users.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    preferences: jsonb("preferences").notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    index("partners_tenant_team_idx").on(table.tenantId, table.teamId),
    uniqueIndex("partners_tenant_user_unique").on(table.tenantId, table.userId),
    uniqueIndex("partners_team_email_unique").on(
      table.tenantId,
      table.teamId,
      table.email,
    ),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    partnerId: uuid("partner_id").references(() => partners.id),
    roles: jsonb("roles").notNull().$type<string[]>(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("memberships_team_user_unique").on(
      table.tenantId,
      table.teamId,
      table.userId,
    ),
    index("memberships_user_idx").on(table.userId),
  ],
);

export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    externalSubject: text("external_subject").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("external_identity_unique").on(
      table.tenantId,
      table.provider,
      table.externalSubject,
    ),
  ],
);

export const feishuPartnerBindings = pgTable(
  "feishu_partner_bindings",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    appId: text("app_id").notNull(),
    openId: text("open_id"),
    unionId: text("union_id"),
    tenantKey: text("tenant_key"),
    status: text("status").notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("feishu_partner_bindings_partner_app_unique").on(
      table.tenantId,
      table.partnerId,
      table.appId,
    ),
    uniqueIndex("feishu_partner_bindings_app_open_unique").on(
      table.appId,
      table.openId,
    ),
    index("feishu_partner_bindings_team_status_idx").on(
      table.tenantId,
      table.teamId,
      table.status,
    ),
  ],
);

export const feishuInboxEvents = pgTable(
  "feishu_inbox_events",
  {
    id: uuid("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull().default("received"),
    sanitizedPayload: jsonb("sanitized_payload").notNull().default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("feishu_inbox_events_event_unique").on(table.eventId),
    index("feishu_inbox_events_status_received_idx").on(
      table.status,
      table.receivedAt,
    ),
  ],
);

export const feishuDeliveries = pgTable(
  "feishu_deliveries",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    kind: text("kind").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    receiveId: text("receive_id").notNull(),
    receiveIdType: text("receive_id_type").notNull(),
    messageId: text("message_id"),
    domainVersion: integer("domain_version"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("feishu_deliveries_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    uniqueIndex("feishu_deliveries_message_unique").on(table.messageId),
    index("feishu_deliveries_retry_idx").on(table.status, table.nextRetryAt),
    index("feishu_deliveries_aggregate_idx").on(
      table.tenantId,
      table.aggregateType,
      table.aggregateId,
    ),
  ],
);

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("web_sessions_token_unique").on(table.tokenHash),
    index("web_sessions_user_idx").on(table.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    email: text("email").notNull(),
    roles: jsonb("roles").notNull().$type<string[]>(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("invitations_token_unique").on(table.tokenHash)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    name: text("name").notNull(),
    aliases: jsonb("aliases").notNull().$type<string[]>(),
    allowedPaths: jsonb("allowed_paths").notNull().$type<string[]>(),
    externalIds: jsonb("external_ids").notNull().$type<string[]>(),
    status: text("status").notNull().default("active"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("projects_team_name_unique").on(
      table.tenantId,
      table.teamId,
      table.name,
    ),
  ],
);

export const reportTemplates = pgTable("report_templates", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  sections: jsonb("sections").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps(),
});

export const reportPeriods = pgTable(
  "report_periods",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    periodKey: text("period_key").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    submissionDeadlineAt: timestamp("submission_deadline_at", {
      withTimezone: true,
    }).notNull(),
    factsFrozenAt: timestamp("facts_frozen_at", { withTimezone: true }),
    timezone: text("timezone").notNull(),
    status: text("status").notNull().default("open"),
    templateId: uuid("template_id").references(() => reportTemplates.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("report_period_team_key_unique").on(
      table.tenantId,
      table.teamId,
      table.periodKey,
    ),
  ],
);

export const deviceAuthorizations = pgTable(
  "plugin_device_authorizations",
  {
    id: uuid("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCode: text("user_code").notNull(),
    deviceName: text("device_name").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    teamId: uuid("team_id").references(() => teams.id),
    partnerId: uuid("partner_id").references(() => partners.id),
    pluginInstanceId: uuid("plugin_instance_id"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("device_authorization_code_unique").on(table.deviceCodeHash),
    uniqueIndex("device_authorization_user_code_unique").on(table.userCode),
    index("device_authorization_plugin_instance_idx").on(
      table.pluginInstanceId,
      table.status,
    ),
  ],
);

export const pluginInstances = pgTable(
  "plugin_instances",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    deviceName: text("device_name").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("active"),
    accessTokenHash: text("access_token_hash").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true,
    }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastHookAt: timestamp("last_hook_at", { withTimezone: true }),
    lastRunnerAt: timestamp("last_runner_at", { withTimezone: true }),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    runnerState: text("runner_state").notNull().default("unknown"),
    dirtySessions: integer("dirty_sessions").notNull().default(0),
    extractingSessions: integer("extracting_sessions").notNull().default(0),
    pendingLocalJobs: integer("pending_local_jobs").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastCollectionStartedAt: timestamp("last_collection_started_at", {
      withTimezone: true,
    }),
    lastCollectionCompletedAt: timestamp("last_collection_completed_at", {
      withTimezone: true,
    }),
    lastCollectionPeriodKey: text("last_collection_period_key"),
    lastCollectionSessionCount: integer("last_collection_session_count")
      .notNull()
      .default(0),
    lastCollectionFactCount: integer("last_collection_fact_count")
      .notNull()
      .default(0),
    connectivityStatus: text("connectivity_status")
      .notNull()
      .default("pending"),
    connectivityVerifiedAt: timestamp("connectivity_verified_at", {
      withTimezone: true,
    }),
    lastConnectivityAttemptAt: timestamp("last_connectivity_attempt_at", {
      withTimezone: true,
    }),
    lastConnectivityErrorCode: text("last_connectivity_error_code"),
    lastConnectivityErrorAt: timestamp("last_connectivity_error_at", {
      withTimezone: true,
    }),
    lastConnectivityRequestId: text("last_connectivity_request_id"),
    connectivityChallengeHash: text("connectivity_challenge_hash"),
    connectivityChallengeExpiresAt: timestamp(
      "connectivity_challenge_expires_at",
      { withTimezone: true },
    ),
    connectivityChallengeConsumedAt: timestamp(
      "connectivity_challenge_consumed_at",
      { withTimezone: true },
    ),
    ...timestamps(),
  },
  (table) => [
    index("plugin_instances_partner_idx").on(table.tenantId, table.partnerId),
  ],
);

export const projectScopePolicies = pgTable(
  "project_scope_policies",
  {
    pluginInstanceId: uuid("plugin_instance_id")
      .primaryKey()
      .references(() => pluginInstances.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    version: integer("version").notNull().default(1),
    initialized: boolean("initialized").notNull().default(false),
    initializedAt: timestamp("initialized_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index("project_scope_policies_partner_idx").on(
      table.tenantId,
      table.partnerId,
    ),
  ],
);

export const projectScopeEntries = pgTable(
  "project_scope_entries",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    pluginInstanceId: uuid("plugin_instance_id")
      .notNull()
      .references(() => pluginInstances.id),
    scopeKey: text("scope_key").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("pending"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    firstSeenPeriodKey: text("first_seen_period_key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionCount: integer("session_count").notNull().default(0),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("project_scope_entries_instance_key_unique").on(
      table.pluginInstanceId,
      table.scopeKey,
    ),
    index("project_scope_entries_pending_idx").on(
      table.tenantId,
      table.partnerId,
      table.status,
    ),
  ],
);

export const pluginDiagnosticEvents = pgTable(
  "plugin_diagnostic_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    pluginInstanceId: uuid("plugin_instance_id")
      .notNull()
      .references(() => pluginInstances.id),
    stage: text("stage").notNull(),
    errorCode: text("error_code").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    retryable: boolean("retryable").notNull(),
    requestId: text("request_id"),
    safeMessage: text("safe_message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("plugin_diagnostic_events_instance_event_unique").on(
      table.pluginInstanceId,
      table.id,
    ),
    index("plugin_diagnostic_events_recent_idx").on(
      table.tenantId,
      table.pluginInstanceId,
      table.occurredAt,
    ),
  ],
);

export const pluginBindingCodes = pgTable(
  "plugin_binding_codes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    codeHash: text("code_hash").notNull(),
    codeValue: text("code_value"),
    codePrefix: text("code_prefix").notNull(),
    label: text("label").notNull().default("Codex Plugin"),
    status: text("status").notNull().default("active"),
    pluginInstanceId: uuid("plugin_instance_id").references(
      () => pluginInstances.id,
    ),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("plugin_binding_codes_hash_unique").on(table.codeHash),
    index("plugin_binding_codes_partner_idx").on(
      table.tenantId,
      table.partnerId,
    ),
  ],
);

export const collectionRuns = pgTable(
  "collection_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    pluginInstanceId: uuid("plugin_instance_id")
      .notNull()
      .references(() => pluginInstances.id),
    periodId: uuid("period_id").references(() => reportPeriods.id),
    externalRunId: uuid("external_run_id").notNull(),
    status: text("status").notNull().default("STARTED"),
    windowStartsAt: timestamp("window_starts_at", {
      withTimezone: true,
    }).notNull(),
    windowEndsAt: timestamp("window_ends_at", {
      withTimezone: true,
    }).notNull(),
    initialLookback: boolean("initial_lookback").notNull().default(false),
    discoveredCount: integer("discovered_count").notNull().default(0),
    eligibleCount: integer("eligible_count").notNull().default(0),
    deferredCount: integer("deferred_count").notNull().default(0),
    excludedCount: integer("excluded_count").notNull().default(0),
    syncedSessionCount: integer("synced_session_count").notNull().default(0),
    syncedFactCount: integer("synced_fact_count").notNull().default(0),
    pendingLocalJobs: integer("pending_local_jobs").notNull().default(0),
    continuationCount: integer("continuation_count").notNull().default(0),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("collection_runs_instance_external_unique").on(
      table.pluginInstanceId,
      table.externalRunId,
    ),
    index("collection_runs_period_status_idx").on(
      table.tenantId,
      table.periodId,
      table.status,
    ),
  ],
);

export const syncBatches = pgTable(
  "sync_batches",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    pluginInstanceId: uuid("plugin_instance_id")
      .notNull()
      .references(() => pluginInstances.id),
    collectionRunId: uuid("collection_run_id").references(
      () => collectionRuns.id,
    ),
    externalBatchId: text("external_batch_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    accepted: integer("accepted").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sync_batches_idempotency_unique").on(
      table.tenantId,
      table.pluginInstanceId,
      table.idempotencyKey,
    ),
  ],
);

export const sessionRecords = pgTable(
  "session_records",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodId: uuid("period_id").references(() => reportPeriods.id),
    collectionRunId: uuid("collection_run_id").references(
      () => collectionRuns.id,
    ),
    sessionId: text("session_id").notNull(),
    latestSourceRevision: integer("latest_source_revision").notNull(),
    sourceHash: text("source_hash").notNull(),
    status: text("status").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceOccurredAt: timestamp("source_occurred_at", { withTimezone: true }),
    lateFromPeriodKey: text("late_from_period_key"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("session_record_partner_session_unique").on(
      table.tenantId,
      table.partnerId,
      table.sessionId,
    ),
    index("session_records_coverage_idx").on(
      table.tenantId,
      table.partnerId,
      table.periodId,
      table.status,
    ),
  ],
);

export const sessionFacts = pgTable(
  "session_facts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodId: uuid("period_id").references(() => reportPeriods.id),
    collectionRunId: uuid("collection_run_id").references(
      () => collectionRuns.id,
    ),
    sessionId: text("session_id").notNull(),
    externalFactId: text("external_fact_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceOccurredAt: timestamp("source_occurred_at", { withTimezone: true }),
    lateFromPeriodKey: text("late_from_period_key"),
    payload: jsonb("payload").notNull(),
    current: boolean("current").notNull().default(true),
    excluded: boolean("excluded").notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("session_fact_current_unique").on(
      table.tenantId,
      table.partnerId,
      table.sessionId,
      table.externalFactId,
    ),
    index("session_facts_period_idx").on(
      table.tenantId,
      table.partnerId,
      table.periodId,
    ),
  ],
);

export const coverageSnapshots = pgTable("coverage_snapshots", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  partnerId: uuid("partner_id")
    .notNull()
    .references(() => partners.id),
  periodId: uuid("period_id")
    .notNull()
    .references(() => reportPeriods.id),
  payload: jsonb("payload").notNull(),
  immutable: boolean("immutable").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const factSnapshots = pgTable(
  "fact_snapshots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodId: uuid("period_id")
      .notNull()
      .references(() => reportPeriods.id),
    factIds: jsonb("fact_ids").notNull().$type<string[]>(),
    checksum: text("checksum").notNull(),
    coverage: jsonb("coverage").notNull().default({}),
    frozenAt: timestamp("frozen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("fact_snapshots_partner_period_unique").on(
      table.tenantId,
      table.partnerId,
      table.periodId,
    ),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodId: uuid("period_id")
      .notNull()
      .references(() => reportPeriods.id),
    state: text("state").notNull().default("PENDING"),
    version: integer("version").notNull().default(1),
    approvedCount: integer("approved_count").notNull().default(0),
    excludedCount: integer("excluded_count").notNull().default(0),
    pendingCount: integer("pending_count").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("review_partner_period_unique").on(
      table.tenantId,
      table.partnerId,
      table.periodId,
    ),
  ],
);

export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodId: uuid("period_id")
      .notNull()
      .references(() => reportPeriods.id),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id),
    projectId: uuid("project_id").references(() => projects.id),
    title: text("title").notNull(),
    status: text("status").notNull(),
    reviewStatus: text("review_status").notNull().default("pending"),
    factIds: jsonb("fact_ids").notNull().$type<string[]>(),
    payload: jsonb("payload").notNull(),
    lineage: jsonb("lineage").notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    index("work_items_review_idx").on(table.tenantId, table.reviewId),
  ],
);

export const workItemFacts = pgTable(
  "work_item_facts",
  {
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id),
    factId: uuid("fact_id")
      .notNull()
      .references(() => sessionFacts.id),
  },
  (table) => [primaryKey({ columns: [table.workItemId, table.factId] })],
);

export const reviewChanges = pgTable(
  "review_changes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    operation: text("operation").notNull(),
    source: text("source").notNull(),
    baseVersion: integer("base_version").notNull(),
    beforePayload: jsonb("before_payload").notNull(),
    afterPayload: jsonb("after_payload").notNull(),
    status: text("status").notNull().default("preview"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("review_changes_review_idx").on(table.tenantId, table.reviewId),
  ],
);

export const workItemSnapshots = pgTable("work_item_snapshots", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  partnerId: uuid("partner_id")
    .notNull()
    .references(() => partners.id),
  periodId: uuid("period_id")
    .notNull()
    .references(() => reportPeriods.id),
  reviewId: uuid("review_id")
    .notNull()
    .references(() => reviews.id),
  reviewVersion: integer("review_version").notNull(),
  checksum: text("checksum").notNull(),
  payload: jsonb("payload").notNull(),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedByActorType: text("approved_by_actor_type"),
  approvedByActorId: text("approved_by_actor_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id").references(() => partners.id),
    pluginInstanceId: uuid("plugin_instance_id").references(
      () => pluginInstances.id,
    ),
    type: text("type").notNull(),
    status: text("status").notNull().default("PENDING"),
    idempotencyKey: text("idempotency_key").notNull(),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    leaseTokenHash: text("lease_token_hash"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("agent_jobs_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("agent_jobs_pending_idx").on(
      table.tenantId,
      table.partnerId,
      table.status,
    ),
  ],
);

export const individualReports = pgTable(
  "individual_reports",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    periodId: uuid("period_id")
      .notNull()
      .references(() => reportPeriods.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => workItemSnapshots.id),
    status: text("status").notNull().default("REPORT_DRAFT"),
    contentRevision: integer("content_revision").notNull().default(0),
    title: text("title"),
    summary: text("summary"),
    markdown: text("markdown"),
    payload: jsonb("payload"),
    preferences: jsonb("preferences").notNull().default({}),
    sourceChecksum: text("source_checksum"),
    generatorVersion: text("generator_version"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("individual_reports_partner_period_unique").on(
      table.tenantId,
      table.partnerId,
      table.periodId,
    ),
  ],
);

export const teamReports = pgTable(
  "team_reports",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    periodId: uuid("period_id")
      .notNull()
      .references(() => reportPeriods.id),
    status: text("status").notNull().default("WAITING_SUBMISSIONS"),
    currentVersion: integer("current_version").notNull().default(0),
    missingPartnerIds: jsonb("missing_partner_ids")
      .notNull()
      .$type<string[]>()
      .default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("team_reports_team_period_unique").on(
      table.tenantId,
      table.teamId,
      table.periodId,
    ),
  ],
);

export const teamReportVersions = pgTable(
  "team_report_versions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    reportId: uuid("report_id")
      .notNull()
      .references(() => teamReports.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    markdown: text("markdown").notNull(),
    payload: jsonb("payload").notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    generatorVersion: text("generator_version").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("team_report_version_unique").on(table.reportId, table.version),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    teamId: uuid("team_id").references(() => teams.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    requestId: text("request_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("outbox_unpublished_idx").on(table.publishedAt, table.createdAt),
  ],
);
