import { resolve } from "node:path";
import { CodexAppServer } from "./app-server.js";
import { migrateLegacyInstallation } from "./config.js";
import { configurePartnerReportMcp } from "./setup-config.js";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configFile = option("config-file");
const server = new CodexAppServer();

try {
  await server.connect();
  const config = await configurePartnerReportMcp(
    server,
    configFile ? resolve(configFile) : undefined,
  );
  const credentials = migrateLegacyInstallation();
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "partner_report_ready",
        scope: "partner-report MCP only",
        config,
        credentials,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "setup_failed",
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "PARTNER_REPORT_SETUP_FAILED",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  server.close();
}
