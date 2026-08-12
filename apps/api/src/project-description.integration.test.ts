import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient as sql } from "@partner-report/db";
import {
  loadProjectDescriptionState,
  registerProjectDescriptionCandidate,
} from "./project-description.js";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("project description candidates", () => {
  const identity = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    partnerId: randomUUID(),
    pluginInstanceId: randomUUID(),
  };
  const scopeKey = "a".repeat(64);
  const rootFingerprint = "b".repeat(64);
  const sourceFingerprint = "c".repeat(64);

  beforeAll(async () => {
    await sql`insert into tenants (id, name) values (${identity.tenantId}, 'Project Description Test')`;
    await sql`insert into teams (id, tenant_id, name) values (${identity.teamId}, ${identity.tenantId}, 'Description Team')`;
    await sql`
      insert into partners (id, tenant_id, team_id, email, display_name, status)
      values (${identity.partnerId}, ${identity.tenantId}, ${identity.teamId},
        'description-test@example.com', 'Description Partner', 'active')
    `;
    await sql`
      insert into plugin_instances (
        id, tenant_id, team_id, partner_id, device_name, version, status,
        access_token_hash, refresh_token_hash, access_expires_at
      ) values (
        ${identity.pluginInstanceId}, ${identity.tenantId}, ${identity.teamId},
        ${identity.partnerId}, 'description-device', '0.4.5', 'active',
        'access', 'refresh', now() + interval '1 hour'
      )
    `;
    await sql`
      insert into project_scope_entries (
        id, tenant_id, team_id, partner_id, plugin_instance_id, scope_key,
        display_name, status, effective_from, first_seen_period_key, session_count
      ) values (
        ${randomUUID()}, ${identity.tenantId}, ${identity.teamId},
        ${identity.partnerId}, ${identity.pluginInstanceId}, ${scopeKey},
        'description-project', 'allowed', now(), '2026-W33', 1
      )
    `;
  });

  afterAll(async () => {
    await sql`delete from project_description_candidates where tenant_id = ${identity.tenantId}`;
    await sql`delete from project_scope_entries where tenant_id = ${identity.tenantId}`;
    await sql`delete from projects where tenant_id = ${identity.tenantId}`;
    await sql`delete from plugin_instances where tenant_id = ${identity.tenantId}`;
    await sql`delete from partners where tenant_id = ${identity.tenantId}`;
    await sql`delete from teams where tenant_id = ${identity.tenantId}`;
    await sql`delete from tenants where id = ${identity.tenantId}`;
  });

  it("creates one candidate for an allowed scope and reuses it idempotently", async () => {
    const input = {
      scopeKey,
      rootFingerprint,
      sourceFingerprint,
      description:
        "这是一个面向团队的工作报告平台，用于采集成员的有效项目进展，经过本人审核后生成个人报告，并汇总为便于管理者理解的团队报告。",
    };
    const first = await registerProjectDescriptionCandidate(identity, input);
    const second = await registerProjectDescriptionCandidate(identity, input);
    expect(second).toEqual(first);

    const state = await loadProjectDescriptionState(identity, {
      projects: [{ scopeKey, rootFingerprint, sourceFingerprint }],
    });
    expect(state.projects[0]).toMatchObject({
      projectId: expect.any(String),
      description: null,
      pendingSourceFingerprint: sourceFingerprint,
    });
  });

  it("rejects a description for a scope that was not allowed", async () => {
    await expect(
      registerProjectDescriptionCandidate(identity, {
        scopeKey: "d".repeat(64),
        rootFingerprint,
        sourceFingerprint: "e".repeat(64),
        description:
          "这是一个不属于已授权采集范围的项目描述，服务端必须在保存任何候选内容之前拒绝该请求，不能依赖插件自行遵守权限边界。",
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_DESCRIPTION_SCOPE_NOT_ALLOWED",
    });
  });

  it("supersedes a stale candidate when the project returns to its approved fingerprint", async () => {
    const projects = await sql<Array<{ id: string }>>`
      select id from projects where tenant_id = ${identity.tenantId}
        and external_ids @> ${JSON.stringify([`path-sha256:${rootFingerprint}`])}::jsonb
      limit 1
    `;
    const projectId = projects[0]!.id;
    await sql`
      update projects set description = '已经审核通过的项目描述。',
        description_source_fingerprint = ${sourceFingerprint}
      where id = ${projectId}
    `;
    const staleFingerprint = "f".repeat(64);
    await sql`
      insert into project_description_candidates (
        id, tenant_id, team_id, partner_id, plugin_instance_id, project_id,
        scope_key, description, source_fingerprint, status
      ) values (
        ${randomUUID()}, ${identity.tenantId}, ${identity.teamId},
        ${identity.partnerId}, ${identity.pluginInstanceId}, ${projectId},
        ${scopeKey}, '已经不符合当前项目材料的旧候选描述。',
        ${staleFingerprint}, 'pending'
      )
    `;

    const state = await loadProjectDescriptionState(identity, {
      projects: [{ scopeKey, rootFingerprint, sourceFingerprint }],
    });
    expect(state.projects[0]?.pendingSourceFingerprint).toBeNull();
    const stale = await sql<Array<{ status: string }>>`
      select status from project_description_candidates
      where project_id = ${projectId} and source_fingerprint = ${staleFingerprint}
    `;
    expect(stale[0]?.status).toBe("superseded");
  });
});
