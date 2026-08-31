import { hostThreadKey } from "./host-project-discovery.js";

export const HOST_THREAD_TURN_LIMIT = 1;
export const HOST_THREAD_OUTPUT_LIMIT = 20_000;
const HOST_THREAD_MAX_PAGES = 1_000;

export type PendingHostThreadRead = {
  threadKey: string;
  threadId: string;
  hostId: string;
  nextCursor: string | null;
  previousCursor?: string | null;
  pageCount: number;
  turns: unknown[];
  thread: {
    title?: string | null;
    cwd?: string | null;
    updatedAt?: string | number | null;
  };
};

function object(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error(message), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  return value as Record<string, unknown>;
}

export function beginHostThreadRead(thread: { id: string; hostId: string }) {
  return {
    threadKey: hostThreadKey(thread),
    threadId: thread.id,
    hostId: thread.hostId,
    nextCursor: null,
    pageCount: 0,
    turns: [],
    thread: {},
  } satisfies PendingHostThreadRead;
}

export function hostThreadReadTool(pending: PendingHostThreadRead) {
  return {
    name: "codex_app__read_thread",
    arguments: {
      threadId: pending.threadId,
      hostId: pending.hostId,
      ...(pending.nextCursor ? { cursor: pending.nextCursor } : {}),
      turnLimit: HOST_THREAD_TURN_LIMIT,
      includeOutputs: false,
      maxOutputCharsPerItem: HOST_THREAD_OUTPUT_LIMIT,
    },
  };
}

export function appendHostThreadReadPage(
  pending: PendingHostThreadRead,
  value: unknown,
) {
  if (JSON.stringify(value).length > 3 * 1024 * 1024)
    throw Object.assign(new Error("Codex 远程任务分页结果过大。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  const response = object(value, "Codex 远程任务分页结果格式无效。");
  const thread = object(response.thread, "Codex 远程任务信息格式无效。");
  const page = object(response.page, "Codex 远程任务分页信息格式无效。");
  const id = typeof thread.id === "string" ? thread.id : "";
  const hostId = typeof thread.hostId === "string" ? thread.hostId : "";
  if (
    id !== pending.threadId ||
    hostId !== pending.hostId ||
    thread.kind !== "codex"
  )
    throw Object.assign(new Error("Codex 远程任务分页与当前队列项不匹配。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  if (
    !Array.isArray(response.turns) ||
    response.turns.length > HOST_THREAD_TURN_LIMIT
  )
    throw Object.assign(new Error("Codex 远程任务回合列表格式无效。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  const existingTurnIds = new Set(
    pending.turns.map((turn) =>
      String(object(turn, "Codex 远程任务回合格式无效。").id),
    ),
  );
  const pageTurnIds = new Set<string>();
  for (const turn of response.turns) {
    const turnRecord = object(turn, "Codex 远程任务回合格式无效。");
    if (typeof turnRecord.id !== "string" || !turnRecord.id.trim())
      throw Object.assign(new Error("Codex 远程任务回合缺少 ID。"), {
        code: "CODEX_HOST_THREAD_HISTORY_INVALID",
      });
    if (existingTurnIds.has(turnRecord.id) || pageTurnIds.has(turnRecord.id))
      throw Object.assign(new Error("Codex 远程任务回合重复。"), {
        code: "CODEX_HOST_THREAD_HISTORY_INVALID",
      });
    const items = Array.isArray(turnRecord.items) ? turnRecord.items : [];
    const possiblyTruncated = items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const record = item as Record<string, unknown>;
      if (record.type === "userMessage") {
        if (typeof record.content === "string")
          return record.content.length >= HOST_THREAD_OUTPUT_LIMIT;
        return (
          Array.isArray(record.content) &&
          record.content.some(
            (part) =>
              part != null &&
              typeof part === "object" &&
              !Array.isArray(part) &&
              typeof (part as Record<string, unknown>).text === "string" &&
              ((part as Record<string, unknown>).text as string).length >=
                HOST_THREAD_OUTPUT_LIMIT,
          )
        );
      }
      return (
        record.type === "agentMessage" &&
        record.phase === "final_answer" &&
        typeof record.text === "string" &&
        record.text.length >= HOST_THREAD_OUTPUT_LIMIT
      );
    });
    if (possiblyTruncated)
      throw Object.assign(new Error("Codex 远程任务消息可能已被宿主截断。"), {
        code: "CODEX_HOST_THREAD_HISTORY_INVALID",
      });
    pageTurnIds.add(turnRecord.id);
  }
  if (page.order !== "newest_first" || typeof page.hasMore !== "boolean")
    throw Object.assign(new Error("Codex 远程任务分页顺序格式无效。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  const nextCursor =
    page.nextCursor === null || page.nextCursor === undefined
      ? null
      : typeof page.nextCursor === "string" && page.nextCursor
        ? page.nextCursor
        : undefined;
  if (nextCursor === undefined || (page.hasMore && !nextCursor))
    throw Object.assign(new Error("Codex 远程任务缺少下一页游标。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  if (page.hasMore && nextCursor === pending.nextCursor)
    throw Object.assign(new Error("Codex 远程任务分页游标没有推进。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  const pageCount = pending.pageCount + 1;
  if (pageCount > HOST_THREAD_MAX_PAGES)
    throw Object.assign(new Error("Codex 远程任务分页数量超过安全上限。"), {
      code: "CODEX_HOST_THREAD_HISTORY_INVALID",
    });
  const title = typeof thread.title === "string" ? thread.title : null;
  const cwd = typeof thread.cwd === "string" ? thread.cwd : null;
  const updatedAt =
    typeof thread.updatedAt === "string" ||
    (typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt))
      ? thread.updatedAt
      : null;
  return {
    pending: {
      ...pending,
      previousCursor: pending.nextCursor,
      nextCursor,
      pageCount,
      turns: [...pending.turns, ...response.turns],
      thread: { title, cwd, updatedAt },
    } satisfies PendingHostThreadRead,
    complete: !page.hasMore,
  };
}

export function completedHostThread(pending: PendingHostThreadRead) {
  return {
    name: pending.thread.title,
    cwd: pending.thread.cwd,
    updatedAt: pending.thread.updatedAt,
    turns: [...pending.turns].reverse(),
  };
}
