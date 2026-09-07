import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  regenerateReviewWorkItem,
  decideReviewWorkItem,
} from "./routes/reviews.js";
import { processNextGenerationJob } from "../../worker/src/generation.js";
import { scheduleDueTeamReports } from "../../worker/src/weekly.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

suite("fixed outcomes and Feishu instruction regeneration", () => {
  const tenant = randomUUID();
  const team = randomUUID();
  const partner = randomUUID();
  const period = randomUUID();
  const review = randomUUID();
  const jobId = randomUUID();
  const factIds = [randomUUID(), randomUUID()];
  const actor = {
    actorType: "feishu",
    actorId: "synthetic-open-id",
    userId: null,
    tenantId: tenant,
    teamId: team,
    partnerId: partner,
  };
  const calls: Array<{ name: string; input: any; model: string }> = [];
  let failWriting = true;
  let originalDrafts: any[];
  let cards: any[];

  beforeAll(async () => {
    process.env.MODEL_API_KEY = "synthetic-test-only";
    process.env.MODEL_API_BASE_URL = "http://synthetic-model.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const input = JSON.parse(
          body.input[1].content[0].text
            .split("<partner_report_data>\n")[1]
            .split("\n</partner_report_data>")[0],
        );
        const name = body.text.format.name;
        calls.push({ name, input, model: body.model });
        if (name === "partner_project_outcomes") {
          return new Response(
            JSON.stringify({
              output_text: JSON.stringify({
                projectPurpose: input.projectDescription,
                weeklyFocus: ["产品方案研究"],
                daily: [
                  {
                    date: "2026-09-01",
                    outcomes: [
                      {
                        done: `完成${input.projectName}产品方案`,
                        purpose: "支持后续评估",
                        unfinished: ["真实运行待验证"],
                        evidenceRefs: ["F1"],
                      },
                    ],
                  },
                ],
              }),
            }),
          );
        }
        const bucket = input.projectBuckets[0];
        expect(bucket).not.toHaveProperty("facts");
        expect(bucket).not.toHaveProperty("factIds");
        if (bucket.projectKey === "a" && failWriting) {
          failWriting = false;
          return new Response("busy", {
            status: 503,
            headers: { "retry-after": "120" },
          });
        }
        const corrected = input.reviewInstructions.includes(
          "实际在周三完成，另外已交付用户补充的培训材料",
        );
        const summary = corrected
          ? "周三交付产品方案和培训材料。"
          : `完成${bucket.projectName}产品方案。`;
        const overview =
          input.reviewInstruction === "保留上次修改，突出培训材料"
            ? "交付培训材料，支持团队使用产品方案。"
            : summary;
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              schemaVersion: "1.0",
              groups: [
                {
                  projectKey: bucket.projectKey,
                  status: "in_progress",
                  overview,
                  dailyProgress: [
                    { date: corrected ? "2026-09-02" : "2026-09-01", summary },
                  ],
                },
              ],
              qualityWarnings: [],
              production: {
                schemaVersion: "1.0",
                skillVersion: "partner-report-platform/0.3.0",
                promptVersion: "test",
                producer: "data-platform",
                modelVersion: body.model,
              },
            }),
          }),
        );
      }),
    );
    await sql`insert into tenants (id, name) values (${tenant}, 'Two Stage Tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Two Stage Tests')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${tenant}, ${team}, 'synthetic@local.test', 'Synthetic Partner')`;
    await sql`insert into report_periods (id, tenant_id, team_id, period_key, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone, status)
      values (${period}, ${tenant}, ${team}, 'synthetic-two-stage', '2026-08-28T08:30:00Z', '2026-09-04T09:30:00Z', '2026-09-04T09:30:00Z', '2026-09-07T09:30:00Z', 'Asia/Shanghai', 'facts_frozen')`;
    await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id) values (${review}, ${tenant}, ${team}, ${partner}, ${period})`;
    await sql`insert into coverage_snapshots (id, tenant_id, team_id, partner_id, period_id, payload)
      values (${randomUUID()}, ${tenant}, ${team}, ${partner}, ${period}, '{"discovered":2,"readable":2,"extracted":2,"failedRead":0,"failedExtract":0,"excluded":0,"pendingSync":0,"activeAtCutoff":0,"hookMissed":0}'::jsonb)`;
    const buckets = [];
    for (const [index, projectKey] of ["a", "b"].entries()) {
      const fact = {
        id: factIds[index],
        source_occurred_at: "2026-09-01T08:00:00Z",
        payload: {
          recordType: "session_contribution",
          title: "生成产品方案",
          summary: "原始研究贡献",
          contributions: [
            { kind: "outcome", text: "形成产品方案", confidence: "high" },
          ],
        },
      };
      await sql`insert into session_facts (id, tenant_id, team_id, partner_id, period_id, session_id, external_fact_id, source_revision, source_hash, source_occurred_at, payload)
        values (${fact.id!}, ${tenant}, ${team}, ${partner}, ${period}, ${projectKey}, ${projectKey}, 1, ${projectKey.repeat(64)}, '2026-09-01T08:00:00Z', ${JSON.stringify(fact.payload)}::jsonb)`;
      buckets.push({
        projectKey,
        projectId: null,
        projectName: projectKey,
        projectDescription: "帮助小团队评估产品方向。",
        factIds: [fact.id],
        facts: [fact],
      });
    }
    await sql`insert into agent_jobs (id, tenant_id, team_id, partner_id, type, idempotency_key, input_payload)
      values (${jobId}, ${tenant}, ${team}, ${partner}, 'AGGREGATE_WORK_ITEMS', ${jobId}, ${JSON.stringify(
        {
          reviewId: review,
          period: { id: period, key: "synthetic-two-stage" },
          projectBuckets: buckets,
        },
      )}::jsonb)`;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_BASE_URL;
    await sql`delete from outbox_events where tenant_id = ${tenant}`;
    await sql`delete from agent_jobs where tenant_id = ${tenant}`;
    await sql`delete from team_reports where tenant_id = ${tenant}`;
    await sql`delete from work_item_snapshots where tenant_id = ${tenant}`;
    await sql`delete from work_items where tenant_id = ${tenant}`;
    await sql`delete from reviews where tenant_id = ${tenant}`;
    await sql`delete from coverage_snapshots where tenant_id = ${tenant}`;
    await sql`delete from session_facts where tenant_id = ${tenant}`;
    await sql`delete from report_periods where tenant_id = ${tenant}`;
    await sql`delete from partners where tenant_id = ${tenant}`;
    await sql`delete from teams where tenant_id = ${tenant}`;
    await sql`delete from tenants where id = ${tenant}`;
  });

  it("persists each first-stage draft before writing and reuses it after a writing failure", async () => {
    expect(await processNextGenerationJob(tenant)).toMatchObject({
      failed: true,
      jobId,
    });
    originalDrafts =
      await sql`select * from project_outcome_drafts where tenant_id = ${tenant} order by project_key`;
    expect(originalDrafts).toHaveLength(2);
    expect(
      await sql`select id from work_items where review_id = ${review}`,
    ).toHaveLength(0);
    await sql`update agent_jobs set next_retry_at = now() - interval '1 second' where id = ${jobId}`;
    expect(await processNextGenerationJob(tenant)).toMatchObject({
      processed: true,
      jobId,
    });
    expect(
      calls.filter((call) => call.name === "partner_project_outcomes"),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.name === "partner_work_item_aggregation"),
    ).toHaveLength(4);
    expect(
      await sql`select * from project_outcome_drafts where tenant_id = ${tenant} order by project_key`,
    ).toEqual(originalDrafts);
    cards =
      await sql`select * from work_items where review_id = ${review} order by title`;
    expect(cards).toHaveLength(2);
    expect(cards[0].payload.outcomeDraftId).toBe(originalDrafts[0].id);
    expect(await scheduleDueTeamReports(period)).toBe(0);
  });

  it("rewrites only stage two with the frozen input and accumulated instructions", async () => {
    await sql`update session_facts set payload = jsonb_set(payload, '{summary}', '"later source edit"'::jsonb) where id = ${factIds[0]!}`;
    const untouched = structuredClone(cards[1]);
    const instructions = [
      "实际在周三完成，另外已交付用户补充的培训材料",
      "保留上次修改，突出培训材料",
    ];
    for (const instruction of instructions) {
      const [before] =
        await sql`select version from reviews where id = ${review}`;
      const queued = await regenerateReviewWorkItem(actor, {
        reviewId: review,
        workItemId: cards[0].id,
        instruction,
        baseVersion: before!.version,
      });
      const [job] =
        await sql`select input_payload from agent_jobs where id = ${queued.jobId}`;
      expect(JSON.stringify(job!.input_payload.projectBuckets)).not.toContain(
        "later source edit",
      );
      if (instruction === instructions[1]) {
        expect(job!.input_payload.currentCard.dailyProgress[0].date).toBe(
          "2026-09-02",
        );
        expect(job!.input_payload.currentCard.overview).toContain("培训材料");
        expect(job!.input_payload.reviewInstructions).toEqual(instructions);
      }
      expect(await processNextGenerationJob(tenant)).toMatchObject({
        processed: true,
        jobId: queued.jobId,
      });
    }
    expect(
      calls.filter((call) => call.name === "partner_project_outcomes"),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.name === "partner_work_item_aggregation"),
    ).toHaveLength(6);
    expect(new Set(calls.map((call) => call.model))).toEqual(
      new Set(["deepseek-v4-flash:cloud"]),
    );
    expect(
      await sql`select * from project_outcome_drafts where tenant_id = ${tenant} order by project_key`,
    ).toEqual(originalDrafts);
    const [unchanged] =
      await sql`select * from work_items where id = ${cards[1].id}`;
    expect(unchanged).toEqual(untouched);
    const [changed] =
      await sql`select * from work_items where id = ${cards[0].id}`;
    expect(changed!.payload.overview).toContain("培训材料");
    expect(changed!.payload.dailyProgress[0].date).toBe("2026-09-02");
    expect(changed!.payload).not.toHaveProperty("reviewInstructions");
    expect(
      await sql`select instruction from work_item_versions where work_item_id = ${cards[0].id} and instruction is not null order by version`,
    ).toEqual(instructions.map((instruction) => ({ instruction })));
  });

  it("builds the weekly report only from final approved card versions", async () => {
    for (const item of cards) {
      const [before] =
        await sql`select version from reviews where id = ${review}`;
      await decideReviewWorkItem(actor, {
        reviewId: review,
        workItemId: item.id,
        decision: "approve",
        baseVersion: before!.version,
      });
    }
    expect(await scheduleDueTeamReports(period)).toBe(1);
    const [job] =
      await sql`select input_payload from agent_jobs where tenant_id = ${tenant} and type = 'GENERATE_TEAM_REPORT'`;
    const finalCards = job!.input_payload.workCards[0].workItems;
    expect(
      finalCards.find((card: any) => card.id === cards[0].id).payload.overview,
    ).toContain("培训材料");
    expect(JSON.stringify(job!.input_payload)).not.toContain(
      "later source edit",
    );
    expect(JSON.stringify(job!.input_payload)).not.toContain("outcomeMaterial");
    expect(JSON.stringify(job!.input_payload)).not.toContain(
      "reviewInstructions",
    );
  });
});
