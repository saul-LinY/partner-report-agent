import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sql: vi.fn(), actor: vi.fn() }));
vi.mock("@partner-report/db", () => ({ sqlClient: mocks.sql }));
vi.mock("../common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../common.js")>()),
  requireWebActor: mocks.actor,
}));

import { reviewRoutes } from "./reviews.js";

describe("native approval inbox", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    await app.register(reviewRoutes);
    vi.clearAllMocks();
    mocks.actor.mockResolvedValue({
      tenantId: "tenant-a",
      teamId: "team-a",
      partnerId: "partner-a",
    });
    mocks.sql.mockResolvedValue([]);
  });
  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("lists pending reviews across periods, scoped to the authenticated member", async () => {
    const reviews = [
      {
        id: "review-new",
        state: "IN_PROGRESS",
        version: 3,
        period_key: "2026-W44",
      },
      {
        id: "review-old",
        state: "IN_PROGRESS",
        version: 2,
        period_key: "2026-W43",
      },
    ];
    mocks.sql.mockResolvedValue(reviews);
    const result = await app.inject({
      method: "GET",
      url: "/v1/partner/reviews?partnerId=someone-else",
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ reviews });
    expect(mocks.actor).toHaveBeenCalledWith(expect.anything(), "partner");
    const [strings, ...values] = mocks.sql.mock.calls[0]!;
    const query = strings.join("?");
    expect(query).toContain("r.state = 'IN_PROGRESS'");
    expect(query).toContain("r.tenant_id = ?");
    expect(query).toContain("r.team_id = ?");
    expect(query).toContain("r.partner_id = ?");
    expect(values).toEqual(["tenant-a", "team-a", "partner-a"]);
    expect(query).not.toContain("limit 1");
  });

  it("does not query review content for an unauthenticated request", async () => {
    mocks.actor.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
    );
    const result = await app.inject({
      method: "GET",
      url: "/v1/partner/reviews",
    });
    expect(result.statusCode).toBe(401);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("requires a partner profile instead of listing other members' reviews", async () => {
    mocks.actor.mockResolvedValue({
      tenantId: "tenant-a",
      teamId: "team-a",
      partnerId: null,
    });
    const result = await app.inject({
      method: "GET",
      url: "/v1/partner/reviews",
    });
    expect(result.statusCode).toBe(403);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
