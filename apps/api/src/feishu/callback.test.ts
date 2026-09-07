import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { sqlClient } from "@partner-report/db";
import { createFeishuEventDispatcher } from "./client.js";
import { FeishuDeliveryService } from "./delivery.js";
import {
  FEISHU_CALLBACK_RESPONSE_TIMEOUT_MS,
  FeishuGateway,
} from "./gateway.js";

const config = { appId: "cli_callback_test", appSecret: "test-secret" };

function fixture() {
  const database = vi.fn(async (): Promise<Array<{ id: string }>> => [
    { id: randomUUID() },
  ]);
  const messageClient = {
    sendInteractiveCard: vi.fn(),
    updateInteractiveCard: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deliveries = new FeishuDeliveryService({
    appId: config.appId,
    messageClient,
  });
  const gateway = new FeishuGateway(config, messageClient, deliveries, {
    database: database as unknown as typeof sqlClient,
    logger,
  });
  const kick = vi.fn();
  gateway.setKickHandler(kick);
  const event = {
    event_id: randomUUID(),
    event_type: "card.action.trigger",
    app_id: config.appId,
    operator: { open_id: "ou_callback_test" },
    action: {
      value: {
        deliveryId: randomUUID(),
        aggregateId: randomUUID(),
        itemId: randomUUID(),
        baseVersion: 1,
        action: "review_approve",
      },
    },
    context: { open_message_id: "om_callback_test" },
  };
  return { database, messageClient, logger, deliveries, gateway, kick, event };
}

afterEach(() => vi.useRealTimers());

describe("Feishu callback response contract", () => {
  it.each([
    "review_approve",
    "review_exclude",
    "review_regenerate",
    "scope_submit",
    "binding_confirm",
    "recovery_confirm",
  ])(
    "returns a toast through the real SDK dispatcher for %s",
    async (action) => {
      const { gateway, database, messageClient, event } = fixture();
      const dispatcher = createFeishuEventDispatcher(config);
      dispatcher.register<{
        "card.action.trigger": (data: unknown) => Promise<unknown>;
      }>({ "card.action.trigger": (data) => gateway.acceptCardAction(data) });
      const { event_id, event_type, app_id, ...body } = event;
      const { itemId, ...value } = body.action.value;
      const response = await dispatcher.invoke(
        {
          schema: "2.0",
          header: { event_id, event_type, app_id },
          event: {
            ...body,
            token: "callback-token-must-not-be-persisted",
            action: {
              value: {
                ...value,
                ...(action.startsWith("review_") ? { itemId } : {}),
                action,
              },
            },
          },
        },
        { needCheck: false },
      );
      expect(response).toEqual({
        toast: { type: "success", content: "已收到，正在处理。" },
      });
      expect(database).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(database.mock.calls)).not.toContain(
        "callback-token",
      );
      expect(messageClient.updateInteractiveCard).not.toHaveBeenCalled();
      expect(messageClient.sendInteractiveCard).not.toHaveBeenCalled();
    },
  );

  it("acknowledges a slow write before Feishu's deadline and finishes enqueueing", async () => {
    vi.useFakeTimers();
    const { gateway, database, logger, kick, event } = fixture();
    let complete!: (rows: Array<{ id: string }>) => void;
    database.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const response = gateway.acceptCardAction(event);
    await vi.advanceTimersByTimeAsync(FEISHU_CALLBACK_RESPONSE_TIMEOUT_MS);
    await expect(response).resolves.toMatchObject({ toast: { type: "info" } });
    expect(FEISHU_CALLBACK_RESPONSE_TIMEOUT_MS).toBeLessThan(3_000);
    expect(kick).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.event_id }),
      "Feishu callback response deadline reached",
    );
    complete([{ id: randomUUID() }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "accepted",
        afterResponseDeadline: true,
      }),
      "Feishu callback acceptance completed",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "handles database rejection afterDeadline=%s without leaking payloads",
    async (late) => {
      vi.useFakeTimers();
      const { gateway, database, logger, kick, event } = fixture();
      let fail!: (error: Error) => void;
      database.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
      const response = gateway.acceptCardAction(event);
      await vi.advanceTimersByTimeAsync(
        late ? FEISHU_CALLBACK_RESPONSE_TIMEOUT_MS : 0,
      );
      fail(
        new Error("postgres://private-user:private-password@db callback-token"),
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(response).resolves.toMatchObject({
        toast: { type: late ? "info" : "error" },
      });
      expect(kick).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          afterResponseDeadline: late,
          errorCode: "FEISHU_ACTION_FAILED",
        }),
        "Feishu callback acceptance failed",
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /private-password|callback-token/,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("also bounds scope-form recovery before the inbox write", async () => {
    vi.useFakeTimers();
    const { gateway, deliveries, database, event } = fixture();
    let complete!: (value: null) => void;
    vi.spyOn(deliveries, "resolveScopeFormAction").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const response = gateway.acceptCardAction({
      ...event,
      action: { name: "scope_submit" },
    });
    await vi.advanceTimersByTimeAsync(FEISHU_CALLBACK_RESPONSE_TIMEOUT_MS);
    await expect(response).resolves.toMatchObject({ toast: { type: "info" } });
    complete(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(database).not.toHaveBeenCalled();
  });

  it("acknowledges duplicates without issuing another card update", async () => {
    vi.useFakeTimers();
    const { gateway, database, event, messageClient } = fixture();
    database.mockResolvedValueOnce([]);
    await expect(gateway.acceptCardAction(event)).resolves.toEqual({
      toast: { type: "success", content: "该操作已经收到，请勿重复点击。" },
    });
    expect(messageClient.updateInteractiveCard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
