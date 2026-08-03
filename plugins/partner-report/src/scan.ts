import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PluginConfig } from "./config.js";
import { CodexAppServer } from "./app-server.js";
import { setState } from "./database.js";

type ProjectPolicy = {
  id: string;
  name: string;
  aliases: string[];
  allowed_paths: string[];
};
type ServerPolicy = {
  team: {
    evidence_excerpt_enabled: boolean;
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

export function isCompleteTurn(turn: ProgressTurn) {
  const interrupted = new Set([
    "cancelled",
    "canceled",
    "failed",
    "interrupted",
    "in_progress",
  ]);
  return Boolean(
    turn.userPrompt?.trim() &&
    turn.assistantFinal?.trim() &&
    !interrupted.has(turn.status?.toLowerCase() ?? ""),
  );
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

export function mappedProject(cwd: string, projects: ProjectPolicy[]) {
  const matches = projects.flatMap((project) =>
    project.allowed_paths
      .filter((root) => isAbsolute(root) && withinPath(cwd, root))
      .map((root) => {
        const normalizedRoot = resolve(root);
        return {
          project,
          rootLength: normalizedRoot.length,
          matchMethod:
            resolve(cwd) === normalizedRoot
              ? ("exact_root" as const)
              : ("descendant_path" as const),
          rootFingerprint: hash({
            projectId: project.id,
            root: normalizedRoot,
          }),
        };
      }),
  );
  matches.sort((left, right) => right.rootLength - left.rootLength);
  const match = matches[0];
  return match
    ? {
        ...match.project,
        matchMethod: match.matchMethod,
        rootFingerprint: match.rootFingerprint,
      }
    : null;
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
      const lastActivityAt = updatedAt;
      const observedActivityAt = new Date(
        lastActivityAt || Date.now(),
      ).toISOString();
      db.prepare(
        `
        insert into session_activity (
          session_id, latest_turn_id, cwd, model, last_event_name, last_activity_at,
          quiet_until, processing_state, generation, updated_at
        ) values (?, null, ?, null, 'WEEKLY_DISCOVERY', ?, ?, 'DIRTY', 1, ?)
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
        observedActivityAt,
        new Date().toISOString(),
      );
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
      const newTurns = incremental.turns.filter(isCompleteTurn);
      if (newTurns.length === 0) {
        const hasIncompleteTurn = incremental.turns.length > 0;
        inventory(
          db,
          sessionId,
          cwd,
          project.id,
          hasIncompleteTurn ? "awaiting_complete_turn" : "synced",
          hasIncompleteTurn ? "INCOMPLETE_TURN_SKIPPED" : null,
        );
        db.prepare(
          "update session_activity set processing_state = ?, updated_at = ? where session_id = ?",
        ).run(
          hasIncompleteTurn ? "DIRTY" : "CLEAN",
          new Date().toISOString(),
          sessionId,
        );
        if (hasIncompleteTurn) stats.deferred += 1;
        else stats.unchanged += 1;
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
            matchMethod: project.matchMethod,
            rootFingerprint: project.rootFingerprint,
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
          project: {
            id: project.id,
            matchMethod: project.matchMethod,
            rootFingerprint: project.rootFingerprint,
          },
          factOrigin: "ai_extracted",
          production: {
            skillVersion: "partner-report-sync/0.2.0",
            promptVersion: "2026-08-03.v3",
            schemaVersion: "1.0",
            producer: "codex-skill",
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
