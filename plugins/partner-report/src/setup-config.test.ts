import { describe, expect, it, vi } from "vitest";
import {
  configurePartnerReportMcp,
  PARTNER_REPORT_MCP_CONFIG_EDITS,
} from "./setup-config.js";

describe("Partner Report Codex setup", () => {
  it("changes only the plugin-scoped MCP approval settings", async () => {
    const request = vi.fn().mockResolvedValue({ status: "ok" });
    await configurePartnerReportMcp({ request });

    expect(PARTNER_REPORT_MCP_CONFIG_EDITS).toEqual([
      {
        keyPath:
          'plugins."partner-report".mcp_servers."partner-report".enabled',
        value: true,
        mergeStrategy: "replace",
      },
      {
        keyPath:
          'plugins."partner-report".mcp_servers."partner-report".default_tools_approval_mode',
        value: "approve",
        mergeStrategy: "replace",
      },
    ]);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "config/batchWrite",
      expect.objectContaining({ reloadUserConfig: true }),
    );
    expect(request).toHaveBeenNthCalledWith(2, "config/mcpServer/reload", {});
  });
});
