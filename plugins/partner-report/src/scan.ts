import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PluginConfig } from "./config.js";
import { CodexAppServer } from "./app-server.js";
import { setState, type SessionActivity } from "./database.js";

type ProjectPolicy = {
  id: string;
  name: string;
  aliases: string[];
  allowed_paths: string[];
};
type ServerPolicy = {
  team: {
    evidence_excerpt_enabled: boolean;
    session_quiet_period_minutes?: number;
  };
  projects: ProjectPolicy[];
  currentPeriod: {
    id: string;
    period_key: string;
    starts_at: string;
    ends_at: string;
  } | null;
};

const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{8,}/gi,
];

export function redactSensitive(value: string) {
  let text = value;
  let replacements = 0;
  for (const pattern of secretPatterns) {
    text = text.replace(pattern, () => {
      replacements += 1;
      return "[REDACTED_SECRET]";
    });
  }
  return { text, replacements };
}

export function containsSensitive(value: unknown): boolean {
  const text = JSON.stringify(value);
  return secretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function withinPath(candidate: string, root: string) {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  return (
    normalizedCandidate === normalizedRoot ||
    (!relative(normalizedRoot, normalizedCandidate).startsWith(`..${sep}`) &&
      relative(normalizedRoot, normalizedCandidate) !== "..")
  );
}

function timestamp(value: unknown) {
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value !== "number") return 0;
  return value > 10_000_000_000 ? value : value * 1_000;
}

export function quietUntil(
  lastActivityAt: string | number,
  quietPeriodMinutes = 120,
) {
  return new Date(
    timestamp(lastActivityAt) + quietPeriodMinutes * 60_000,
  ).toISOString();
}

export function isSessionQuiet(
  lastActivityAt: string | number,
  quietPeriodMinutes = 120,
  now = Date.now(),
) {
  return timestamp(lastActivityAt) + quietPeriodMinutes * 60_000 <= now;
}

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [];
    })
    .join("\n");
}

function safeText(value: string, maxLength = 16_000) {
  return redactSensitive(value).text.slice(0, maxLength);
}

export type ProgressTurn = {
  id: string;
  status: string | null;
  userPrompt: string | null;
  assistantFinal: string | null;
};

export function normalizeProgressTurns(turns: any[]): ProgressTurn[] {
  return turns
    .filter((turn) => turn?.id != null)
    .map((turn) => {
      const items = Array.isArray(turn.items) ? turn.items : [];
      const userPrompt = safeText(
        items
          .filter((item: any) => item?.type === "userMessage")
          .map((item: any) => textContent(item.content))
          .filter(Boolean)
          .join("\n\n"),
      );
      const assistantFinal = safeText(
        items
          .filter(
            (item: any) =>
              item?.type === "agentMessage" && item.phase === "final_answer",
          )
          .map((item: any) => (typeof item.text === "string" ? item.text : ""))
          .filter(Boolean)
          .at(-1) ?? "",
      );
      return {
        id: String(turn.id),
        status: typeof turn.status === "string" ? turn.status : null,
        userPrompt: userPrompt || null,
        assistantFinal: assistantFinal || null,
      };
    });
}

