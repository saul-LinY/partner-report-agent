import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadProjectProgress, sqlClient as sql } from "@partner-report/db";
import {
  progressDateSchema,
  progressEventSchema,
  progressToday,
  validateProgressEvents,
} from "@partner-report/contracts/project-progress";
import { ApiError, leadershipRead, requireWebActor } from "../common.js";

const paramsSchema = z.object({
  partnerId: z.string().uuid(),
  projectId: z.string().uuid(),
});
async function participationScope(request: FastifyRequest) {
  const actor = await requireWebActor(request, "partner");
  const ids = paramsSchema.parse(request.params);
  if (!actor.roles.includes("admin") && actor.partnerId !== ids.partnerId)
    throw new ApiError(403, "FORBIDDEN", "只能核查自己的项目时间。");
  const [scope] = await sql<{ timezone: string }[]>`
    select t.timezone from teams t
    join partners m on m.team_id = t.id and m.tenant_id = t.tenant_id
    join projects p on p.team_id = t.id and p.tenant_id = t.tenant_id
    where t.id = ${actor.teamId} and t.tenant_id = ${actor.tenantId}
      and m.id = ${ids.partnerId} and p.id = ${ids.projectId}
  `;
  if (!scope)
    throw new ApiError(404, "PROJECT_NOT_FOUND", "成员或项目不属于当前团队。");
  return {
    actor,
    ...ids,
    timezone: scope.timezone,
    today: progressToday(scope.timezone),
  };
}

export async function projectProgressRoutes(app: FastifyInstance) {
  app.get("/v1/admin/project-progress", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({
        from: progressDateSchema.optional(),
        to: progressDateSchema.optional(),
      })
      .parse(request.query);
    return leadershipRead(() => loadProjectProgress(actor, query));
  });

  app.get(
    "/v1/project-progress/participations/:partnerId/:projectId",
    async (request) => {
      const { actor, partnerId, projectId, timezone, today } =
        await participationScope(request);
      const [row] = await sql<
        any[]
      >`select id, version, events from project_participations where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and partner_id = ${partnerId} and project_id = ${projectId}`;
      const history = row
        ? await sql<any[]>`
      select v.version, v.created_at as "createdAt", u.display_name as "actorName", v.note, v.review_id as "reviewId", v.events
      from project_participation_versions v join users u on u.id = v.actor_id
      where v.participation_id = ${row.id} order by v.version desc limit 20
    `
        : [];
      return {
        version: row?.version ?? 0,
        events: row?.events ?? [],
        timezone,
        today,
        history,
      };
    },
  );

  app.post(
    "/v1/project-progress/participations/:partnerId/:projectId",
    async (request) => {
      const { actor, partnerId, projectId, today } =
        await participationScope(request);
      const input = z
        .object({
          baseVersion: z.number().int().min(0),
          events: z.array(progressEventSchema).max(500),
          note: z.string().trim().min(2).max(500),
          reviewId: z.string().uuid().optional(),
        })
        .strict()
        .parse(request.body);
      const error = validateProgressEvents(input.events, today);
      if (error) throw new ApiError(400, "INVALID_TIMELINE", error);
      return sql.begin(async (tx) => {
        // Lock the member even for a first insert, preventing competing version-zero writes.
        await tx`select id from partners where id = ${partnerId} and tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} for update`;
        if (input.reviewId) {
          const [review] =
            await tx`select r.id from reviews r join work_items wi on wi.review_id = r.id and wi.tenant_id = r.tenant_id and wi.team_id = r.team_id and wi.partner_id = r.partner_id where r.id = ${input.reviewId} and r.tenant_id = ${actor.tenantId} and r.team_id = ${actor.teamId} and r.partner_id = ${partnerId} and wi.project_id = ${projectId}`;
          if (!review)
            throw new ApiError(
              404,
              "REVIEW_NOT_FOUND",
              "该周卡不属于此成员和项目。",
            );
        }
        const [row] = await tx<
          any[]
        >`select id, version, events from project_participations where tenant_id = ${actor.tenantId} and team_id = ${actor.teamId} and partner_id = ${partnerId} and project_id = ${projectId} for update`;
        if ((row?.version ?? 0) !== input.baseVersion)
          throw new ApiError(
            409,
            "VERSION_CONFLICT",
            "时间记录已被其他人修改，请重新载入后核查；当前草稿未覆盖服务器记录。",
          );
        input.events = input.events.map((event) => {
          if (!event.projectStatus) {
            const { statusConfirmedAt, ...rest } = event;
            return rest;
          }
          const previous = row?.events.find(
            (old: any) =>
              old.type === event.type &&
              old.date === event.date &&
              old.projectStatus === event.projectStatus &&
              old.reason === event.reason,
          );
          return {
            ...event,
            statusConfirmedAt:
              previous?.statusConfirmedAt ?? new Date().toISOString(),
          };
        });
        const id = row?.id ?? randomUUID();
        const version = input.baseVersion + 1;
        if (row)
          await tx`update project_participations set events = ${JSON.stringify(input.events)}::jsonb, version = ${version}, updated_at = now() where id = ${id}`;
        else
          await tx`insert into project_participations (id, tenant_id, team_id, partner_id, project_id, version, events) values (${id}, ${actor.tenantId}, ${actor.teamId}, ${partnerId}, ${projectId}, ${version}, ${JSON.stringify(input.events)}::jsonb)`;
        await tx`insert into project_participation_versions (id, participation_id, version, events, note, actor_id, review_id) values (${randomUUID()}, ${id}, ${version}, ${JSON.stringify(input.events)}::jsonb, ${input.note}, ${actor.userId}, ${input.reviewId ?? null})`;
        await tx`insert into audit_events (id, tenant_id, team_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata) values (${randomUUID()}, ${actor.tenantId}, ${actor.teamId}, ${actor.actorType}, ${actor.actorId}, 'project_participation.updated', 'project_participation', ${id}, ${request.id}, ${JSON.stringify({ version, partnerId, projectId, reviewId: input.reviewId ?? null, note: input.note })}::jsonb)`;
        return { version, events: input.events };
      });
    },
  );
}
