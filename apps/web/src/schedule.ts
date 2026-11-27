const WEEKDAYS: Record<string, string> = {
  Mon: "周一",
  Tue: "周二",
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
  Sun: "周日",
};

function parts(iso: string, timezone: string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    formatted.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${Number(get("month"))}月${Number(get("day"))}日`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: WEEKDAYS[get("weekday")] ?? "",
  };
}

/** "11月13日": the calendar day of an instant in the team's time zone. */
export const formatDate = (iso: string, timezone: string) =>
  parts(iso, timezone).date;

/** "11月23日 12:00", or "11月23日（周一）13:00" with the weekday. */
export function formatMoment(iso: string, timezone: string, weekday = false) {
  const p = parts(iso, timezone);
  return weekday
    ? `${p.date}（${p.weekday}）${p.time}`
    : `${p.date} ${p.time}`;
}

/** "2026-W46" (or a key with a boundary suffix) reads as "W46". Anything else is shown as written. */
export const weekLabel = (periodKey: string) => {
  const match = /W(\d{1,2})/.exec(periodKey);
  return match ? `W${match[1]!.padStart(2, "0")}` : periodKey;
};

/** "2 天 20 小时" until a deadline; null once it has passed. */
export function countdownText(deadlineIso: string, now: number) {
  const minutes = Math.floor((Date.parse(deadlineIso) - now) / 60_000);
  if (!(minutes > 0)) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}
