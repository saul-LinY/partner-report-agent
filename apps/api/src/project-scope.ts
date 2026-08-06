import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlClient as defaultDatabase } from "@partner-report/db";
import { ApiError, type DomainActor } from "./common.js";

type Database = typeof defaultDatabase;

export const projectScopeCandidateBatchSchema = z
  .object({
    periodKey: z.string().trim().min(1).max(120),
    candidates: z
      .array(
        z
          .object({
            scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
            displayName: z.string().trim().min(1).max(120),
            sessionCount: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const projectScopeDecisionSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    decisions: z
      .array(
        z
          .object({
            scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
            decision: z.enum(["allow", "deny"]),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export const projectScopeBootstrapSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    reason: z.enum(["local_scope_missing", "local_scope_invalid"]),
  })
  .strict();

export const projectScopeCardStatusSchema = z
  .object({
    periodKey: z.string().trim().min(1).max(120),
    version: z.coerce.number().int().positive(),
  })
  .strict();

type ScopeIdentity = {
  tenantId: string;
  teamId: string;
  partnerId: string;
  pluginInstanceId: string;
};

type PolicyRow = {
  version: number;
  initialized: boolean;
  initialized_at: Date | string | null;
};

export type ProjectScopeEntryView = {
  scopeKey: string;
  displayName: string;
  status: "pending" | "allowed" | "denied";
  effectiveFrom: string | null;
  firstSeenPeriodKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionCount: number;
};

export type ProjectScopePolicyView = {
  pluginInstanceId: string;
  identityConfirmed: boolean;
  version: number;
  initialized: boolean;
  initializedAt: string | null;
  currentPeriod: {
    periodKey: string;
    startsAt: string;
    endsAt: string;
  } | null;
  entries: ProjectScopeEntryView[];
};

async function projectScopeIdentityConfirmed(
  identity: ScopeIdentity,
  database: Database,
) {
  const rows = await database<Array<{ confirmed: boolean }>>`
    select exists (
      select 1 from feishu_partner_bindings
      where tenant_id = ${identity.tenantId} and team_id = ${identity.teamId}
        and partner_id = ${identity.partnerId} and status = 'active'
        and open_id is not null
    ) as confirmed
  `;
  return rows[0]?.confirmed === true;
}

export function projectScopeEffectiveFrom(input: {
  decision: "allow" | "deny";
  policyInitializedAt: Date | null;
  entryFirstSeenAt: Date;
  wasPending: boolean;
  nextPeriodStart: Date;
  now: Date;
}) {
  const belongsToInitialBatch =
    input.policyInitializedAt === null ||
    input.entryFirstSeenAt.getTime() <= input.policyInitializedAt.getTime();
  return input.decision === "deny" || belongsToInitialBatch || !input.wasPending
    ? input.now
    : input.nextPeriodStart;
}

async function ensurePolicy(database: any, identity: ScopeIdentity) {
  await database`
    insert into project_scope_policies (
      plugin_instance_id, tenant_id, team_id, partner_id, version, initialized
    ) values (
      ${identity.pluginInstanceId}, ${identity.tenantId}, ${identity.teamId},
      ${identity.partnerId}, 1, false
    )
    on conflict (plugin_instance_id) do nothing
  `;
}

export async function loadProjectScopePolicy(
  identity: ScopeIdentity,
  database: Database = defaultDatabase,
): Promise<ProjectScopePolicyView> {
  await ensurePolicy(database, identity);
  const [policies, entries, periods, identityConfirmed] = await Promise.all([
    database<PolicyRow[]>`
      select version, initialized, initialized_at
      from project_scope_policies
      where plugin_instance_id = ${identity.pluginInstanceId}
        and tenant_id = ${identity.tenantId}
        and team_id = ${identity.teamId}
        and partner_id = ${identity.partnerId}
      limit 1
    `,
    database<any[]>`
      select scope_key, display_name, status, effective_from,
        first_seen_period_key, first_seen_at, last_seen_at, session_count
      from project_scope_entries
      where plugin_instance_id = ${identity.pluginInstanceId}
        and tenant_id = ${identity.tenantId}
      order by first_seen_at asc, display_name asc
    `,
    database<any[]>`
      select period_key, starts_at, ends_at from report_periods
      where tenant_id = ${identity.tenantId} and team_id = ${identity.teamId}
        and status = 'open' and starts_at <= now() and ends_at >= now()
      order by starts_at desc limit 1
    `,
    projectScopeIdentityConfirmed(identity, database),
  ]);
  const policy = policies[0]!;
  const period = periods[0];
  return {
    pluginInstanceId: identity.pluginInstanceId,
    identityConfirmed,
    version: policy.version,
    initialized: policy.initialized,
    initializedAt: policy.initialized_at
      ? new Date(policy.initialized_at).toISOString()
      : null,
    currentPeriod: period
      ? {
          periodKey: period.period_key,
          startsAt: new Date(period.starts_at).toISOString(),
          endsAt: new Date(period.ends_at).toISOString(),
        }
      : null,
    entries: entries.map((entry) => ({
      scopeKey: entry.scope_key,
      displayName: entry.display_name,
      status: entry.status,
      effectiveFrom: entry.effective_from
        ? new Date(entry.effective_from).toISOString()
        : null,
      firstSeenPeriodKey: entry.first_seen_period_key,
      firstSeenAt: new Date(entry.first_seen_at).toISOString(),
      lastSeenAt: new Date(entry.last_seen_at).toISOString(),
      sessionCount: entry.session_count,
    })),
  };
}

export async function loadProjectScopeCardDeliveryStatus(
  identity: ScopeIdentity,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  const input = projectScopeCardStatusSchema.parse(rawInput);
  const aggregateId = `${identity.pluginInstanceId}:${input.periodKey}`;
  const rows = await database<
    Array<{ status: string; domain_version: number | null }>
  >`
    select status, domain_version from feishu_deliveries
    where tenant_id = ${identity.tenantId} and team_id = ${identity.teamId}
      and partner_id = ${identity.partnerId} and kind = 'scope'
      and aggregate_type = 'project_scope' and aggregate_id = ${aggregateId}
    order by updated_at desc limit 1
  `;
  const delivery = rows[0];
  const sent =
    Boolean(delivery) &&
    ["sent", "confirmed"].includes(delivery!.status) &&
    (delivery!.domain_version ?? 0) >= input.version;
  return {
    status: sent ? ("sent" as const) : ("pending" as const),
    policyVersion: input.version,
    retryAfterSeconds: sent ? 0 : 3,
  };
}

export async function registerProjectScopeCandidates(
  identity: ScopeIdentity,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  const input = projectScopeCandidateBatchSchema.parse(rawInput);
  if (!(await projectScopeIdentityConfirmed(identity, database)))
    throw new ApiError(
      428,
      "FEISHU_IDENTITY_CONFIRMATION_REQUIRED",
      "请先在飞书中确认审核身份。",
    );
  if (input.candidates.length === 0)
    return loadProjectScopePolicy(identity, database);

  await database.begin(async (tx) => {
    await ensurePolicy(tx, identity);
    const existing = await tx<Array<{ scope_key: string }>>`
      select scope_key from project_scope_entries
      where plugin_instance_id = ${identity.pluginInstanceId}
        and scope_key in ${tx(input.candidates.map((item) => item.scopeKey))}
    `;
    const existingKeys = new Set(existing.map((item) => item.scope_key));
    const newCandidates = input.candidates.filter(
      (candidate) => !existingKeys.has(candidate.scopeKey),
    );

    for (const candidate of input.candidates) {
      await tx`
        insert into project_scope_entries (
          id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
          display_name, status, first_seen_period_key, session_count
        ) values (
          ${randomUUID()}, ${identity.tenantId}, ${identity.teamId},
          ${identity.partnerId}, ${identity.pluginInstanceId},
          ${candidate.scopeKey}, ${candidate.displayName}, 'pending',
          ${input.periodKey}, ${candidate.sessionCount}
        )
        on conflict (plugin_instance_id, scope_key) do update set
          display_name = excluded.display_name,
          session_count = greatest(project_scope_entries.session_count, excluded.session_count),
          last_seen_at = now(), updated_at = now()
      `;
    }

    if (newCandidates.length > 0) {
      const versions = await tx<Array<{ version: number }>>`
        update project_scope_policies set version = version + 1, updated_at = now()
        where plugin_instance_id = ${identity.pluginInstanceId}
        returning version
      `;
      await tx`
        insert into outbox_events (
          id, tenant_id, event_type, aggregate_type, aggregate_id, payload
        ) values (
          ${randomUUID()}, ${identity.tenantId}, 'project_scope.candidates.changed',
          'plugin_instance', ${identity.pluginInstanceId},
          ${JSON.stringify({
            teamId: identity.teamId,
            partnerId: identity.partnerId,
            pluginInstanceId: identity.pluginInstanceId,
            periodKey: input.periodKey,
            version: versions[0]?.version,
          })}::jsonb
        )
      `;
    }
  });
  return loadProjectScopePolicy(identity, database);
}

export async function beginProjectScopeBootstrap(
  identity: ScopeIdentity,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  const input = projectScopeBootstrapSchema.parse(rawInput);
  if (!(await projectScopeIdentityConfirmed(identity, database)))
    throw new ApiError(
      428,
      "FEISHU_IDENTITY_CONFIRMATION_REQUIRED",
      "请先在飞书中确认审核身份。",
    );

  await database.begin(async (tx) => {
    await ensurePolicy(tx, identity);
    const policies = await tx<PolicyRow[]>`
      select version, initialized, initialized_at
      from project_scope_policies
      where plugin_instance_id = ${identity.pluginInstanceId}
        and tenant_id = ${identity.tenantId} and team_id = ${identity.teamId}
        and partner_id = ${identity.partnerId}
      for update
    `;
    const policy = policies[0];
    if (!policy)
      throw new ApiError(404, "PROJECT_SCOPE_NOT_FOUND", "采集权限不存在。");
    if (policy.version !== input.baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "权限已更新，请重新发起采集。",
        { currentVersion: policy.version },
      );

    const entries = await tx<Array<{ count: number }>>`
      select count(*)::int as count from project_scope_entries
      where plugin_instance_id = ${identity.pluginInstanceId}
        and tenant_id = ${identity.tenantId}
    `;
    if (!policy.initialized && (entries[0]?.count ?? 0) === 0) return;

    await tx`
      delete from project_scope_entries
      where plugin_instance_id = ${identity.pluginInstanceId}
        and tenant_id = ${identity.tenantId}
    `;
    await tx`
      update project_scope_policies set
        version = version + 1, initialized = false, initialized_at = null,
        updated_at = now()
      where plugin_instance_id = ${identity.pluginInstanceId}
        and tenant_id = ${identity.tenantId}
    `;
  });

  return loadProjectScopePolicy(identity, database);
}

export async function decideProjectScopes(
  actor: DomainActor,
  pluginInstanceId: string,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  if (!actor.partnerId)
    throw new ApiError(403, "PARTNER_REQUIRED", "当前身份没有项目采集权限。");
  const input = projectScopeDecisionSchema.parse(rawInput);
  const identity: ScopeIdentity = {
    tenantId: actor.tenantId,
    teamId: actor.teamId,
    partnerId: actor.partnerId,
    pluginInstanceId,
  };
  const owned = await database<Array<{ id: string }>>`
    select id from plugin_instances
    where id = ${pluginInstanceId} and tenant_id = ${actor.tenantId}
      and team_id = ${actor.teamId} and partner_id = ${actor.partnerId}
      and status = 'active'
    limit 1
  `;
  if (!owned[0])
    throw new ApiError(404, "PROJECT_SCOPE_NOT_FOUND", "采集权限不存在。");

  await database.begin(async (tx) => {
    await ensurePolicy(tx, identity);
    const policies = await tx<PolicyRow[]>`
      select version, initialized, initialized_at
      from project_scope_policies
      where plugin_instance_id = ${pluginInstanceId}
        and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and partner_id = ${actor.partnerId}
      for update
    `;
    const policy = policies[0];
    if (!policy)
      throw new ApiError(404, "PROJECT_SCOPE_NOT_FOUND", "采集权限不存在。");
    if (policy.version !== input.baseVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "权限已更新，请刷新后重试。",
        {
          currentVersion: policy.version,
        },
      );

    const keys = [...new Set(input.decisions.map((item) => item.scopeKey))];
    if (keys.length !== input.decisions.length)
      throw new ApiError(400, "DUPLICATE_SCOPE", "同一项目不能重复审批。");
    const entries = await tx<
      Array<{
        scope_key: string;
        status: string;
        first_seen_at: Date | string;
      }>
    >`
      select scope_key, status, first_seen_at from project_scope_entries
      where plugin_instance_id = ${pluginInstanceId}
        and tenant_id = ${actor.tenantId} and scope_key in ${tx(keys)}
      for update
    `;
    if (entries.length !== keys.length)
      throw new ApiError(
        404,
        "PROJECT_SCOPE_NOT_FOUND",
        "部分项目权限不存在。",
      );
    const previousEntries = new Map(
      entries.map((entry) => [entry.scope_key, entry]),
    );
    const periods = await tx<Array<{ ends_at: Date }>>`
      select ends_at from report_periods
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'open' and starts_at <= now() and ends_at >= now()
      order by starts_at desc limit 1
    `;
    const nextPeriodStart = periods[0]?.ends_at
      ? new Date(periods[0].ends_at)
      : new Date();

    for (const item of input.decisions) {
      const previous = previousEntries.get(item.scopeKey)!;
      const wasPending = previous.status === "pending";
      const effectiveFrom = projectScopeEffectiveFrom({
        decision: item.decision,
        policyInitializedAt: policy.initialized_at
          ? new Date(policy.initialized_at)
          : null,
        entryFirstSeenAt: new Date(previous.first_seen_at),
        wasPending,
        nextPeriodStart,
        now: new Date(),
      });
      await tx`
        update project_scope_entries set
          status = ${item.decision === "allow" ? "allowed" : "denied"},
          effective_from = ${effectiveFrom.toISOString()}, decided_at = now(),
          updated_at = now()
        where plugin_instance_id = ${pluginInstanceId}
          and scope_key = ${item.scopeKey}
      `;
    }
    await tx`
      update project_scope_policies set
        version = version + 1, initialized = true,
        initialized_at = coalesce(initialized_at, now()), updated_at = now()
      where plugin_instance_id = ${pluginInstanceId}
    `;
  });

  return loadProjectScopePolicy(identity, database);
}
