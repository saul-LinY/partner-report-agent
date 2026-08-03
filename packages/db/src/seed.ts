import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { closeDatabase, sqlClient as sql } from "./index.js";
import { weeklyPeriodAt } from "./period.js";

const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@local.test").trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "ChangeMe-Partner-Report-2026!";
const displayName = process.env.BOOTSTRAP_DISPLAY_NAME ?? "Saul";
const teamName = process.env.BOOTSTRAP_TEAM_NAME ?? "Partner Report Pilot";
const minimumPluginVersion = process.env.PLUGIN_MIN_VERSION ?? "0.2.0";
const timezone = process.env.BOOTSTRAP_TIMEZONE ?? "Asia/Shanghai";

const existing = await sql<{ user_id: string; tenant_id: string; team_id: string }[]>`
  select u.id as user_id, m.tenant_id, m.team_id
  from users u join memberships m on m.user_id = u.id
  where u.email = ${email} limit 1
`;

const { periodKey, startsAt, endsAt } = weeklyPeriodAt(new Date(), timezone);

if (existing.length === 0) {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const userId = randomUUID();
  const partnerId = randomUUID();
  const membershipId = randomUUID();
  const identityId = randomUUID();
  const templateId = randomUUID();
  const periodId = randomUUID();
  const projectId = randomUUID();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await sql.begin(async (tx) => {
    await tx`insert into tenants (id, name) values (${tenantId}, ${teamName})`;
    await tx`
      insert into users (id, email, display_name, password_hash)
      values (${userId}, ${email}, ${displayName}, ${passwordHash})
    `;
    await tx`
      insert into teams (id, tenant_id, name, timezone, minimum_plugin_version)
      values (${teamId}, ${tenantId}, ${teamName}, ${timezone}, ${minimumPluginVersion})
    `;
    await tx`
      insert into partners (id, tenant_id, team_id, user_id, email, display_name)
      values (${partnerId}, ${tenantId}, ${teamId}, ${userId}, ${email}, ${displayName})
    `;
    await tx`
      insert into memberships (id, tenant_id, team_id, user_id, partner_id, roles)
      values (${membershipId}, ${tenantId}, ${teamId}, ${userId}, ${partnerId}, ${JSON.stringify(["admin", "partner"])}::jsonb)
    `;
    await tx`
      insert into external_identities (id, tenant_id, user_id, provider, external_subject)
      values (${identityId}, ${tenantId}, ${userId}, 'local', ${email})
    `;
    await tx`
      insert into report_templates (id, tenant_id, team_id, name, sections, is_default)
      values (
        ${templateId}, ${tenantId}, ${teamId}, '默认个人周报',
        ${JSON.stringify(["本期摘要", "关键成果", "项目进展", "风险与阻塞", "下一期重点", "需协调事项", "数据覆盖"])}::jsonb,
        true
      )
    `;
    await tx`
      insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, timezone, template_id)
      values (${periodId}, ${tenantId}, ${teamId}, ${periodKey}, ${startsAt.toISOString()}, ${endsAt.toISOString()}, ${endsAt.toISOString()}, ${timezone}, ${templateId})
    `;
    await tx`
      insert into projects (id, tenant_id, team_id, name, aliases, allowed_paths, external_ids)
      values (${projectId}, ${tenantId}, ${teamId}, 'Partner Report Agent', ${JSON.stringify(["partner-report", "report-agent"])}::jsonb, ${JSON.stringify([process.cwd()])}::jsonb, '[]'::jsonb)
    `;
  });

  console.log(`Seeded ${email} as Admin + Partner for ${teamName}.`);
} else {
  const account = existing[0]!;
  await sql`
    update report_periods set starts_at = ${startsAt.toISOString()}, ends_at = ${endsAt.toISOString()},
      cutoff_at = ${endsAt.toISOString()}, timezone = ${timezone}, updated_at = now()
    where tenant_id = ${account.tenant_id} and team_id = ${account.team_id}
      and period_key = ${periodKey} and status = 'open'
  `;
  console.log(`Seed verified ${email}; corrected ${periodKey} for ${timezone}.`);
}

await closeDatabase();
