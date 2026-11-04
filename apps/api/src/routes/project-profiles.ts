import type { FastifyInstance } from "fastify";
import { sqlClient as sql } from "@partner-report/db";
import {
  mentionsCredential,
  scrubText,
} from "@partner-report/contracts/privacy";
import {
  dropInvalidClaims,
  projectProfileNoteSchema,
} from "@partner-report/contracts/project-profile";
import { requireWebActor } from "../common.js";

const EXCERPT_CHARS = 300;

export async function projectProfileRoutes(app: FastifyInstance) {
  // Plain-language project profiles, one per person and project.
  app.get("/v1/admin/project-profiles", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const rows = await sql<
      {
        id: string;
        partner_id: string;
        project_name: string;
        note: unknown;
        updated_at: Date;
        last_error: string | null;
        sessions: number;
      }[]
    >`
      select pr.id, pr.partner_id, e.display_name as project_name, pr.note, pr.updated_at, pr.last_error,
        (select count(*)::int from project_profile_sessions ps
          where ps.profile_id = pr.id and ps.status = 'done') as sessions
      from project_profiles pr
      join project_scope_entries e on e.plugin_instance_id = pr.plugin_instance_id
        and e.scope_key = pr.scope_key
      where pr.tenant_id = ${actor.tenantId} and pr.team_id = ${actor.teamId}
      order by e.display_name, pr.partner_id`;
    return {
      items: rows.map((row) => ({
        id: row.id,
        partnerId: row.partner_id,
        projectName: row.project_name,
        // Re-checked on every read so tightened wording rules apply to stored notes too.
        note: dropInvalidClaims(projectProfileNoteSchema.parse(row.note)).note,
        updatedAt: row.updated_at,
        sessions: row.sessions,
        failed: Boolean(row.last_error),
      })),
    };
  });
}
