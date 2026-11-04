// The shared database client lives here so modules can import it without a cycle through index.ts.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { resolveDatabaseUrl } from "./config.js";

const connectionUrl = resolveDatabaseUrl();

export const sqlClient = postgres(connectionUrl, {
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sqlClient, { schema });
