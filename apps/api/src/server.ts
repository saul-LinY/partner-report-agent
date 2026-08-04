import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { closeDatabase } from "@partner-report/db";
import { ApiError } from "./common.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { factRoutes } from "./routes/facts.js";
import { jobRoutes } from "./routes/jobs.js";
import { pluginRoutes } from "./routes/plugin.js";
import { reportRoutes } from "./routes/reports.js";
import { teamReportRoutes } from "./routes/team-reports.js";
import { reviewRoutes } from "./routes/reviews.js";

export async function buildApp(options: { logger?: boolean } = {}) {
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
            ],
          },
    bodyLimit: 4 * 1024 * 1024,
    requestIdHeader: "x-request-id",
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:4311",
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  app.addHook("onRequest", async (request) => {
    if (["POST", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin;
      const expected = process.env.WEB_ORIGIN ?? "http://127.0.0.1:4311";
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
  }));
  await app.register(authRoutes);
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
  const app = await buildApp();
  const host = process.env.API_HOST ?? "127.0.0.1";
  const port = Number(process.env.API_PORT ?? 4310);
  await app.listen({ host, port });

  const shutdown = async () => {
    await app.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) await start();
