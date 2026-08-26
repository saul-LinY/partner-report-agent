import * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  FeishuApiError,
  FeishuMessageClient,
  buildFeishuClientSdkConfig,
  buildFeishuEventDispatcherSdkConfig,
  buildFeishuWsSdkConfig,
  createFeishuClient,
  createFeishuEventDispatcher,
  createFeishuSdkLogger,
  createFeishuWsClient,
  type FeishuMessageTransport,
  type FeishuSdkLogSink,
} from "./client.js";
import {
  FeishuConfigError,
  loadFeishuConfig,
  requireFeishuConfig,
} from "./config.js";

const config = Object.freeze({
  appId: "cli_test_application",
  appSecret: "test-secret-that-must-not-leak",
});

function transport(input?: {
  createResponse?: unknown;
  patchResponse?: unknown;
  createError?: unknown;
  patchError?: unknown;
}) {
  const create = vi.fn<FeishuMessageTransport["create"]>(async () => {
    if (input?.createError) throw input.createError;
    return (
      input?.createResponse ?? {
        code: 0,
        data: { message_id: "om_test_message" },
      }
    );
  });
  const patch = vi.fn<FeishuMessageTransport["patch"]>(async () => {
    if (input?.patchError) throw input.patchError;
    return input?.patchResponse ?? { code: 0, data: {} };
  });
  return { create, patch };
}

function sdkLogSink() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  } satisfies FeishuSdkLogSink;
}

describe("Feishu configuration", () => {
  it("loads complete configuration and treats a fully absent setup as disabled", () => {
    expect(
      loadFeishuConfig({
        FEISHU_APP_ID: `  ${config.appId}  `,
        FEISHU_APP_SECRET: `  ${config.appSecret}  `,
      }),
    ).toEqual(config);
    expect(loadFeishuConfig({})).toBeNull();
  });

  it("rejects partial configuration without exposing configured values", () => {
    let error: unknown;
    try {
      loadFeishuConfig({ FEISHU_APP_SECRET: config.appSecret });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FeishuConfigError);
    expect(String(error)).not.toContain(config.appSecret);
    expect(() => requireFeishuConfig({})).toThrow(FeishuConfigError);
  });
});

describe("Feishu SDK factories", () => {
  it("builds self-built Feishu configs with quiet SDK logging", () => {
    expect(buildFeishuClientSdkConfig(config)).toMatchObject({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
    });
    expect(buildFeishuWsSdkConfig(config)).toMatchObject({
      appId: config.appId,
      appSecret: config.appSecret,
      autoReconnect: true,
      loggerLevel: Lark.LoggerLevel.error,
    });
    expect(buildFeishuEventDispatcherSdkConfig()).toMatchObject({
      loggerLevel: Lark.LoggerLevel.error,
    });
  });

  it("constructs the official SDK client, websocket client, and dispatcher", () => {
    expect(createFeishuClient(config)).toBeInstanceOf(Lark.Client);
    expect(createFeishuWsClient(config)).toBeInstanceOf(Lark.WSClient);
    expect(createFeishuEventDispatcher()).toBeInstanceOf(Lark.EventDispatcher);
  });

  it("forwards SDK info, warning, and error logs as safe structured records", async () => {
    const sink = sdkLogSink();
    const sdkConfig = buildFeishuClientSdkConfig(config, {
      logSink: sink,
    });
    const requestContent = "private-report-content-that-must-not-be-logged";
    const bearerToken = "bearer-value-that-must-not-leak";
    const accessToken = "access-token-that-must-not-leak";

    expect(sdkConfig.loggerLevel).toBe(Lark.LoggerLevel.info);
    await sdkConfig.logger?.info("[ws]", "client ready");
    await sdkConfig.logger?.warn(`access_token=${accessToken}`);
    await sdkConfig.logger?.error([
      `app_secret=${config.appSecret}`,
      `Authorization: Bearer ${bearerToken}`,
      new Error(
        `tenant_access_token=${accessToken}; app secret ${config.appSecret}`,
      ),
      {
        request: { data: requestContent },
        authorization: bearerToken,
        harmless: requestContent,
      },
      JSON.stringify({ content: requestContent, token: accessToken }),
    ]);

    expect(sink.info).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "feishu_sdk",
        sdkLevel: "info",
        arguments: [
          { kind: "text", value: "[ws]" },
          { kind: "text", value: "client ready" },
        ],
      }),
      "Feishu SDK info",
    );
    expect(sink.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: "feishu_sdk", sdkLevel: "warn" }),
      "Feishu SDK warn",
    );
    expect(sink.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: "feishu_sdk", sdkLevel: "error" }),
      "Feishu SDK error",
    );

    const serializedLogs = JSON.stringify({
      error: sink.error.mock.calls,
      warn: sink.warn.mock.calls,
      info: sink.info.mock.calls,
    });
    expect(serializedLogs).not.toContain(config.appSecret);
    expect(serializedLogs).not.toContain(encodeURIComponent(config.appSecret));
    expect(serializedLogs).not.toContain(bearerToken);
    expect(serializedLogs).not.toContain(accessToken);
    expect(serializedLogs).not.toContain(requestContent);
    expect(serializedLogs).not.toContain("Error: tenant_access_token");
    expect(serializedLogs).toContain("[REDACTED]");
    expect(serializedLogs).toContain("[structured payload omitted]");

    const errorContext = sink.error.mock.calls[0]?.[0];
    expect(errorContext?.arguments).toContainEqual({
      kind: "object",
      keyCount: 3,
      keys: ["request", "harmless"],
      sensitiveFieldCount: 1,
      valuesOmitted: true,
    });
  });

  it("enables the same safe logger for every SDK factory", () => {
    const sink = sdkLogSink();
    const options = { logSink: sink };

    expect(buildFeishuWsSdkConfig(config, options).loggerLevel).toBe(
      Lark.LoggerLevel.info,
    );
    expect(
      buildFeishuEventDispatcherSdkConfig(config, options).loggerLevel,
    ).toBe(Lark.LoggerLevel.info);
    expect(createFeishuClient(config, options)).toBeInstanceOf(Lark.Client);
    expect(createFeishuWsClient(config, options)).toBeInstanceOf(Lark.WSClient);
    expect(createFeishuEventDispatcher(config, options)).toBeInstanceOf(
      Lark.EventDispatcher,
    );
  });

  it("does not let a failing application log sink interrupt the SDK", () => {
    const logger = createFeishuSdkLogger(
      {
        error: () => {
          throw new Error("sink failed");
        },
        warn: () => {
          throw new Error("sink failed");
        },
        info: () => {
          throw new Error("sink failed");
        },
      },
      [config.appSecret],
    );

    expect(() => logger.error(config.appSecret)).not.toThrow();
    expect(() => logger.warn(config.appSecret)).not.toThrow();
    expect(() => logger.info(config.appSecret)).not.toThrow();
  });
});

