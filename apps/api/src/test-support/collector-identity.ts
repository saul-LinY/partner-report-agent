import { randomUUID } from "node:crypto";
import { sqlClient as sql } from "@partner-report/db";
import type { ScopeIdentity } from "../project-scope.js";

export async function confirmCollectorIdentity(identity: ScopeIdentity) {
  const user = randomUUID(),
    binding = randomUUID();
  await sql`insert into users (id,email,display_name,password_hash) values (${user},${`scope-collector-${user}@test.local`},'Test collector creator','test-only')`;
  await sql`insert into plugin_binding_codes (id,tenant_id,team_id,partner_id,code_hash,code_prefix,created_by,plugin_instance_id)
    values (${binding},${identity.tenantId},${identity.teamId},${identity.partnerId},${randomUUID()},'TEST',${user},${identity.pluginInstanceId})`;
  await sql`insert into collector_devices (id,tenant_id,team_id,partner_id,scope_instance_id,binding_code_id,device_name,version,token_hash)
    values (${randomUUID()},${identity.tenantId},${identity.teamId},${identity.partnerId},${identity.pluginInstanceId},${binding},'Test App','0.2.1',${randomUUID()})`;
}

export async function removeCollectorIdentities(tenantId: string) {
  const users =
    await sql`select distinct created_by from plugin_binding_codes where tenant_id=${tenantId}`;
  await sql`delete from app_notifications where tenant_id=${tenantId}`;
  await sql`delete from collector_devices where tenant_id=${tenantId}`;
  await sql`delete from plugin_binding_codes where tenant_id=${tenantId}`;
  for (const user of users)
    await sql`delete from users where id=${user.created_by} and email like 'scope-collector-%@test.local'`;
}
