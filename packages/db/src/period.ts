type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInZone(date: Date, timezone: string): DateParts {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (name: Intl.DateTimeFormatPartTypes) => Number(values.find((part) => part.type === name)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function zoneOffsetAt(date: Date, timezone: string) {
  const parts = partsInZone(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

function zonedDate(parts: DateParts, timezone: string) {
  const guessedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let result = new Date(guessedUtc - zoneOffsetAt(new Date(guessedUtc), timezone));
  result = new Date(guessedUtc - zoneOffsetAt(result, timezone));
  return result;
}

function isoWeekKey(localDate: Date) {
  const target = new Date(localDate.getTime());
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weeklyPeriodAt(now: Date, timezone: string) {
  const local = partsInZone(now, timezone);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const day = localDate.getUTCDay();
  const daysSinceFriday = (day - 5 + 7) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceFriday);
  if (daysSinceFriday === 0 && local.hour < 13) {
    localDate.setUTCDate(localDate.getUTCDate() - 7);
  }
  const nextFriday = new Date(localDate.getTime() + 7 * 86_400_000);
  const startsAt = zonedDate({ year: localDate.getUTCFullYear(), month: localDate.getUTCMonth() + 1, day: localDate.getUTCDate(), hour: 13, minute: 0, second: 0 }, timezone);
  const nextStartsAt = zonedDate({ year: nextFriday.getUTCFullYear(), month: nextFriday.getUTCMonth() + 1, day: nextFriday.getUTCDate(), hour: 13, minute: 0, second: 0 }, timezone);
  return {
    periodKey: isoWeekKey(localDate),
    startsAt,
    endsAt: nextStartsAt
  };
}
