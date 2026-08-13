import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import { ZodError } from "zod";
import { closeDatabase } from "@partner-report/db";
import { ApiError } from "./api-error.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes, type AuthRouteOptions } from "./routes/auth.js";
import { factRoutes } from "./routes/facts.js";
import { jobRoutes } from "./routes/jobs.js";
import { pluginRoutes } from "./routes/plugin.js";
import { reportRoutes } from "./routes/reports.js";
import { teamReportRoutes } from "./routes/team-reports.js";
import { reviewRoutes } from "./routes/reviews.js";
import { loadFeishuConfig } from "./feishu/config.js";
import {
  getFeishuRuntimeStatus,
  startFeishuIntegration,
} from "./feishu/integration.js";

export async function buildApp(
  options: { logger?: boolean; auth?: AuthRouteOptions } = {},
) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
              "body.password",
              "body.deviceCode",
              "body.refreshToken",
              "body.code",
              "body.id_token",
            ],
          },
    bodyLimit: 4 * 1024 * 1024,
    requestIdHeader: "x-request-id",
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://172.20.10.14:4311",
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  app.addHook("onRequest", async (request) => {
    if (["POST", "PATCH", "DELETE"].includes(request.method)) {
      if (request.url.split("?", 1)[0] === "/auth/google/callback") return;
      const origin = request.headers.origin;
      const expected = process.env.WEB_ORIGIN ?? "http://172.20.10.14:4311";
      if (origin && origin !== expected)
        throw new ApiError(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: "请求数据不符合契约。",
        retryable: false,
        requestId: request.id,
        details: error.flatten(),
      });
    }
    if (error instanceof ApiError) {
      if (
        request.method === "POST" &&
        request.url.split("?", 1)[0] === "/auth/google/callback"
      ) {
        const message = error.message
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
        return reply
          .status(error.statusCode)
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .type("text/html; charset=utf-8")
          .send(
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google 登录失败</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f5f7f8;color:#182026}.panel{width:min(420px,calc(100% - 40px));padding:32px;background:#fff;border:1px solid #dce2e5;border-radius:8px}h1{margin:0 0 12px;font-size:22px}p{color:#59646d;line-height:1.6}a{display:inline-block;margin-top:12px;color:#1769aa}</style></head><body><main class="panel"><h1>Google 登录失败</h1><p>${message}</p><a href="${process.env.WEB_ORIGIN ?? "http://172.20.10.14:4311"}/login">返回登录页</a></main></body></html>`,
          );
      }
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        retryable: error.statusCode >= 500,
        requestId: request.id,
        details: error.details,
      });
    }
    const requestError = error as { statusCode?: number; message?: string };
    if (
      typeof requestError.statusCode === "number" &&
      requestError.statusCode >= 400 &&
      requestError.statusCode < 500
    ) {
      return reply.status(requestError.statusCode).send({
        code: "REQUEST_INVALID",
        message: requestError.message ?? "请求无效。",
        retryable: false,
        requestId: request.id,
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      code: "INTERNAL_ERROR",
      message: "服务处理失败。",
      retryable: true,
      requestId: request.id,
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    time: new Date().toISOString(),
    feishu: getFeishuRuntimeStatus(),
  }));
  await app.register(authRoutes, options.auth ?? {});
  await app.register(adminRoutes);
  await app.register(pluginRoutes);
  await app.register(factRoutes);
  await app.register(jobRoutes);
  await app.register(reviewRoutes);
  await app.register(reportRoutes);
  await app.register(teamReportRoutes);
  return app;
}

async function start() {
  const feishuConfig = loadFeishuConfig();
  const app = await buildApp();
  const host = process.env.API_HOST ?? "0.0.0.0";
  const port = Number(process.env.API_PORT ?? 4310);
  await app.listen({ host, port });
  const feishu = feishuConfig
    ? await startFeishuIntegration(
        feishuConfig,
        {
          info: (context, message) => app.log.info(context, message),
          warn: (context, message) => app.log.warn(context, message),
          error: (context, message) => app.log.error(context, message),
        },
        {
          reviewDeliveryEnabled:
            process.env.FEISHU_REVIEW_DELIVERY_ENABLED !== "false",
        },
      )
    : null;

  const shutdown = async () => {
    await feishu?.stop();
    await app.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) await start();
