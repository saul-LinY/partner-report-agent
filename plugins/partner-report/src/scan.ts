import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { PLUGIN_VERSION } from "./config.js";

export type ProjectPolicy = {
  id: string;
  name: string;
  aliases?: string[];
  allowed_paths: string[];
  external_ids?: string[];
};

export type ProjectIdentity = {
  id: string | null;
  name: string;
  matchMethod:
    "exact_root" | "descendant_path" | "path_discovered" | "unassigned";
  rootFingerprint: string;
  rootName?: string;
  scopeKey?: string;
};

export type ProgressTurn = {
  id: string;
  status: string | null;
  occurredAt: string | null;
  userPrompt: string | null;
  assistantFinal: string | null;
};

export type CollectionPeriod = {
  period_key: string;
  starts_at: string;
  ends_at: string;
};

const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{8,}/gi,
];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function redactSensitive(value: string) {
  let text = value;
  let replacements = 0;
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
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

function safeText(value: string, maxLength?: number) {
  const text = redactSensitive(value).text;
  return maxLength === undefined ? text : text.slice(0, maxLength);
}

function timestamp(value: unknown) {
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value !== "number") return Number.NaN;
  return value > 10_000_000_000 ? value : value * 1_000;
}

function toIso(value: unknown) {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
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
        occurredAt: toIso(turn.completedAt ?? turn.updatedAt ?? turn.createdAt),
        userPrompt: userPrompt || null,
        assistantFinal: assistantFinal || null,
      };
    });
}

export function isCompleteTurn(turn: ProgressTurn) {
  const incomplete = new Set([
    "cancelled",
    "canceled",
    "failed",
    "interrupted",
    "in_progress",
  ]);
  return Boolean(
    turn.userPrompt?.trim() &&
    turn.assistantFinal?.trim() &&
    !incomplete.has(turn.status?.toLowerCase() ?? ""),
  );
}

export function completeSessionTurns(turns: ProgressTurn[]) {
  return turns.filter(isCompleteTurn);
}

export function latestCompleteTurnInPeriod(
  turns: ProgressTurn[],
  period: CollectionPeriod,
  fallbackOccurredAt?: string,
) {
  const startsAt = new Date(period.starts_at).getTime();
  const endsAt = new Date(period.ends_at).getTime();
  const complete = completeSessionTurns(turns);
  const latest = complete.reduce<ProgressTurn | null>((candidate, turn) => {
    const candidateAt = new Date(
      candidate?.occurredAt ?? fallbackOccurredAt ?? "",
    ).getTime();
    const occurredAt = new Date(
      turn.occurredAt ?? fallbackOccurredAt ?? "",
    ).getTime();
    if (!Number.isFinite(occurredAt)) return candidate;
    return !candidate || occurredAt >= candidateAt ? turn : candidate;
  }, null);
  if (!latest) return null;
  const occurredAt = new Date(
    latest.occurredAt ?? fallbackOccurredAt ?? "",
  ).getTime();
  return Number.isFinite(occurredAt) &&
    occurredAt >= startsAt &&
    occurredAt <= endsAt
    ? latest
    : null;
}

export function isPluginSystemThread(summary: Record<string, unknown>) {
  const name = [summary.name, summary.title]
    .find((value) => typeof value === "string")
    ?.trim()
    .toLowerCase();
  if (!name) return false;
  return (
    name === "partner report daily collection" ||
    name === "配置插件定时任务" ||
    name === "连接数据中台与绑定码" ||
    name === "连接设备到本地服务" ||
    name === "connect partner report" ||
    name.startsWith("查看已安装插件") ||
    name.startsWith("连接数据中台与 partner-report")
  );
}

export function isOfficialAutomationThread(summary: Record<string, unknown>) {
  if (summary.ephemeral === true || summary.transient === true) return true;
  const threadSource = [summary.threadSource, summary.thread_source]
    .find((value) => typeof value === "string")
    ?.trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  if (
    threadSource === "automation" ||
    threadSource === "scheduledtask" ||
    threadSource === "systemtask"
  )
    return true;
  const source = summary.source;
  const sourceRecord =
    source && typeof source === "object"
      ? (source as Record<string, unknown>)
      : null;
  const values = [
    typeof source === "string" ? source : null,
    summary.sourceKind,
    summary.source_kind,
    summary.origin,
    sourceRecord?.type,
    sourceRecord?.kind,
    sourceRecord?.origin,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, ""),
    );
  return values.some((value) =>
    ["automation", "scheduledtask", "systemtask"].includes(value),
  );
}

