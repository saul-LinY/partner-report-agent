import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  memberHeadline,
  memberProjects,
  type PersonalData,
} from "@partner-report/contracts/member-overview";
import { addProgressDays } from "@partner-report/contracts/project-progress";
import { ApiError } from "../common.js";
import { loadAiActivity } from "./ai-activity.js";
import { requireCollector } from "./collector.js";
import { loadProjectProfiles } from "./project-profiles.js";
import { loadProjectProgress } from "./project-progress.js";

/** Activity charts page back by month, so the App gets the same 90 days as the leadership page. */
const ACTIVITY_DAYS = 90;

const querySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict();

const nextMonth = (month: string) => {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 7);
};

/**
 * A member's own page: the same figures the leadership view shows for them,
 * derived by the same code, authenticated by the App's binding.
 */
export async function personalDataRoutes(app: FastifyInstance) {
  app.get(
    "/v1/collector/personal-data",
    async (request): Promise<PersonalData> => {
      // The member comes only from the binding; there is no way to ask for anyone else.
      const actor = await requireCollector(request);
      const query = querySchema.parse(request.query);
      const scope = { tenantId: actor.tenantId, teamId: actor.teamId };
      // The first call also tells us the team's current date; the calendar month is clamped to it.
      const current = await loadProjectProgress(scope);
      const month = query.month ?? current.today.slice(0, 7);
      if (month > current.today.slice(0, 7))
        throw new ApiError(400, "INVALID_MONTH", "不能查看未来的月份。");
      const from = `${month}-01`;
      const to = [addProgressDays(`${nextMonth(month)}-01`, -1), current.today]
        .sort()
        .at(0)!;
      const [progress, activity, profiles] = await Promise.all([
        month === current.today.slice(0, 7)
          ? current
          : loadProjectProgress(scope, { from, to }),
        loadAiActivity(scope, ACTIVITY_DAYS),
        loadProjectProfiles(scope),
      ]);
      const member = progress.members.find(
        (item) => item.id === actor.partnerId,
      );
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "成员不存在。");
      const projects = memberProjects(member.id, progress, activity, profiles);
      const mine = activity.members.find((item) => item.id === member.id);
      return {
        generatedAt: progress.generatedAt,
        today: progress.today,
        timezone: progress.timezone,
        member: { id: member.id, name: member.name },
        headline: memberHeadline(member.id, projects, activity),
        projects,
        calendar: { month, from: progress.from, to: progress.to },
        activity: {
          timezone: activity.timezone,
          from: activity.from,
          to: activity.to,
          days: activity.days,
          events: mine?.events ?? [],
        },
      };
    },
  );
}
