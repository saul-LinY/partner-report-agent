import { z } from "zod";

export function isValidPluginLogDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const logDateSchema = z
  .string()
  .refine(isValidPluginLogDate, "日期必须是有效的 YYYY-MM-DD。");

const secretPatterns: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi, "Bearer <REDACTED>"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<REDACTED_API_KEY>"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "<REDACTED_PRIVATE_KEY>",
  ],
  [
    /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s,;"']{4,}/gi,
    "$1$2<REDACTED>",
  ],
  [/\/Users\/[^/\s]+/g, "<USER_HOME>"],
  [/[A-Za-z]:\\Users\\[^\\\s]+/g, "<USER_HOME>"],
];

export function sanitizePluginLogText(value: string) {
  return secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

export function sanitizePluginLogDetails(value: unknown): unknown {
  if (typeof value === "string") return sanitizePluginLogText(value);
  if (Array.isArray(value)) return value.map(sanitizePluginLogDetails);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|secret|password|authorization|credential/i.test(key)
          ? "<REDACTED>"
          : sanitizePluginLogDetails(item),
      ]),
    );
  return value;
}
