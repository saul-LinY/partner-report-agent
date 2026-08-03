import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionUrl =
  process.env.DATABASE_URL ??
  "postgres://partner_report:partner_report@localhost:54329/partner_report";

export const sqlClient = postgres(connectionUrl, {
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sqlClient, { schema });
export * from "./schema.js";
export * from "./period.js";

export async function closeDatabase() {
  await sqlClient.end();
}