describe("FeishuMessageClient", () => {
  it.each(["email", "open_id"] as const)(
    "sends an interactive card using %s",
    async (receiveIdType) => {
      const sdk = transport();
      const client = new FeishuMessageClient(sdk);
      const card = { schema: "2.0", body: { elements: [] } };

      await expect(
        client.sendInteractiveCard({
          receiveIdType,
          receiveId: "recipient",
          card,
          idempotencyKey: "delivery-id",
        }),
      ).resolves.toEqual({ messageId: "om_test_message" });
      expect(sdk.create).toHaveBeenCalledWith({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: "recipient",
          msg_type: "interactive",
          content: JSON.stringify(card),
          uuid: "delivery-id",
        },
      });
    },
  );

  it("updates a card by message id", async () => {
    const sdk = transport();
    const client = new FeishuMessageClient(sdk);
    const card = { schema: "2.0", body: { elements: [] } };

    await expect(
      client.updateInteractiveCard({ messageId: "om_test", card }),
    ).resolves.toBeUndefined();
    expect(sdk.patch).toHaveBeenCalledWith({
      path: { message_id: "om_test" },
      data: { content: JSON.stringify(card) },
    });
  });

  it("strictly rejects non-zero and incomplete SDK responses", async () => {
    const rejected = new FeishuMessageClient(
      transport({ createResponse: { code: 230001, msg: "denied" } }),
    );
    const incomplete = new FeishuMessageClient(
      transport({ createResponse: { code: 0, data: {} } }),
    );
    const invalidPatch = new FeishuMessageClient(
      transport({ patchResponse: { data: {} } }),
    );

    await expect(
      rejected.sendInteractiveCard({
        receiveIdType: "email",
        receiveId: "user@example.com",
        card: {},
      }),
    ).rejects.toMatchObject({
      reason: "api_rejected",
      code: 230001,
    });
    await expect(
      incomplete.sendInteractiveCard({
        receiveIdType: "email",
        receiveId: "user@example.com",
        card: {},
      }),
    ).rejects.toMatchObject({
      reason: "invalid_response",
    });
    await expect(
      invalidPatch.updateInteractiveCard({ messageId: "om_test", card: {} }),
    ).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });

  it("maps raw SDK failures without retaining sensitive details", async () => {
    const client = new FeishuMessageClient(
      transport({
        createError: new Error(
          `request failed with app_secret=${config.appSecret}`,
        ),
      }),
    );

    let error: unknown;
    try {
      await client.sendInteractiveCard({
        receiveIdType: "open_id",
        receiveId: "ou_test",
        card: {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FeishuApiError);
    expect(error).toMatchObject({ reason: "transport_failure", code: null });
    expect(String(error)).not.toContain(config.appSecret);
    expect(error).not.toHaveProperty("cause");
  });

  it("preserves a Feishu API code from an SDK HTTP rejection", async () => {
    const client = new FeishuMessageClient(
      transport({
        createError: {
          response: {
            status: 400,
            data: {
              code: 230099,
              msg: `invalid card with app_secret=${config.appSecret}`,
            },
          },
        },
      }),
    );

    let error: unknown;
    try {
      await client.sendInteractiveCard({
        receiveIdType: "open_id",
        receiveId: "ou_test",
        card: {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FeishuApiError);
    expect(error).toMatchObject({ reason: "api_rejected", code: 230099 });
    expect(String(error)).not.toContain(config.appSecret);
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects non-object cards before calling the SDK", async () => {
    const sdk = transport();
    const client = new FeishuMessageClient(sdk);

    await expect(
      client.sendInteractiveCard({
        receiveIdType: "email",
        receiveId: "user@example.com",
        card: null,
      }),
    ).rejects.toMatchObject({
      reason: "invalid_request",
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("rejects a configured but empty idempotency key", async () => {
    const sdk = transport();
    const client = new FeishuMessageClient(sdk);

    await expect(
      client.sendInteractiveCard({
        receiveIdType: "email",
        receiveId: "user@example.com",
        card: {},
        idempotencyKey: "  ",
      }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
