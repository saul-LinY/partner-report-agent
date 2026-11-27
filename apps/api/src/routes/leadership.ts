import type { FastifyInstance } from "fastify";
import { loadLeadershipSnapshot } from "@partner-report/db";
import { leadershipRead, requireWebActor } from "../common.js";

export async function leadershipRoutes(app: FastifyInstance) {
  /** The published weekly snapshot the leadership pages read, with the schedule of the next update. */
  app.get("/v1/admin/leadership-snapshot", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return leadershipRead(() => loadLeadershipSnapshot(actor));
  });
}
