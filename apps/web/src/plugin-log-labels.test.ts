import { describe, expect, it } from "vitest";
import {
  pluginCommandLabel,
  pluginExecutionKindLabel,
  pluginExecutionLabel,
} from "./plugin-log-labels.js";

describe("plugin log labels", () => {
  it("labels current collection commands without legacy wording", () => {
    expect(pluginCommandLabel("collection")).toBe("采集批次");
    expect(
      pluginExecutionLabel({ grouping: "invocation", command: "collection" }),
    ).toBe("采集批次");
  });

  it("distinguishes fallback runs from ungrouped history", () => {
    expect(
      pluginExecutionLabel({ grouping: "run", command: "collection" }),
    ).toBe("定时采集");
    expect(pluginExecutionKindLabel("run")).toBe("本次定时采集");
    expect(pluginExecutionKindLabel("legacy")).toBe("历史日志");
  });
});
