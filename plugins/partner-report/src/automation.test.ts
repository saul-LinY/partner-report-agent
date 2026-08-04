import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectionWorkDirectory,
  maximumCollectionJobs,
} from "./automation.js";
import {
  DEFAULT_COLLECTION_MODEL,
  DEFAULT_COLLECTION_REASONING_EFFORT,
  SCHEDULED_COLLECTION_PROMPT,
  SCHEDULED_COLLECTION_TASK,
  SCHEDULED_CONTINUATION_TASK,
} from "./collection-config.js";

describe("scheduled collection", () => {
  it("uses model settings only as first-task defaults", () => {
    expect(SCHEDULED_COLLECTION_TASK).toEqual({
      name: "Partner Report daily collection",
      destination: "new_chat",
      project: null,
      schedule: {
        rrule: "RRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=30",
        timezone: "Asia/Shanghai",
      },
      model: DEFAULT_COLLECTION_MODEL,
      reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
      notifications: "failures_only",
      prompt: SCHEDULED_COLLECTION_PROMPT,
    });
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "Collect only eligible local Codex sessions",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain("upload only those facts");
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "Do not create or update automation memory",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).toContain(
      "never store Session content, Facts, evidence",
    );
    expect(SCHEDULED_COLLECTION_PROMPT).not.toContain("consent");
  });

  it("defines an isolated two-minute continuation task", () => {
    expect(SCHEDULED_CONTINUATION_TASK).toMatchObject({
      destination: "new_chat",
      project: null,
      schedule: {
        rrule: "RRULE:FREQ=MINUTELY;INTERVAL=2",
        timezone: "Asia/Shanghai",
      },
      notifications: "failures_only",
    });
    expect(SCHEDULED_CONTINUATION_TASK.prompt).toContain("continuation");
  });

  it("does not launch a nested Codex model", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "automation.ts"),
      "utf8",
    );
    expect(source).not.toContain("codex exec");
    expect(source).not.toContain("COLLECTION_MODEL");
    expect(source).not.toContain("model_reasoning_effort");
  });

  it("uses a private temporary work area and bounds each run", () => {
    expect(collectionWorkDirectory().startsWith(resolve(tmpdir()))).toBe(true);
    expect(maximumCollectionJobs()).toBeGreaterThanOrEqual(1);
    expect(maximumCollectionJobs()).toBeLessThanOrEqual(100);
  });
});
