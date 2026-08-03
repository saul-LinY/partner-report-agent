import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, type ReadyJob } from "./automation.js";

describe("automatic Codex execution", () => {
  it("uses an isolated read-only run without lifecycle hooks", () => {
    const job: ReadyJob = {
      status: "ready",
      kind: "EXTRACT_SESSION_FACTS",
      jobId: "job-1",
      inputPath: "/private/tmp/partner-report/local-job-input.json",
      resultPath: "/private/tmp/partner-report/local-job-result.json",
      schemaPath: "/plugin/schemas/session-fact-upload-v1.json"
    };

    const args = buildCodexExecArgs(job, "gpt-5.6-sol");
    expect(args).toEqual(expect.arrayContaining([
      "exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--disable", "hooks", "--output-schema",
      job.schemaPath, "--output-last-message", job.resultPath
    ]));
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain(job.inputPath);
  });

  it("refuses a structured job without an output schema", () => {
    expect(() => buildCodexExecArgs({
      status: "ready",
      kind: "EXTRACT_SESSION_FACTS",
      jobId: "job-2",
      inputPath: "/private/tmp/input.json",
      resultPath: "/private/tmp/result.json"
    })).toThrow("has no output schema");
  });
});
