import { randomUUID } from "node:crypto";
import { z } from "zod";
import { projectDescriptionCandidateSchema } from "@partner-report/contracts";
import { sqlClient as defaultDatabase } from "@partner-report/db";
import { ApiError } from "./common.js";
import { resolveProjectIdentity } from "./project-discovery.js";

type Database = typeof defaultDatabase;

type PluginIdentity = {
  tenantId: string;
  teamId: string;
  partnerId: string;
  pluginInstanceId: string;
};

const projectDescriptionStateSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
            rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

function pathExternalId(rootFingerprint: string) {
  return `path-sha256:${rootFingerprint}`;
}

async function allowedScope(
  database: any,
  identity: PluginIdentity,
  scopeKey: string,
) {
  const rows = await database<Array<{ display_name: string }>>`
    select display_name from project_scope_entries
    where plugin_instance_id = ${identity.pluginInstanceId}
      and tenant_id = ${identity.tenantId} and team_id = ${identity.teamId}
      and partner_id = ${identity.partnerId} and scope_key = ${scopeKey}
      and status = 'allowed' and effective_from <= now()
    limit 1
  `;
  return rows[0] ?? null;
}

export async function loadProjectDescriptionState(
  identity: PluginIdentity,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  const input = projectDescriptionStateSchema.parse(rawInput);
  const projects = [];
  for (const requested of input.projects) {
    const scope = await allowedScope(database, identity, requested.scopeKey);
    if (!scope) continue;
    const rows = await database<any[]>`
      select p.id, p.description, p.description_source_fingerprint,
        candidate.id as pending_candidate_id,
        candidate.source_fingerprint as pending_source_fingerprint
      from projects p
      left join lateral (
        select id, source_fingerprint from project_description_candidates
        where tenant_id = ${identity.tenantId}
          and partner_id = ${identity.partnerId} and project_id = p.id
          and status = 'pending'
        order by created_at desc limit 1
      ) candidate on true
      where p.tenant_id = ${identity.tenantId} and p.team_id = ${identity.teamId}
        and p.status = 'active'
        and p.external_ids @> ${JSON.stringify([pathExternalId(requested.rootFingerprint)])}::jsonb
      limit 1
    `;
    const project = rows[0];
    let pendingSourceFingerprint = project?.pending_source_fingerprint ?? null;
    if (
      project?.description_source_fingerprint === requested.sourceFingerprint &&
      project?.pending_candidate_id &&
      pendingSourceFingerprint !== requested.sourceFingerprint
    ) {
      await database`
        update project_description_candidates set status = 'superseded',
          reviewed_at = now(), updated_at = now()
        where id = ${project.pending_candidate_id}
          and tenant_id = ${identity.tenantId} and status = 'pending'
      `;
      pendingSourceFingerprint = null;
    }
    projects.push({
      scopeKey: requested.scopeKey,
      rootFingerprint: requested.rootFingerprint,
      projectId: project?.id ?? null,
      description: project?.description ?? null,
      sourceFingerprint: project?.description_source_fingerprint ?? null,
      pendingSourceFingerprint,
    });
  }
  return { projects };
}

export async function registerProjectDescriptionCandidate(
  identity: PluginIdentity,
  rawInput: unknown,
  database: Database = defaultDatabase,
) {
  const input = projectDescriptionCandidateSchema.parse(rawInput);
  const scope = await allowedScope(database, identity, input.scopeKey);
  if (!scope)
    throw new ApiError(
      403,
      "PROJECT_DESCRIPTION_SCOPE_NOT_ALLOWED",
      "项目尚未授权采集，不能提交项目描述。",
    );

  return database.begin(async (tx) => {
    const project = await resolveProjectIdentity(tx, identity, {
      id: null,
      matchMethod: "path_discovered",
      rootFingerprint: input.rootFingerprint,
      rootName: scope.display_name,
    });
    if (!project)
      throw new ApiError(
        422,
        "PROJECT_DESCRIPTION_PROJECT_MISSING",
        "无法识别项目描述对应的项目。",
      );
    const existing = await tx<Array<{ id: string; status: string }>>`
      select id, status from project_description_candidates
      where plugin_instance_id = ${identity.pluginInstanceId}
        and project_id = ${project.id}
        and source_fingerprint = ${input.sourceFingerprint}
      limit 1
    `;
    const formal = await tx<
      Array<{ description_source_fingerprint: string | null }>
    >`
      select description_source_fingerprint from projects
      where id = ${project.id} and tenant_id = ${identity.tenantId}
      limit 1
    `;
    if (
      existing[0]?.status === "approved" &&
      formal[0]?.description_source_fingerprint === input.sourceFingerprint
    )
      return { candidateId: existing[0].id, status: "approved" as const };
    if (existing[0]?.status === "pending")
      return { candidateId: existing[0].id, status: existing[0].status };

    await tx`
      update project_description_candidates set status = 'superseded',
        reviewed_at = now(), updated_at = now()
      where plugin_instance_id = ${identity.pluginInstanceId}
        and project_id = ${project.id} and status = 'pending'
        and (${existing[0]?.id ?? null}::uuid is null or id <> ${existing[0]?.id ?? null})
    `;
    if (existing[0]) {
      await tx`
        update project_description_candidates set
          scope_key = ${input.scopeKey}, description = ${input.description},
          status = 'pending', reviewed_at = null, updated_at = now()
        where id = ${existing[0].id}
      `;
      return { candidateId: existing[0].id, status: "pending" as const };
    }
    const candidateId = randomUUID();
    await tx`
      insert into project_description_candidates (
        id, tenant_id, team_id, partner_id, plugin_instance_id, project_id,
        scope_key, description, source_fingerprint
      ) values (
        ${candidateId}, ${identity.tenantId}, ${identity.teamId},
        ${identity.partnerId}, ${identity.pluginInstanceId}, ${project.id},
        ${input.scopeKey}, ${input.description}, ${input.sourceFingerprint}
      )
    `;
    return { candidateId, status: "pending" as const };
  });
}
