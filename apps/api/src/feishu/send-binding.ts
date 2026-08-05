import { closeDatabase } from "@partner-report/db";
import { requireFeishuConfig } from "./config.js";
import { createFeishuDeliveryService } from "./delivery.js";

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value?.trim() || null;
}

async function main() {
  const email = argumentValue("--email");
  if (!email) {
    throw new Error("Usage: feishu:bind -- --email user@example.com");
  }
  const config = requireFeishuConfig();
  const service = createFeishuDeliveryService(config);
  const result = await service.sendBindingCardByEmail(email);
  console.log(
    JSON.stringify({
      email,
      outcome: result.outcome,
      deliveryId: result.deliveryId,
      messageId: result.messageId ?? null,
      reason: result.reason ?? null,
    }),
  );
}

try {
  await main();
} finally {
  await closeDatabase();
}
