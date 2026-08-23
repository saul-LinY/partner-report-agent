import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exposeJobInput, withNextTool } from "./mcp-output.js";

describe("MCP output adapter", () => {
  it("turns CLI continuation strings into structured MCP calls", () => {
    expect(
      withNextTool({
        status: "started",
        runPath: "/tmp/run.json",
        nextCommand: "collect-next --run /tmp/run.json",
      }),
    ).toEqual({
      status: "started",
      runPath: "/tmp/run.json",
      nextTool: {
        name: "collect_next",
        arguments: { runPath: "/tmp/run.json" },
      },
    });
  });

  it("binds a result submission to the current Job id", () => {
    expect(
      withNextTool({
        status: "job",
        runPath: "/tmp/run.json",
        jobId: "job-1",
        nextCommand:
          "collect-submit --run /tmp/run.json --result /tmp/result.json",
      }),
    ).toEqual({
      status: "job",
      runPath: "/tmp/run.json",
      jobId: "job-1",
      nextTool: {
        name: "collect_submit",
        arguments: { runPath: "/tmp/run.json", jobId: "job-1" },
      },
    });
  });

  it("returns Job input while hiding internal input and result paths", () => {
    const root = mkdtempSync(resolve(tmpdir(), "partner-report-mcp-output-"));
    const inputPath = resolve(root, "input.json");
    writeFileSync(inputPath, '{"prompt":"safe input"}\n');
    try {
      expect(
        exposeJobInput({
          status: "job",
          runPath: "/tmp/run.json",
          inputPath,
          resultPath: resolve(root, "result.json"),
          resultSchema: "/plugin/schema.json",
        }),
      ).toEqual({
        status: "job",
        runPath: "/tmp/run.json",
        jobInput: { prompt: "safe input" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
