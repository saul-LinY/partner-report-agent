import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PersonalData } from "@partner-report/contracts/member-overview";
import { leadershipRead } from "../common.js";
import { loadPersonalWeek } from "../personal-week.js";
import { requireCollector } from "./collector.js";

/**
 * A member's own page: this week's project progress and figures, authenticated by the App's binding.
 */
export async function personalDataRoutes(app: FastifyInstance) {
  app.get(
    "/v1/collector/personal-data",
    async (request): Promise<PersonalData> => {
      // The member comes only from the binding; there is no way to ask for anyone else.
      const actor = await requireCollector(request);
      z.object({}).strict().parse(request.query);
      return leadershipRead(() => loadPersonalWeek(actor));
    },
  );
}
