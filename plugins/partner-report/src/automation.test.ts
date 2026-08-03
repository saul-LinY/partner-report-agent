import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, type ReadyJob } from "./automation.js";
import {
  COLLECTION_MODEL,
  COLLECTION_REASONING_EFFORT,
  SCHEDULED_COLLECTION_TASK,
} from "./collection-config.js";

describe("automatic Codex execution", () => {
  it("uses an isolated read-only run without lifecycle hooks", () => {
    const job: ReadyJob = {
      status: "ready",
      kind: "EXTRACT_SESSION_FACTS",
      jobId: "job-1",
      inputPath: "/private/tmp/partner-report/local-job-input.json",
      resultPath: "/private/tmp/partner-report/local-job-result.json",
      schemaPath: "/plugin/schemas/session-fact-upload-v1.json",
    };

    const args = buildCodexExecArgs(job);
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "--model",
        "gpt-5.6-sol",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "hooks",
        "apps",
        "plugins",
        "remote_plugin",
        "shell_tool",
        "multi_agent",
        "--config",
        'web_search="disabled"',
        "mcp_servers={}",
        'developer_instructions=""',
        'model_reasoning_effort="medium"',
        "--output-schema",
        job.schemaPath,
        "--output-last-message",
        job.resultPath,
      ]),
    );
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain(job.inputPath);
    expect(args).not.toContain("--project");
  });

  it("keeps the scheduled task and isolated extraction model aligned", () => {
    expect(SCHEDULED_COLLECTION_TASK).toEqual({
      name: "Partner Report daily collection",
      destination: "new_chat",
      project: null,
      schedule: {
        rrule: "RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=0",
        timezone: "Asia/Shanghai",
      },
      model: COLLECTION_MODEL,
      reasoningEffort: COLLECTION_REASONING_EFFORT,
      notifications: "failures_only",
      prompt:
        "Use $partner-report-sync to run daily-collect and return only the safe collection summary.",
    });
  });

  it("refuses a structured job without an output schema", () => {
    expect(() =>
      buildCodexExecArgs({
        status: "ready",
        kind: "EXTRACT_SESSION_FACTS",
        jobId: "job-2",
        inputPath: "/private/tmp/input.json",
        resultPath: "/private/tmp/result.json",
      }),
    ).toThrow("has no output schema");
  });
});
