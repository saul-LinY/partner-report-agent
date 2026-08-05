const localDatabaseUrl =
  "postgres://partner_report:partner_report@localhost:54329/partner_report";

export function resolveDatabaseUrl(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "DATABASE_URL" | "NODE_ENV">
  > = process.env,
) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required when NODE_ENV=production");
  }
  return localDatabaseUrl;
}
