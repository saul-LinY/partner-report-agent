import { randomUUID } from "node:crypto";
import { sqlClient as sql } from "@partner-report/db";
import { createFeishuClient } from "./feishu/client.js";
import { requireFeishuConfig } from "./feishu/config.js";

export const systemProbeKeys = [
  "api",
  "queue",
  "generation",
  "feishu",
  "reports",
] as const;

export type SystemProbeKey = (typeof systemProbeKeys)[number];

export type SystemProbeResult = {
  component: SystemProbeKey;
  status: "passed" | "failed";
  summary: string;
  detail: string;
  errorCode: string | null;
  durationMs: number;
  checkedAt: string;
};

type ProbeContext = {
  tenantId: string;
  teamId: string;
};

const workerProbeTypes = {
  queue: "SYSTEM_HEALTH_QUEUE",
  generation: "SYSTEM_HEALTH_GENERATION",
  reports: "SYSTEM_HEALTH_REPORTS",
} as const;

const successCopy: Record<SystemProbeKey, { summary: string; detail: string }> =
  {
    api: {
      summary: "API 与数据库测试通过",
      detail: "服务响应正常，数据库查询和临时写入均已完成。",
    },
    queue: {
      summary: "后台任务队列测试通过",
      detail: "测试任务已成功入队，并由 Worker 领取完成。",
    },
    generation: {
      summary: "内容生成测试通过",
      detail: "Worker 已调用模型服务，并收到有效的结构化结果。",
    },
    feishu: {
      summary: "飞书连接测试通过",
      detail: "飞书应用凭据有效，开放平台响应正常；本次未发送消息。",
    },
    reports: {
      summary: "报告生成测试通过",
      detail: "Worker 已使用内置测试数据完成报告结构和内容校验，未保存报告。",
    },
  };

const failureCopy: Record<string, string> = {
  DATABASE_PROBE_FAILED: "数据库查询或临时写入没有正常完成。",
  WORKER_PROBE_TIMEOUT: "Worker 没有在规定时间内完成测试任务。",
  QUEUE_WORKER_UNHEALTHY: "Worker 无法正常处理队列测试任务。",
  MODEL_NOT_CONFIGURED: "内容生成服务尚未配置。",
  MODEL_REQUEST_TIMEOUT: "内容生成服务响应超时。",
  CENTRAL_GENERATION_FAILED: "内容生成服务没有返回有效结果。",
  FEISHU_NOT_CONFIGURED: "飞书应用凭据尚未完整配置。",
  FEISHU_AUTH_FAILED: "飞书开放平台拒绝了当前应用凭据。",
  FEISHU_REQUEST_TIMEOUT: "飞书开放平台响应超时。",
  FEISHU_UNAVAILABLE: "当前无法连接飞书开放平台。",
  REPORT_PIPELINE_UNHEALTHY: "报告生成程序没有通过内置数据校验。",
  SYSTEM_PROBE_FAILED: "模块测试没有正常完成。",
};

export class SystemProbeError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SystemProbeError";
  }
}

function timeoutMs() {
  const configured = Number(process.env.SYSTEM_PROBE_TIMEOUT_MS ?? 35_000);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.min(configured, 120_000)
    : 35_000;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeDatabase() {
  try {
    await sql.begin(async (tx) => {
      await tx`create temporary table system_health_probe (value integer not null) on commit drop`;
      await tx`insert into system_health_probe (value) values (1)`;
      const rows = await tx<{ value: number }[]>`
        select value from system_health_probe limit 1
      `;
      if (rows[0]?.value !== 1) throw new Error("temporary write mismatch");
    });
  } catch {
    throw new SystemProbeError("DATABASE_PROBE_FAILED");
  }
}

async function probeWorker(
  component: keyof typeof workerProbeTypes,
  context: ProbeContext,
) {
  const id = randomUUID();
  const type = workerProbeTypes[component];
  const deadline = Date.now() + timeoutMs();
  await sql`
    insert into agent_jobs (
      id, tenant_id, team_id, type, status, idempotency_key,
      input_payload, attempt_count, max_attempts
    ) values (
      ${id}, ${context.tenantId}, ${context.teamId}, ${type}, 'PENDING',
      ${`system-health:${id}`}, ${JSON.stringify({ probeId: id })}::jsonb, 0, 1
    )
  `;

  try {
    while (Date.now() < deadline) {
      const rows = await sql<
        Array<{
          status: string;
          error_code: string | null;
          output_payload: Record<string, unknown> | null;
        }>
      >`
        select status, error_code, output_payload from agent_jobs
        where id = ${id} and tenant_id = ${context.tenantId}
        limit 1
      `;
      const job = rows[0];
      if (!job) throw new SystemProbeError("SYSTEM_PROBE_FAILED");
      if (job.status === "COMPLETED") {
        if (job.output_payload?.ok !== true)
          throw new SystemProbeError("SYSTEM_PROBE_FAILED");
        return;
      }
      if (["FAILED", "CANCELLED"].includes(job.status)) {
        throw new SystemProbeError(
          job.error_code ??
            (component === "queue"
              ? "QUEUE_WORKER_UNHEALTHY"
              : component === "reports"
                ? "REPORT_PIPELINE_UNHEALTHY"
                : "CENTRAL_GENERATION_FAILED"),
        );
      }
      await delay(250);
    }
    throw new SystemProbeError("WORKER_PROBE_TIMEOUT");
  } finally {
    await sql`
      delete from agent_jobs
      where id = ${id} and type = ${type} and status <> 'LEASED'
    `;
  }
}

async function probeFeishu() {
  let config;
  try {
    config = requireFeishuConfig();
  } catch {
    throw new SystemProbeError("FEISHU_NOT_CONFIGURED");
  }
  const client = createFeishuClient(config);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      client.auth.tenantAccessToken.internal({
        data: { app_id: config.appId, app_secret: config.appSecret },
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new SystemProbeError("FEISHU_REQUEST_TIMEOUT")),
          10_000,
        );
      }),
    ]);
    if (!feishuCredentialResponseSucceeded(response)) {
      throw new SystemProbeError("FEISHU_AUTH_FAILED");
    }
  } catch (error) {
    if (error instanceof SystemProbeError) throw error;
    throw new SystemProbeError("FEISHU_UNAVAILABLE");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function probeFailureDetail(code: string) {
  return failureCopy[code] ?? failureCopy.SYSTEM_PROBE_FAILED!;
}

export function feishuCredentialResponseSucceeded(response: unknown) {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return false;
  const record = response as Record<string, unknown>;
  const data =
    record.data &&
    typeof record.data === "object" &&
    !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  return (
    record.code === 0 &&
    (typeof record.tenant_access_token === "string" ||
      typeof data?.tenant_access_token === "string")
  );
}

export async function runSystemProbe(
  component: SystemProbeKey,
  context: ProbeContext,
): Promise<SystemProbeResult> {
  const startedAt = Date.now();
  try {
    if (component === "api") await probeDatabase();
    else if (component === "feishu") await probeFeishu();
    else await probeWorker(component, context);
    return {
      component,
      status: "passed",
      ...successCopy[component],
      errorCode: null,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const errorCode =
      error instanceof SystemProbeError ? error.code : "SYSTEM_PROBE_FAILED";
    return {
      component,
      status: "failed",
      summary: "模块测试未通过",
      detail: probeFailureDetail(errorCode),
      errorCode,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  }
}