export function isPluginAdministrationSession(turns: ProgressTurn[]) {
  const prompts = turns
    .map((turn) => turn.userPrompt?.trim())
    .filter((value): value is string => Boolean(value));
  if (prompts.length === 0) return false;
  const allText = prompts.join("\n").toLowerCase();
  const mentionsPartnerReport = /partner[ -]report/.test(allText);
  const onlyDirectSkillInvocations = prompts.every(
    (prompt) =>
      prompt.replace(/[`\s]/g, "").toLowerCase() === "$partner-report-sync",
  );
  const administration =
    /(安装|卸载|启用|禁用|绑定|连接|配置|定时任务|验证码|授权码|换绑|已安装|有哪些插件|查看.*插件|install|uninstall|enable|disable|bind|connect|configure|scheduled task)/i;
  return (
    onlyDirectSkillInvocations ||
    (mentionsPartnerReport &&
      prompts.every((prompt) => administration.test(prompt)))
  );
}

function withinPath(candidate: string, root: string) {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function nearestGitRoot(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function mappedProject(
  cwd: string | null | undefined,
  projects: ProjectPolicy[],
  stableScope?: { pluginInstanceId: string; scopeKey: string },
): ProjectIdentity {
  if (!cwd) {
    return {
      id: null,
      name: "独立工作",
      matchMethod: "unassigned",
      rootFingerprint: sha256("unassigned"),
    };
  }

  const absoluteCwd = resolve(cwd);
  if (stableScope) {
    const discoveredRoot = nearestGitRoot(absoluteCwd) ?? absoluteCwd;
    const rootFingerprint = sha256(discoveredRoot);
    const stableExternalId = `scope:${stableScope.pluginInstanceId}:${stableScope.scopeKey}`;
    const known = projects.find((project) =>
      (project.external_ids ?? []).includes(stableExternalId),
    );
    if (known) {
      return {
        id: known.id,
        name: known.name,
        matchMethod:
          discoveredRoot === absoluteCwd ? "exact_root" : "descendant_path",
        rootFingerprint,
      };
    }
    const rootName = basename(discoveredRoot) || "项目";
    return {
      id: null,
      name: rootName,
      matchMethod: "path_discovered",
      rootFingerprint,
      rootName,
    };
  }

  const configuredMatches = projects
    .flatMap((project) =>
      (project.allowed_paths ?? [])
        .filter((root) => withinPath(absoluteCwd, root))
        .map((root) => ({ project, root: resolve(root) })),
    )
    .sort((left, right) => right.root.length - left.root.length);
  const configured = configuredMatches[0];
  if (configured) {
    return {
      id: configured.project.id,
      name: configured.project.name,
      matchMethod:
        configured.root === absoluteCwd ? "exact_root" : "descendant_path",
      rootFingerprint: sha256(configured.root),
    };
  }

  const discoveredRoot = nearestGitRoot(absoluteCwd) ?? absoluteCwd;
  const rootFingerprint = sha256(discoveredRoot);
  const known = projects.find((project) =>
    (project.external_ids ?? []).includes(`path-sha256:${rootFingerprint}`),
  );
  if (known) {
    return {
      id: known.id,
      name: known.name,
      matchMethod:
        discoveredRoot === absoluteCwd ? "exact_root" : "descendant_path",
      rootFingerprint,
    };
  }
  const rootName = basename(discoveredRoot) || "项目";
  return {
    id: null,
    name: rootName,
    matchMethod: "path_discovered",
    rootFingerprint,
    rootName,
  };
}

export function pathIsExcluded(
  cwd: string | null | undefined,
  excludedPaths: string[],
) {
  return Boolean(cwd && excludedPaths.some((root) => withinPath(cwd, root)));
}

export function anonymousSessionKey(
  pluginInstanceId: string,
  sessionId: string,
) {
  return sha256(`partner-report/session/v1:${pluginInstanceId}:${sessionId}`);
}

export function buildSessionJob(input: {
  pluginInstanceId: string;
  sessionId: string;
  title?: string | null;
  cwd?: string | null;
  updatedAt?: string | number | null;
  turns: any[];
  projects: ProjectPolicy[];
  period: CollectionPeriod;
  observedAt?: string;
  scopeKey?: string;
}) {
  const normalized = normalizeProgressTurns(input.turns);
  if (isPluginAdministrationSession(normalized)) return null;
  const fallbackOccurredAt =
    toIso(input.updatedAt) ?? new Date(input.period.ends_at).toISOString();
  const sessionKey = anonymousSessionKey(
    input.pluginInstanceId,
    input.sessionId,
  );
  if (!latestCompleteTurnInPeriod(normalized, input.period, fallbackOccurredAt))
    return null;
  const selected = completeSessionTurns(normalized);

  const project = mappedProject(
    input.cwd,
    input.projects,
    input.scopeKey
      ? { pluginInstanceId: input.pluginInstanceId, scopeKey: input.scopeKey }
      : undefined,
  );
  if (input.scopeKey) project.scopeKey = input.scopeKey;
  const activity = {
    startedAt: selected[0]!.occurredAt ?? fallbackOccurredAt,
    endedAt: selected.at(-1)!.occurredAt ?? fallbackOccurredAt,
  };
  const turns = selected.map((turn) => ({
    occurredAt: turn.occurredAt ?? fallbackOccurredAt,
    userPrompt: turn.userPrompt,
    assistantFinal: turn.assistantFinal,
  }));
  const title = safeText(input.title?.trim() || "Codex 会话", 200);
  const legacyContentHash = (legacyProject: ProjectIdentity) =>
    sha256(
      JSON.stringify({
        periodKey: input.period.period_key,
        title,
        project: legacyProject,
        activity,
        turns,
      }),
    );
  const compatibleContentHashes = new Set([legacyContentHash(project)]);
  compatibleContentHashes.add(
    sha256(JSON.stringify({ hashVersion: "3.0", turns })),
  );
  if (project.id) {
    compatibleContentHashes.add(
      legacyContentHash({
        id: null,
        name: project.name,
        matchMethod: "path_discovered",
        rootFingerprint: project.rootFingerprint,
        rootName: project.name,
      }),
    );
  }
  const contentHash = sha256(
    JSON.stringify({
      hashVersion: "4.0",
      turns,
    }),
  );
  const observedAt = input.observedAt ?? new Date().toISOString();
  const production = {
    skillVersion: `partner-report-sync/${PLUGIN_VERSION}`,
    promptVersion: "2026-08-25.zh-whole-session-value.v4",
    schemaVersion: "1.0" as const,
    producer: "codex-skill" as const,
  };

  return {
    sessionKey,
    contentHash,
    compatibleContentHashes: [...compatibleContentHashes].filter(
      (hash) => hash !== contentHash,
    ),
    expected: {
      schemaVersion: "1.0" as const,
      periodKey: input.period.period_key,
      sessionKey,
      contentHash,
      project,
      activity,
      observedAt,
      production,
    },
    modelInput: {
      schemaVersion: "1.0",
      task: "筛选并总结当前 Codex Session 的项目贡献",
      language: "zh-CN",
      instructions: [
        "先判断整个 Session 是否包含对映射项目有意义的实际工作，再决定是否提取。",
        "本输入包含该 Session 的全部完整问答，必须作为一个整体判断和总结，不得拆成回合分别处理。",
        "只依据完整的用户问题和助手最终回答，不推断推理过程、命令、工具调用或文件改动。",
        "项目目录只提供上下文，不能单独证明 Session 与项目有关。",
        "标题、摘要和每条贡献正文必须使用简体中文。",
        "不得返回原始对话、绝对路径、Session 原始标识或凭据。",
      ],
      period: {
        key: input.period.period_key,
        startsAt: input.period.starts_at,
        endsAt: input.period.ends_at,
      },
      session: { title, project, activity, turns },
      screeningPolicy: {
        includeOnlyWhenSessionContainsMeaningfulProjectContribution: true,
        qualifyingKinds: [
          "outcome",
          "progress",
          "decision",
          "blocker",
          "next_step",
        ],
        ignoreWhen: [
          "casual_conversation",
          "unrelated_to_project",
          "no_meaningful_contribution",
          "insufficient_context",
        ],
        projectDirectoryAloneIsNotEvidenceOfRelevance: true,
      },
      outputRequirements: {
        ignore: {
          schemaVersion: "1.0",
          decision: "ignore",
          reason:
            "casual_conversation | unrelated_to_project | no_meaningful_contribution | insufficient_context",
        },
        include: {
          schemaVersion: "1.0",
          decision: "include",
          contribution: {
            ...{
              schemaVersion: "1.0",
              periodKey: input.period.period_key,
              sessionKey,
              contentHash,
              project,
              activity,
              observedAt,
              production,
            },
            title: "简洁的中文工作标题",
            summary: "简洁、准确且有事实依据的中文项目贡献摘要",
            contributions: [
              {
                kind: "outcome | progress | decision | blocker | next_step",
                text: "一条有事实依据的中文贡献",
                confidence: "high | medium | low",
              },
            ],
          },
        },
        neverReturnRawTranscriptOrPaths: true,
      },
    },
  };
}

export function firstNonChineseContributionField(contribution: any) {
  const containsChinese = (value: unknown) =>
    typeof value === "string" && /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value);
  const fields: Array<[string, unknown]> = [
    ["title", contribution?.title],
    ["summary", contribution?.summary],
    ...(Array.isArray(contribution?.contributions)
      ? contribution.contributions.map((item: any, index: number) => [
          `contributions[${index}].text`,
          item?.text,
        ])
      : []),
  ];
  return fields.find(([, value]) => !containsChinese(value))?.[0] ?? null;
}
