import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAiActivity, sqlClient as sql } from "@partner-report/db";
import { publishDueLeadershipSnapshots } from "./leadership.js";

const suite = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("leadership snapshot publication", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    partner = randomUUID(),
    ancientPeriod = randomUUID(),
    publishedPeriod = randomUUID(),
    olderPeriod = randomUUID(),
    newerPeriod = randomUUID(),
    review = randomUUID();
  // The team's first snapshot is for the period cut off Friday 2026-09-25; an even older period without one
  // predates snapshots and must never be published retroactively.
  // Older cutoff Friday 2026-10-02 16:00 Shanghai (publishes Monday 10-05 13:00 = 05:00Z); the newer cutoff
  // is Friday 2026-10-09 16:00. By Monday 2026-10-12 13:00 Shanghai both cutoffs have passed.
  const now = new Date("2026-10-12T05:00:00Z");

  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${tenant}, 'Leadership publish tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Leadership publish tests')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${tenant}, ${team}, ${`${partner}@test.local`}, 'Leadership reviewer')`;
    await sql`insert into report_periods (id, tenant_id, team_id, period_key, status, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone)
      values (${ancientPeriod}, ${tenant}, ${team}, 'leadership-ancient', 'facts_frozen', '2026-09-11T08:00:00Z', '2026-09-18T08:00:00Z', '2026-09-18T08:00:00Z', '2026-09-18T08:00:00Z', 'Asia/Shanghai'),
        (${publishedPeriod}, ${tenant}, ${team}, 'leadership-published', 'facts_frozen', '2026-09-18T08:00:00Z', '2026-09-25T08:00:00Z', '2026-09-25T08:00:00Z', '2026-09-25T08:00:00Z', 'Asia/Shanghai'),
        (${olderPeriod}, ${tenant}, ${team}, 'leadership-older', 'facts_frozen', '2026-09-25T08:00:00Z', '2026-10-02T08:00:00Z', '2026-10-02T08:00:00Z', '2026-10-02T08:00:00Z', 'Asia/Shanghai'),
        (${newerPeriod}, ${tenant}, ${team}, 'leadership-newer', 'open', '2026-10-02T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', 'Asia/Shanghai')`;
    await sql`insert into leadership_snapshots (id, tenant_id, team_id, period_id, period_key, cutoff_at, published_at, payload)
      values (${randomUUID()}, ${tenant}, ${team}, ${publishedPeriod}, 'leadership-published', '2026-09-25T08:00:00Z', '2026-09-28T05:00:00Z', '{}'::jsonb)`;
    await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id, state, pending_count)
      values (${review}, ${tenant}, ${team}, ${partner}, ${olderPeriod}, 'IN_PROGRESS', 1)`;
  });

  afterAll(async () => {
    for (const table of [
      "leadership_snapshots",
      "reviews",
      "report_periods",
      "partners",
      "teams",
    ])
      await sql`delete from ${sql(table)} where tenant_id = ${tenant}`;
    await sql`delete from tenants where id = ${tenant}`;
  });

  const published = () =>
    sql`select period_key from leadership_snapshots where tenant_id = ${tenant} order by cutoff_at`;

  it("publishes an older period that only becomes final after the next cutoff", async () => {
    await publishDueLeadershipSnapshots(now, tenant);
    expect(await published()).toEqual([{ period_key: "leadership-published" }]);

    // Reopened after approval and not resubmitted: nothing pending, so the period is final.
    await sql`update reviews set pending_count = 0 where id = ${review}`;
    await publishDueLeadershipSnapshots(now, tenant);
    // The period before the team's first snapshot stays unpublished.
    expect(await published()).toEqual([
      { period_key: "leadership-published" },
      { period_key: "leadership-older" },
    ]);

    // A published period is not rewritten and the still-open newer period waits.
    expect((await publishDueLeadershipSnapshots(now, tenant)).published).toBe(
      0,
    );
  });
});

