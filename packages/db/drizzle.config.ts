import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/config.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/migrations",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
  strict: true,
  verbose: true,
});
