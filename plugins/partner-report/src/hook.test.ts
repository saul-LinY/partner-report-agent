import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("lifecycle hook", () => {
  it("stores only a local scan hint and ignores transcript content", () => {
    const pluginData = mkdtempSync(resolve(tmpdir(), "partner-report-hook-"));
    const hookPath = resolve(import.meta.dirname, "../hooks/capture-event.mjs");
    const secretTranscript = "raw transcript that must never be persisted";
    const output = execFileSync(process.execPath, [hookPath], {
      encoding: "utf8",
      env: { ...process.env, PLUGIN_DATA: pluginData, PARTNER_REPORT_DATA: pluginData, PARTNER_REPORT_ALLOW_FILE_TOKENS: "1" },
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-9",
        cwd: "/workspace/project",
        model: "gpt-5.6-sol",
        transcript_path: "/private/transcript.jsonl",
        transcript: secretTranscript
      })
    });
    expect(output.trim()).toBe("{}");

    const databasePath = resolve(pluginData, "partner-report.sqlite");
    expect(readFileSync(databasePath).includes(Buffer.from(secretTranscript))).toBe(false);
    const db = new DatabaseSync(databasePath);
    const row = db.prepare("select event_name, session_id, turn_id, cwd, model from hook_outbox").get();
    const activity = db.prepare("select * from session_activity where session_id = ?").get("session-1") as {
      latest_turn_id: string;
      processing_state: string;
      generation: number;
      last_activity_at: string;
      quiet_until: string;
    };
    const columns = db.prepare("pragma table_info(hook_outbox)").all() as Array<{ name: string }>;
    db.close();

    expect(row).toEqual({ event_name: "Stop", session_id: "session-1", turn_id: "turn-9", cwd: "/workspace/project", model: "gpt-5.6-sol" });
    expect(activity.latest_turn_id).toBe("turn-9");
    expect(activity.processing_state).toBe("DIRTY");
    expect(activity.generation).toBe(1);
    expect(new Date(activity.quiet_until).getTime() - new Date(activity.last_activity_at).getTime()).toBe(120 * 60_000);
    expect(columns.map((column) => column.name)).not.toContain("transcript_path");
    expect(columns.map((column) => column.name)).not.toContain("transcript");
  });

  it("restarts the quiet window when a later turn stops", () => {
    const pluginData = mkdtempSync(resolve(tmpdir(), "partner-report-hook-reset-"));
    const hookPath = resolve(import.meta.dirname, "../hooks/capture-event.mjs");
    const runHook = (turnId: string) => execFileSync(process.execPath, [hookPath], {
      encoding: "utf8",
      env: { ...process.env, PLUGIN_DATA: pluginData, PARTNER_REPORT_DATA: pluginData, PARTNER_REPORT_ALLOW_FILE_TOKENS: "1" },
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-2", turn_id: turnId })
    });

    runHook("turn-1");
    const db = new DatabaseSync(resolve(pluginData, "partner-report.sqlite"));
    const first = db.prepare("select quiet_until from session_activity where session_id = ?").get("session-2") as { quiet_until: string };
    runHook("turn-2");
    const second = db.prepare("select latest_turn_id, quiet_until, generation from session_activity where session_id = ?").get("session-2") as {
      latest_turn_id: string;
      quiet_until: string;
      generation: number;
    };
    db.close();

    expect(second.latest_turn_id).toBe("turn-2");
    expect(second.generation).toBe(2);
    expect(new Date(second.quiet_until).getTime()).toBeGreaterThanOrEqual(new Date(first.quiet_until).getTime());
  });
});
