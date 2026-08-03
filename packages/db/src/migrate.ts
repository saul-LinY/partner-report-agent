import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db } from "./index.js";

await migrate(db, { migrationsFolder: resolve(process.cwd(), "packages/db/migrations") });
await closeDatabase();
console.log("Database migrations applied.");
