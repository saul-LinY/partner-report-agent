import type { FastifyInstance } from "fastify";
import { loadProjectProfiles } from "@partner-report/db";
import { requireWebActor } from "../common.js";

export async function projectProfileRoutes(app: FastifyInstance) {
  app.get("/v1/admin/project-profiles", async (request) => {
    const actor = await requireWebActor(request, "admin");
    return { items: await loadProjectProfiles(actor) };
  });
}
