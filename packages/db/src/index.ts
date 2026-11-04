import { sqlClient } from "./client.js";

export { sqlClient, db } from "./client.js";
export * from "./schema.js";
export * from "./period.js";
export * from "./config.js";
export * from "./project-scope-projects.js";
export { dispatchAppNotifications, suppressedAppNotificationKinds } from "./app-notifications.js";
export { enqueueCollectorUpload, collectorSessionKey, loadCollectorPipeline } from "./collector-pipeline.js";
export * from "./inspection-rules.js";
export * from "./inspection.js";

export async function closeDatabase() {
  await sqlClient.end();
}
export * from "./session-judge.js";
export * from "./latest-sessions.js";
export * from "./session-preprocess.js";
