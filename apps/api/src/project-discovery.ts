import { randomUUID } from "node:crypto";
import { ApiError } from "./common.js";

export type ProjectIdentity = {
  id: string | null;
  matchMethod:
    | "exact_root"
    | "descendant_path"
    | "path_discovered"
    | "unassigned";
  rootFingerprint: string;
  rootName?: string;
};

type ActorScope = {
  tenantId: string;
  teamId: string;
};

type ProjectRow = {
  id: string;
  name: string;
  external_ids: string[];
};

const pathExternalId = (fingerprint: string) =>
  `path-sha256:${fingerprint}`;

async function attachPathFingerprint(
  tx: any,
  project: ProjectRow,
  fingerprint: string,
) {
  const externalId = pathExternalId(fingerprint);
  if (project.external_ids.includes(externalId)) return project;
  const externalIds = [...project.external_ids, externalId];
  await tx`
    update projects set external_ids = ${JSON.stringify(externalIds)}::jsonb,
      updated_at = now()
    where id = ${project.id}
  `;
  return { ...project, external_ids: externalIds };
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
      await attachPathFingerprint(tx, project, identity.rootFingerprint);
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
  let rows = await tx<ProjectRow[]>`
    select id, name, external_ids from projects
    where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
      and status = 'active'
      and external_ids @> ${JSON.stringify([externalId])}::jsonb
    limit 1
  `;
  if (!rows[0]) {
    rows = await tx<ProjectRow[]>`
      select id, name, external_ids from projects
      where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId}
        and status = 'active' and lower(name) = lower(${identity.rootName})
      limit 1
    `;
  }
  let project = rows[0];
  if (!project) {
    const inserted = await tx<ProjectRow[]>`
      insert into projects (
        id, tenant_id, team_id, name, aliases, allowed_paths, external_ids
      ) values (
        ${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${identity.rootName},
        '[]'::jsonb, '[]'::jsonb, ${JSON.stringify([externalId])}::jsonb
      ) on conflict (tenant_id, team_id, name) do nothing
      returning id, name, external_ids
    `;
    project = inserted[0];
    if (!project) {
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
  project = await attachPathFingerprint(
    tx,
    project,
    identity.rootFingerprint,
  );
  return {
    id: project.id,
    name: project.name,
    matchMethod: "path_discovered" as const,
    rootFingerprint: identity.rootFingerprint,
  };
}