export function selectIncrementalTurns(
  turns: ProgressTurn[],
  lastTurnId?: string | null,
  force = false,
) {
  if (force)
    return { turns, mode: "full_rescan" as const, cursorMatched: true };
  if (!lastTurnId)
    return { turns, mode: "new_session" as const, cursorMatched: true };
  const cursorIndex = turns.findIndex((turn) => turn.id === lastTurnId);
  return {
    turns: cursorIndex >= 0 ? turns.slice(cursorIndex + 1) : turns,
    mode: "historical_session" as const,
    cursorMatched: cursorIndex >= 0,
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inventory(
  db: DatabaseSync,
  sessionId: string,
  cwd: string | null,
  projectId: string | null,
  status: string,
  reasonCode: string | null,
) {
  const now = new Date().toISOString();
  db.prepare(
    `
    insert into session_inventory (session_id, cwd, project_id, status, reason_code, observed_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict (session_id) do update set cwd = excluded.cwd, project_id = excluded.project_id,
      status = excluded.status, reason_code = excluded.reason_code, observed_at = excluded.observed_at, updated_at = excluded.updated_at
  `,
  ).run(sessionId, cwd, projectId, status, reasonCode, now, now);
}

function mappedProject(cwd: string, projects: ProjectPolicy[]) {
  const matches = projects.flatMap((project) =>
    project.allowed_paths
      .filter((root) => isAbsolute(root) && withinPath(cwd, root))
      .map((root) => ({ project, rootLength: resolve(root).length })),
  );
  matches.sort((left, right) => right.rootLength - left.rootLength);
  return matches[0]?.project ?? null;
}

export async function prepareSessionJobs(
  db: DatabaseSync,
  config: PluginConfig,
  policy: ServerPolicy,
  force = false,
) {
  if (!policy.currentPeriod)
    throw new Error("服务端没有开放的 Report Period。");
  const server = new CodexAppServer();
  const stats = {
    discovered: 0,
    excluded: 0,
    outOfPeriod: 0,
    deferred: 0,
    unchanged: 0,
    queued: 0,
    failedRead: 0,
    hookMissed: 0,
    warnings: [] as string[],
  };
  const activeForSession = db.prepare(
    "select 1 from local_jobs where session_id = ? and status not in ('SYNCED', 'CANCELLED') limit 1",
  );
  const cursorForSession = db.prepare(
    "select * from session_cursors where session_id = ?",
  );
  const activityForSession = db.prepare(
    "select * from session_activity where session_id = ?",
  );
  const quietPeriodMinutes = policy.team.session_quiet_period_minutes ?? 120;

  try {
    await server.connect();
    const threads = await server.listThreads();
    const periodStart = new Date(policy.currentPeriod.starts_at).getTime();
    const periodEnd = new Date(policy.currentPeriod.ends_at).getTime();

    for (const summary of threads) {
      const sessionId = String(summary.id);
      const cwd = typeof summary.cwd === "string" ? summary.cwd : "";
      stats.discovered += 1;

      if (
        config.excludedSessionIds.includes(sessionId) ||
        sessionId === process.env.CODEX_THREAD_ID
      ) {
        inventory(
          db,
          sessionId,
          cwd || null,
          null,
          "excluded",
          "SESSION_EXCLUDED",
        );
        stats.excluded += 1;
        continue;
      }
      if (cwd && config.excludedPaths.some((path) => withinPath(cwd, path))) {
        inventory(db, sessionId, cwd, null, "excluded", "PATH_EXCLUDED");
        stats.excluded += 1;
        continue;
      }
      const project = cwd ? mappedProject(cwd, policy.projects) : null;
      if (!project) {
        inventory(
          db,
          sessionId,
          cwd || null,
          null,
          "excluded",
          "PATH_NOT_ALLOWED",
        );
        stats.excluded += 1;
        continue;
      }
      const createdAt = timestamp(summary.createdAt);
      const updatedAt = timestamp(summary.updatedAt);
      if (
        (createdAt && createdAt > periodEnd) ||
        (updatedAt && updatedAt < periodStart)
      ) {
        inventory(db, sessionId, cwd, project.id, "excluded", "OUTSIDE_PERIOD");
        stats.outOfPeriod += 1;
        continue;
      }
      const activity = activityForSession.get(sessionId) as
        SessionActivity | undefined;
      const lastActivityAt = Math.max(
        updatedAt,
        timestamp(activity?.last_activity_at),
      );
      const observedActivityAt = new Date(
        lastActivityAt || Date.now(),
      ).toISOString();
      const dueAt = quietUntil(observedActivityAt, quietPeriodMinutes);
      if (!activity) stats.hookMissed += 1;
      db.prepare(
        `
        insert into session_activity (
          session_id, latest_turn_id, cwd, model, last_event_name, last_activity_at,
          quiet_until, processing_state, generation, updated_at
        ) values (?, null, ?, null, 'COMPENSATION_DISCOVERY', ?, ?, 'DIRTY', 1, ?)
        on conflict(session_id) do update set
          cwd = excluded.cwd,
          last_activity_at = excluded.last_activity_at,
          quiet_until = excluded.quiet_until,
          processing_state = case
            when session_activity.processing_state in ('CLEAN', 'DIRTY', 'QUIET_WAIT') then 'DIRTY'
            else session_activity.processing_state
          end,
          updated_at = excluded.updated_at
      `,
      ).run(
        sessionId,
        cwd || null,
        observedActivityAt,
        dueAt,
        new Date().toISOString(),
      );
      if (!force && !isSessionQuiet(observedActivityAt, quietPeriodMinutes)) {
        db.prepare(
          "update session_activity set processing_state = 'QUIET_WAIT', quiet_until = ?, updated_at = ? where session_id = ?",
        ).run(dueAt, new Date().toISOString(), sessionId);
        inventory(
          db,
          sessionId,
          cwd,
          project.id,
          "quiet_wait",
          "SESSION_ACTIVE",
        );
        stats.deferred += 1;
        continue;
      }
      if (activeForSession.get(sessionId)) {
        inventory(
          db,
          sessionId,
          cwd,
          project.id,
          "pending_extract",
          "LOCAL_JOB_EXISTS",
        );
        stats.unchanged += 1;
        continue;
      }

      let thread: any;
      try {
        thread = await server.readThread(sessionId);
      } catch {
        inventory(
          db,
          sessionId,
          cwd,
          project.id,
          "failed_read",
          "THREAD_READ_FAILED",
        );
        stats.failedRead += 1;
        continue;
      }
      const normalized = normalizeProgressTurns(
        Array.isArray(thread.turns) ? thread.turns : [],
      );
      if (normalized.length === 0) {
        inventory(db, sessionId, cwd, project.id, "excluded", "NO_TURNS");
        stats.excluded += 1;
        continue;
      }
      const cursor = cursorForSession.get(sessionId) as
        { last_turn_id: string; source_revision: number } | undefined;
      const incremental = selectIncrementalTurns(
        normalized,
        cursor?.last_turn_id,
        force,
      );
      if (cursor && !force && !incremental.cursorMatched)
        stats.warnings.push(`CURSOR_RESET:${sessionId}`);
      const newTurns = incremental.turns;
      if (newTurns.length === 0) {
        inventory(db, sessionId, cwd, project.id, "synced", null);
        db.prepare(
          "update session_activity set processing_state = 'CLEAN', updated_at = ? where session_id = ?",
        ).run(new Date().toISOString(), sessionId);
        stats.unchanged += 1;
        continue;
      }
      const sourceRevision = (cursor?.source_revision ?? 0) + 1;
      const sourceHash = hash({ sessionId, sourceRevision, turns: newTurns });
      const fromTurnId = newTurns[0]!.id;
      const toTurnId = newTurns.at(-1)!.id;
      const observedAt = new Date().toISOString();
      const input = {
        schemaVersion: "1.0",
        task: "EXTRACT_SESSION_FACTS",
        session: {
          id: sessionId,
          name: thread.name ?? summary.name ?? null,
          cwd,
          project: {
            id: project.id,
            name: project.name,
            aliases: project.aliases,
          },
          sourceRevision,
          sourceHash,
          fromTurnId,
          toTurnId,
          observedAt,
          incremental: {
            mode: incremental.mode,
            previousTurnId: cursor?.last_turn_id ?? null,
            cursorMatched: incremental.cursorMatched,
          },
          turns: newTurns,
        },
        period: policy.currentPeriod,
        extractionPolicy: {
          evidenceExcerptEnabled: Boolean(policy.team.evidence_excerpt_enabled),
          evidenceExcerptMaxLength: 240,
          completedRequiresEvidence: true,
          fullTranscriptMustNotBeReturned: true,
          inputContent: ["user_prompt", "assistant_final"],
          ignoredContent: [
            "reasoning",
            "commentary",
            "commands",
            "tool_calls",
            "file_changes",
          ],
        },
        outputRequirements: {
          status: "extracted",
          factOrigin: "ai_extracted",
          production: {
            skillVersion: "partner-report-sync/0.1.0",
            promptVersion: "2026-08-03.v2",
            schemaVersion: "1.0",
            producer: "codex-skill",
            ...(process.env.CODEX_MODEL
              ? { modelVersion: process.env.CODEX_MODEL }
              : {}),
          },
        },
      };
      const jobId = randomUUID();
      db.prepare(
        `
        insert into local_jobs (
          id, type, status, session_id, source_revision, from_turn_id, to_turn_id,
          source_hash, input_json, created_at, updated_at
        ) values (?, 'EXTRACT_SESSION_FACTS', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        jobId,
        sessionId,
        sourceRevision,
        fromTurnId,
        toTurnId,
        sourceHash,
        JSON.stringify(input),
        observedAt,
        observedAt,
      );
      db.prepare(
        "update session_activity set latest_turn_id = ?, processing_state = 'PENDING_EXTRACT', updated_at = ? where session_id = ?",
      ).run(toTurnId, observedAt, sessionId);
      inventory(db, sessionId, cwd, project.id, "pending_extract", null);
      stats.queued += 1;
    }
    setState(db, "hook_missed_at_scan", String(stats.hookMissed));
    db.prepare(
      "update hook_outbox set processed_at = ? where processed_at is null",
    ).run(new Date().toISOString());
    setState(db, "last_scan_at", new Date().toISOString());
    setState(db, "last_scan_stats", JSON.stringify(stats));
    return stats;
  } finally {
    server.close();
  }
}
