import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://partner_report:partner_report@localhost:54329/partner_report"
  },
  strict: true,
  verbose: true
});
