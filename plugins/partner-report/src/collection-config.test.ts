import { describe, expect, it } from "vitest";
import { SCHEDULED_COLLECTION_PROMPT } from "./collection-config.js";

describe("scheduled collection prompt", () => {
  it("uses Chinese instructions and documents the safe memory boundary", () => {
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("首次运行只采集最近 1 天");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("必须使用中文");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("automation memory");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("插件本地状态和中台哈希");
    expect(SCHEDULED_COLLECTION_PROMPT).not.toContain(
      "Use $partner-report-sync",
    );
  });
});
