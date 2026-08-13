import { randomUUID } from "node:crypto";
import { ApiError } from "./common.js";

export type ProjectIdentity = {
  id: string | null;
  matchMethod:
    "exact_root" | "descendant_path" | "path_discovered" | "unassigned";
  rootFingerprint: string;
  rootName?: string;
  scopeKey?: string;
};

type ActorScope = {
  tenantId: string;
  teamId: string;
  pluginInstanceId?: string;
};

type ProjectRow = {
  id: string;
  name: string;
  external_ids: string[];
};

const pathExternalId = (fingerprint: string) => `path-sha256:${fingerprint}`;

const scopeExternalId = (pluginInstanceId: string, scopeKey: string) =>
  `scope:${pluginInstanceId}:${scopeKey}`;

async function attachProjectExternalIds(
  tx: any,
  project: ProjectRow,
  externalIdsToAdd: string[],
) {
  const externalIds = [
    ...new Set([...project.external_ids, ...externalIdsToAdd]),
  ];
  if (externalIds.length === project.external_ids.length) return project;
  await tx`
    update projects set external_ids = ${JSON.stringify(externalIds)}::jsonb,
      updated_at = now()
    where id = ${project.id}
  `;
  return { ...project, external_ids: externalIds };
}

async function syncDiscoveredProjectName(
  tx: any,
  actor: ActorScope,
  project: ProjectRow,
  discoveredName: string | undefined,
) {
  const name = discoveredName?.trim();
  if (!name || name === project.name) return project;
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidateName = suffix === 1 ? name : `${name} (${suffix})`;
    const rows = await tx<ProjectRow[]>`
      update projects set name = ${candidateName},
        aliases = case
          when aliases @> ${JSON.stringify([project.name])}::jsonb then aliases
          else aliases || ${JSON.stringify([project.name])}::jsonb
        end,
        updated_at = now()
      where id = ${project.id} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId}
        and not exists (
          select 1 from projects other
          where other.tenant_id = ${actor.tenantId}
            and other.team_id = ${actor.teamId}
            and other.name = ${candidateName} and other.id <> ${project.id}
        )
      returning id, name, external_ids
    `;
    if (rows[0]) return rows[0];
  }
  return project;
}

async function insertDiscoveredProject(
  tx: any,
  actor: ActorScope,
  requestedName: string,
  externalIds: string[],
) {
  const stableExternalId = externalIds.find((externalId) =>
    externalId.startsWith("scope:"),
  );
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const name = suffix === 1 ? requestedName : `${requestedName} (${suffix})`;
    const rows = await tx<ProjectRow[]>`
      insert into projects (
        id, tenant_id, team_id, name, aliases, allowed_paths, external_ids
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${name},
        '[]'::jsonb, '[]'::jsonb, ${JSON.stringify(externalIds)}::jsonb
      ) on conflict (tenant_id, team_id, name) do nothing
      returning id, name, external_ids
    `;
    if (rows[0]) return rows[0];
    if (stableExternalId) {
      const concurrent = await tx<ProjectRow[]>`
        select id, name, external_ids from projects
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and status = 'active'
          and external_ids @> ${JSON.stringify([stableExternalId])}::jsonb
        limit 1
      `;
      if (concurrent[0]) return concurrent[0];
    }
  }
  return undefined;
}

export async function resolveProjectIdentity(
  tx: any,
  actor: ActorScope,
  identity: ProjectIdentity,
) {
  if (identity.id) {
    const rows = await tx<ProjectRow[]>`
      select id, name, external_ids from projects
      where id = ${identity.id} and tenant_id = ${actor.tenantId}
        and team_id = ${actor.teamId} and status = 'active'
      limit 1
    `;
    const project = rows[0];
    if (!project)
      throw new ApiError(
        422,
        "PROJECT_ID_INVALID",
        "Fact 引用的项目不属于当前 Team。",
      );
    if (identity.rootName)
      await attachProjectExternalIds(tx, project, [
        pathExternalId(identity.rootFingerprint),
        ...(actor.pluginInstanceId && identity.scopeKey
          ? [scopeExternalId(actor.pluginInstanceId, identity.scopeKey)]
          : []),
      ]);
    return {
      id: project.id,
      name: project.name,
      matchMethod: identity.matchMethod,
      rootFingerprint: identity.rootFingerprint,
    };
  }

  if (identity.matchMethod !== "path_discovered" || !identity.rootName) {
    return null;
  }

  const externalId = pathExternalId(identity.rootFingerprint);
  const stableScopeExternalId =
    actor.pluginInstanceId && identity.scopeKey
      ? scopeExternalId(actor.pluginInstanceId, identity.scopeKey)
      : null;
  let rows = stableScopeExternalId
    ? await tx<ProjectRow[]>`
        select id, name, external_ids from projects
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and status = 'active'
          and external_ids @> ${JSON.stringify([stableScopeExternalId])}::jsonb
        limit 1
      `
    : [];
  const matchedByScope = Boolean(rows[0]);
  if (!rows[0] && !stableScopeExternalId)
    rows = await tx<ProjectRow[]>`
      select id, name, external_ids from projects
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'active'
        and external_ids @> ${JSON.stringify([externalId])}::jsonb
      limit 1
    `;
  if (!rows[0] && !stableScopeExternalId) {
    rows = await tx<ProjectRow[]>`
      select id, name, external_ids from projects
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'active' and lower(name) = lower(${identity.rootName})
      limit 1
    `;
  }
  let project = rows[0];
  if (project && matchedByScope)
    project = await syncDiscoveredProjectName(
      tx,
      actor,
      project,
      identity.rootName,
    );
  if (!project) {
    project = await insertDiscoveredProject(tx, actor, identity.rootName, [
      externalId,
      ...(stableScopeExternalId ? [stableScopeExternalId] : []),
    ]);
    if (!project && !stableScopeExternalId) {
      const concurrent = await tx<ProjectRow[]>`
        select id, name, external_ids from projects
        where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
          and name = ${identity.rootName}
        limit 1
      `;
      project = concurrent[0];
    }
  }
  if (!project)
    throw new ApiError(
      500,
      "PROJECT_DISCOVERY_FAILED",
      "无法建立自动发现的项目。",
    );
  project = await attachProjectExternalIds(tx, project, [
    externalId,
    ...(stableScopeExternalId ? [stableScopeExternalId] : []),
  ]);
  return {
    id: project.id,
    name: project.name,
    matchMethod: "path_discovered" as const,
    rootFingerprint: identity.rootFingerprint,
  };
}
