import { PARTNER_REPORT_MCP_TOOL_TIMEOUT_SEC } from "./timeouts.js";

type ConfigClient = {
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

export const PARTNER_REPORT_MCP_CONFIG_EDITS = [
  {
    keyPath: 'plugins."partner-report".mcp_servers."partner-report".enabled',
    value: true,
    mergeStrategy: "replace",
  },
  {
    keyPath:
      'plugins."partner-report".mcp_servers."partner-report".default_tools_approval_mode',
    value: "approve",
    mergeStrategy: "replace",
  },
  {
    keyPath:
      'plugins."partner-report".mcp_servers."partner-report".tool_timeout_sec',
    value: PARTNER_REPORT_MCP_TOOL_TIMEOUT_SEC,
    mergeStrategy: "replace",
  },
] as const;

export async function configurePartnerReportMcp(
  client: ConfigClient,
  configFile?: string,
) {
  const response = await client.request("config/batchWrite", {
    edits: PARTNER_REPORT_MCP_CONFIG_EDITS,
    ...(configFile ? { filePath: configFile } : {}),
    reloadUserConfig: !configFile,
  });
  if (!configFile) await client.request("config/mcpServer/reload", {});
  return response;
}
