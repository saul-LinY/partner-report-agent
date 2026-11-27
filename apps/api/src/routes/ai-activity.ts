import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadAiActivity } from "@partner-report/db";
import { leadershipRead, requireWebActor } from "../common.js";

export async function aiActivityRoutes(app: FastifyInstance) {
  app.get("/v1/admin/ai-activity", async (request) => {
    const actor = await requireWebActor(request, "admin");
    const query = z
      .object({ days: z.coerce.number().int().min(7).max(90).default(28) })
      .strict()
      .parse(request.query);
    return leadershipRead(() => loadAiActivity(actor, query.days));
  });
}