suite("leadership snapshot publication with failed generation", () => {
  const tenant = randomUUID(),
    team = randomUUID(),
    brokenTeam = randomUUID(),
    partner = randomUUID(),
    period = randomUUID(),
    brokenPeriod = randomUUID(),
    review = randomUUID(),
    job = randomUUID();
  const now = new Date("2026-10-12T05:00:00Z");

  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${tenant}, 'Leadership failed generation tests')`;
    await sql`insert into teams (id, tenant_id, name) values (${team}, ${tenant}, 'Healthy'), (${brokenTeam}, ${tenant}, 'Broken')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${partner}, ${tenant}, ${team}, ${`${partner}@test.local`}, 'Failed generation member')`;
    // The broken team's period has a timezone Intl rejects, so publishing it throws; it is scanned first.
    await sql`insert into report_periods (id, tenant_id, team_id, period_key, status, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone)
      values (${brokenPeriod}, ${tenant}, ${brokenTeam}, 'failed-broken', 'facts_frozen', '2026-09-25T08:00:00Z', '2026-10-02T08:00:00Z', '2026-10-02T08:00:00Z', '2026-10-02T08:00:00Z', 'Not/AZone'),
        (${period}, ${tenant}, ${team}, 'failed-generation', 'facts_frozen', '2026-10-02T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z', 'Asia/Shanghai')`;
    // The member's review never left PENDING: its card generation job is still queued.
    await sql`insert into reviews (id, tenant_id, team_id, partner_id, period_id)
      values (${review}, ${tenant}, ${team}, ${partner}, ${period})`;
    await sql`insert into agent_jobs (id, tenant_id, team_id, partner_id, type, idempotency_key, status, input_payload)
      values (${job}, ${tenant}, ${team}, ${partner}, 'AGGREGATE_WORK_ITEMS', ${`failed-generation:${job}`}, 'PENDING',
        ${JSON.stringify({ reviewId: review, period: { id: period } })}::jsonb)`;
  });

  afterAll(async () => {
    for (const table of [
      "leadership_snapshots",
      "agent_jobs",
      "reviews",
      "report_periods",
      "partners",
      "teams",
    ])
      await sql`delete from ${sql(table)} where tenant_id = ${tenant}`;
    await sql`delete from tenants where id = ${tenant}`;
  });

  it("waits for queued generation, then treats a permanently failed one as final while isolating a broken team", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A queued generation job blocks the healthy team; the broken team's failure does not escape.
      expect(
        (await publishDueLeadershipSnapshots(now, tenant)).published,
      ).toBe(0);
      expect(errors).toHaveBeenCalledWith(
        "Leadership snapshot publish failed",
        expect.objectContaining({ periodId: brokenPeriod }),
      );

      await sql`update agent_jobs set status = 'FAILED' where id = ${job}`;
      expect(
        (await publishDueLeadershipSnapshots(now, tenant)).published,
      ).toBe(1);
      expect(
        await sql`select period_key from leadership_snapshots where tenant_id = ${tenant}`,
      ).toEqual([{ period_key: "failed-generation" }]);
    } finally {
      errors.mockRestore();
    }
  });
});

suite("AI activity as of a snapshot cutoff", () => {
  const id = {
    tenant: randomUUID(),
    team: randomUUID(),
    user: randomUUID(),
    partner: randomUUID(),
    instance: randomUUID(),
    binding: randomUUID(),
    device: randomUUID(),
    upload: randomUUID(),
  };
  // Friday 2026-10-09 16:00 Shanghai.
  const asOf = new Date("2026-10-09T08:00:00Z");

  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${id.tenant}, 'AI activity cutoff tests')`;
    await sql`insert into teams (id, tenant_id, name, timezone) values (${id.team}, ${id.tenant}, 'Activity', 'Asia/Shanghai')`;
    await sql`insert into users (id, email, display_name, password_hash) values (${id.user}, ${`${id.user}@test.local`}, 'Creator', 'unused')`;
    await sql`insert into partners (id, tenant_id, team_id, email, display_name) values (${id.partner}, ${id.tenant}, ${id.team}, ${`${id.partner}@test.local`}, 'Activity member')`;
    await sql`insert into plugin_instances (id, tenant_id, team_id, partner_id, device_name, version, status, access_token_hash, refresh_token_hash, access_expires_at)
      values (${id.instance}, ${id.tenant}, ${id.team}, ${id.partner}, 'Legacy', '2', 'collector', ${randomUUID()}, ${randomUUID()}, now() + interval '1 day')`;
    await sql`insert into plugin_binding_codes (id, tenant_id, team_id, partner_id, code_hash, code_prefix, plugin_instance_id, created_by, status)
      values (${id.binding}, ${id.tenant}, ${id.team}, ${id.partner}, ${randomUUID()}, 'PR-AI', ${id.instance}, ${id.user}, 'claimed')`;
    await sql`insert into collector_devices (id, tenant_id, team_id, partner_id, scope_instance_id, binding_code_id, device_name, version, token_hash)
      values (${id.device}, ${id.tenant}, ${id.team}, ${id.partner}, ${id.instance}, ${id.binding}, 'Mac', '0.3', ${randomUUID()})`;
    await sql`insert into report_periods (id, tenant_id, team_id, period_key, status, starts_at, ends_at, cutoff_at, submission_deadline_at, timezone)
      values (${randomUUID()}, ${id.tenant}, ${id.team}, 'activity-week', 'open', '2026-10-02T08:00:00Z', '2026-10-16T08:00:00Z', '2026-10-16T08:00:00Z', '2026-10-16T08:00:00Z', 'Asia/Shanghai')`;
    await sql`insert into collector_uploads (id, device_id, period_key, starts_at, ends_at, policy_version, session_count, part_digests, status)
      values (${id.upload}, ${id.device}, 'activity-week', '2026-10-02T08:00:00Z', '2026-10-16T08:00:00Z', 1, 1, '[]'::jsonb, 'completed')`;
    // The newest copy of the session was modified after the cutoff but holds turns from before and after it.
    const turn = (questionTime: string) => ({
      questionTime,
      prompt: "实现登录功能",
      answer: "已完成",
    });
    await sql`insert into collector_upload_parts (upload_id, part_index, checksum, sessions)
      values (${id.upload}, 0, 'activity', ${JSON.stringify([
        {
          id: "activity-session",
          scopeKey: "activity-scope",
          agent: "codex",
          title: "登录功能",
          modifiedAt: "2026-10-09T10:00:00Z",
          turns: [
            turn("10月8日 10:00"),
            turn("10月9日 15:30"),
            turn("10月9日 17:00"),
          ],
        },
      ])}::jsonb)`;
  });

  afterAll(async () => {
    await sql`delete from session_preprocess where tenant_id = ${id.tenant}`;
    await sql`delete from collector_upload_parts where upload_id = ${id.upload}`;
    await sql`delete from collector_uploads where id = ${id.upload}`;
    for (const table of [
      "collector_devices",
      "plugin_binding_codes",
      "plugin_instances",
      "report_periods",
      "partners",
      "teams",
    ])
      await sql`delete from ${sql(table)} where tenant_id = ${id.tenant}`;
    await sql`delete from users where id = ${id.user}`;
    await sql`delete from tenants where id = ${id.tenant}`;
  });

  it("counts turns before the cutoff of a session modified after it, and leaves later turns out", async () => {
    const activity = await loadAiActivity(
      { tenantId: id.tenant, teamId: id.team },
      7,
      asOf,
    );
    expect(activity.to).toBe("2026-10-09");
    expect(activity.members).toHaveLength(1);
    expect(activity.members[0]).toMatchObject({
      turns: 2,
      sessions: 1,
      byDay: { "2026-10-08": 1, "2026-10-09": 1 },
    });
  });
});
