import {
  createFeishuEventDispatcher,
  createFeishuMessageClient,
  createFeishuWsClient,
  type FeishuSdkLogSink,
} from "./client.js";
import type { FeishuConfig } from "./config.js";
import { FeishuDeliveryService } from "./delivery.js";
import { FeishuGateway, type FeishuGatewayLogger } from "./gateway.js";

export type FeishuIntegration = {
  gateway: FeishuGateway;
  stop: () => Promise<void>;
};

export type FeishuRuntimeStatus = Readonly<{
  phase: "disabled" | "start_requested" | "callback_verified" | "stopped";
  reviewDeliveryEnabled: boolean | null;
  startRequestedAt: string | null;
  lastCallbackAt: string | null;
  lastSdkErrorAt: string | null;
}>;

let runtimeStatus: FeishuRuntimeStatus = Object.freeze({
  phase: "disabled",
  reviewDeliveryEnabled: null,
  startRequestedAt: null,
  lastCallbackAt: null,
  lastSdkErrorAt: null,
});

function updateRuntimeStatus(update: Partial<FeishuRuntimeStatus>) {
  runtimeStatus = Object.freeze({ ...runtimeStatus, ...update });
}

export function getFeishuRuntimeStatus(): FeishuRuntimeStatus {
  return runtimeStatus;
}

export async function startFeishuIntegration(
  config: FeishuConfig,
  logger: FeishuGatewayLogger,
  options: { reviewDeliveryEnabled?: boolean } = {},
): Promise<FeishuIntegration> {
  const reviewDeliveryEnabled = options.reviewDeliveryEnabled ?? true;
  updateRuntimeStatus({
    phase: "start_requested",
    reviewDeliveryEnabled,
    startRequestedAt: new Date().toISOString(),
    lastCallbackAt: null,
    lastSdkErrorAt: null,
  });
  const sdkLogSink: FeishuSdkLogSink = {
    info: (context, message) => logger.info(context, message),
    warn: (context, message) => logger.warn(context, message),
    error: (context, message) => {
      updateRuntimeStatus({ lastSdkErrorAt: new Date().toISOString() });
      logger.error(context, message);
    },
  };
  const sdkOptions = { logSink: sdkLogSink };
  const messageClient = createFeishuMessageClient(config, sdkOptions);
  const deliveries = new FeishuDeliveryService({
    appId: config.appId,
    messageClient,
    ...(process.env.WEB_ORIGIN ? { webOrigin: process.env.WEB_ORIGIN } : {}),
  });
  const gateway = new FeishuGateway(config, messageClient, deliveries, {
    logger,
    reviewDeliveryEnabled,
  });
  let stopped = false;
  const eventDispatcher = createFeishuEventDispatcher(config, sdkOptions);
  eventDispatcher.register<{
    "card.action.trigger": (data: unknown) => Promise<unknown>;
  }>({
    "card.action.trigger": (data: unknown) => {
      if (stopped) {
        return Promise.resolve({
          toast: {
            type: "error" as const,
            content: "服务正在关闭，请稍后重试。",
          },
        });
      }
      updateRuntimeStatus({
        phase: "callback_verified",
        lastCallbackAt: new Date().toISOString(),
      });
      return gateway.acceptCardAction(data);
    },
  });

  let tickRunning = false;
  let activeTick: Promise<void> | null = null;
  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await gateway.drainInbox();
      if (reviewDeliveryEnabled) {
        await gateway.drainOutbox();
      }
      await gateway.retryDueDeliveries(20, reviewDeliveryEnabled);
    } catch (_error) {
      logger.error(
        { component: "feishu_gateway" },
        "Feishu gateway polling failed",
      );
    } finally {
      tickRunning = false;
    }
  };
  const kick = () => {
    setImmediate(() => {
      if (activeTick) return;
      activeTick = tick().finally(() => {
        activeTick = null;
      });
    });
  };
  gateway.setKickHandler(kick);

  const wsClient = createFeishuWsClient(config, sdkOptions);
  await wsClient.start({ eventDispatcher });
  const interval = setInterval(kick, 1_000);
  kick();
  logger.info(
    { component: "feishu_gateway", reviewDeliveryEnabled },
    "Feishu long-connection gateway start requested",
  );

  return {
    gateway,
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await activeTick;
      updateRuntimeStatus({ phase: "stopped" });
    },
  };
}
