#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const useKeychain = process.platform === "darwin" && process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1";
const runtimeDataDir = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
const stableDataDir = process.env.PARTNER_REPORT_DATA || resolve(homedir(), ".partner-report-data");
const dataDir = resolve(useKeychain ? runtimeDataDir || stableDataDir : stableDataDir);
const databasePath = resolve(dataDir, "partner-report.sqlite");
let quietPeriodMinutes = Math.max(15, Number(process.env.PARTNER_REPORT_QUIET_PERIOD_MINUTES || 120));

function readInput() {
  return new Promise((resolveInput) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (body.length < 131072) body += chunk;
    });
    process.stdin.on("end", () => {
      try { resolveInput(JSON.parse(body || "{}")); } catch { resolveInput({}); }
    });
  });
}

try {
  const input = await readInput();
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  if (useKeychain && runtimeDataDir) {
    try {
      execFileSync("security", ["add-generic-password", "-a", "partner-report", "-s", "partner-report:data-directory", "-w", dataDir, "-U"], { stdio: "ignore" });
      const configPath = resolve(dataDir, "config.json");
      if (!existsSync(configPath)) {
        const bootstrap = execFileSync("security", ["find-generic-password", "-a", "partner-report", "-s", "partner-report:bootstrap-config", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const config = JSON.parse(bootstrap);
        if (typeof config.serverUrl === "string" && typeof config.pluginInstanceId === "string") {
          writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
          chmodSync(configPath, 0o600);
        }
      }
    } catch {
      // The event hint is still useful even if bootstrap state is unavailable.
    }
  }
  const db = new DatabaseSync(databasePath);
  db.exec(`
    pragma journal_mode = WAL;
    create table if not exists hook_outbox (
      id integer primary key autoincrement,
      event_name text not null,
      session_id text,
      turn_id text,
      cwd text,
      model text,
      created_at text not null,
      processed_at text
    );
    create table if not exists state (
      key text primary key,
      value text not null,
      updated_at text not null
    );
    create table if not exists session_activity (
      session_id text primary key,
      latest_turn_id text,
      cwd text,
      model text,
      last_event_name text not null,
      last_activity_at text not null,
      quiet_until text not null,
      processing_state text not null,
      generation integer not null default 1,
      updated_at text not null
    )
  `);
  if (!process.env.PARTNER_REPORT_QUIET_PERIOD_MINUTES) {
    try {
      const policyRow = db.prepare("select value from state where key = 'last_policy'").get();
      const configuredMinutes = Number(JSON.parse(policyRow?.value || "{}").team?.session_quiet_period_minutes);
      if (Number.isFinite(configuredMinutes)) quietPeriodMinutes = Math.max(15, Math.min(configuredMinutes, 1440));
    } catch {
      // The default remains in force until the first policy sync succeeds.
    }
  }
  const statement = db.prepare(`
    insert into hook_outbox (event_name, session_id, turn_id, cwd, model, created_at)
    values (?, ?, ?, ?, ?, ?)
  `);
  const observedAt = new Date().toISOString();
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;
  const turnId = typeof input.turn_id === "string" ? input.turn_id : null;
  const eventName = typeof input.hook_event_name === "string" ? input.hook_event_name : "unknown";
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  const model = typeof input.model === "string" ? input.model : null;
  db.prepare(`
    insert into state (key, value, updated_at) values ('last_hook_at', ?, ?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
  `).run(observedAt, observedAt);
  statement.run(
    eventName,
    sessionId,
    turnId,
    cwd,
    model,
    observedAt
  );
  if (sessionId) {
    const quietUntil = new Date(new Date(observedAt).getTime() + quietPeriodMinutes * 60_000).toISOString();
    db.prepare(`
      insert into session_activity (
        session_id, latest_turn_id, cwd, model, last_event_name, last_activity_at,
        quiet_until, processing_state, generation, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, 'DIRTY', 1, ?)
      on conflict(session_id) do update set
        latest_turn_id = coalesce(excluded.latest_turn_id, session_activity.latest_turn_id),
        cwd = coalesce(excluded.cwd, session_activity.cwd),
        model = coalesce(excluded.model, session_activity.model),
        last_event_name = excluded.last_event_name,
        last_activity_at = excluded.last_activity_at,
        quiet_until = excluded.quiet_until,
        processing_state = 'DIRTY',
        generation = session_activity.generation + 1,
        updated_at = excluded.updated_at
    `).run(sessionId, turnId, cwd, model, eventName, observedAt, quietUntil, observedAt);
  }
  db.close();
  chmodSync(databasePath, 0o600);

  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = resolve(pluginRoot, "dist/cli.mjs");
  const configPath = resolve(dataDir, "config.json");
  if (process.env.PARTNER_REPORT_AUTOMATION !== "1" && existsSync(cliPath) && existsSync(configPath)) {
    const runner = spawn(process.execPath, [cliPath, "runner"], {
      detached: true,
      env: { ...process.env, PLUGIN_ROOT: pluginRoot, PARTNER_REPORT_AUTOMATION: "1" },
      stdio: "ignore"
    });
    runner.unref();
  }
} catch {
  // Lifecycle hooks must never block Codex if local capture fails.
}

process.stdout.write("{}\n");
