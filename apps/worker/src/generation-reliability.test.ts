import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAggregationByProject } from "./generation.js";

vi.mock("./project-outcomes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-outcomes.js")>()),
  loadProjectOutcomeDraft: async (_job: unknown, bucket: unknown) => ({
    id: "fixed-draft",
    source_payload: { bucket, period: {} },
    material: {
      projectPurpose: "Synthetic purpose",
      weeklyFocus: [],
      daily: [],
    },
  }),
}));

const job = {
  id: "job",
  tenant_id: "tenant",
  team_id: "team",
  partner_id: null,
  plugin_instance_id: null,
  type: "AGGREGATE_WORK_ITEMS",
  attempt_count: 1,
  max_attempts: 4,
  created_at: new Date(),
  input_payload: {
    projectBuckets: ["a", "b", "c", "d", "e"].map((projectKey) => ({
      projectKey,
    })),
  },
};
const production = {
  skillVersion: "partner-report-platform/0.3.0",
  promptVersion: "test",
  schemaVersion: "1.0",
  producer: "data-platform",
  modelVersion: "deepseek-v4-flash:cloud",
};
const success = (projectKey: string) =>
  new Response(
    JSON.stringify({
      output_text: JSON.stringify({
        schemaVersion: "1.0",
        groups: [
          {
            projectKey,
            status: "in_progress",
            projectStatus: "development",
            projectStatusReason: "本周在实现功能。",
            overview: "Synthetic overview",
            dailyProgress: [
              { date: "2026-09-07", summary: "Synthetic progress" },
            ],
          },
        ],
        qualityWarnings: [],
        production,
      }),
    }),
  );

describe("bounded project generation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.MODEL_API_KEY;
  });

  it("limits concurrent requests and preserves every project's output order", async () => {
    vi.useFakeTimers();
    process.env.MODEL_API_KEY = "test-only-key";
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const text = body.input[1].content[0].text;
      const input = JSON.parse(
        text
          .split("<partner_report_data>\n")[1]
          .split("\n</partner_report_data>")[0],
      );
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return success(input.projectBuckets[0].projectKey);
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = expect(
      generateAggregationByProject(job, "deepseek-v4-flash:cloud"),
    ).resolves.toMatchObject({
      groups: ["a", "b", "c", "d", "e"].map((projectKey) => ({ projectKey })),
    });
    await vi.advanceTimersByTimeAsync(100);
    await request;
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("waits for in-flight work and does not launch another batch after a failure", async () => {
    vi.useFakeTimers();
    process.env.MODEL_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("unavailable", {
          status: 503,
          headers: { "retry-after": "120" },
        }),
      )
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return success("b");
      });
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const request = generateAggregationByProject(
      job,
      "deepseek-v4-flash:cloud",
    ).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toMatchObject({
      code: "MODEL_SERVICE_UNAVAILABLE",
      retryAfterMs: 120_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
