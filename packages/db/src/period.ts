type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type WeeklyPeriodRule = {
  frequency?: "weekly";
  weekStartsOn?: number;
  factCutoffWeekday?: number;
  factCutoffTime?: string;
};

export const DEFAULT_WEEKLY_PERIOD_RULE: Required<WeeklyPeriodRule> = {
  frequency: "weekly",
  weekStartsOn: 1,
  factCutoffWeekday: 5,
  factCutoffTime: "17:00",
};

export function weeklyPeriodKeyCandidates(period: {
  periodKey: string;
  startsAt: Date;
}) {
  const boundary = period.startsAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".000", "");
  return [period.periodKey, `${period.periodKey}-${boundary}`];
}

function partsInZone(date: Date, timezone: string): DateParts {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (name: Intl.DateTimeFormatPartTypes) =>
    Number(values.find((part) => part.type === name)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zoneOffsetAt(date: Date, timezone: string) {
  const parts = partsInZone(date, timezone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - date.getTime()
  );
}

function zonedDate(parts: DateParts, timezone: string) {
  const guessedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let result = new Date(
    guessedUtc - zoneOffsetAt(new Date(guessedUtc), timezone),
  );
  result = new Date(guessedUtc - zoneOffsetAt(result, timezone));
  return result;
}

function isoWeekKey(localDate: Date) {
  const target = new Date(localDate.getTime());
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function clock(value: string | undefined, fallback: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? fallback);
  if (!match) throw new Error(`Invalid period clock: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59)
    throw new Error(`Invalid period clock: ${value}`);
  return { hour, minute };
}

export function weeklyPeriodAt(
  now: Date,
  timezone: string,
  configured: WeeklyPeriodRule = DEFAULT_WEEKLY_PERIOD_RULE,
) {
  const rule = { ...DEFAULT_WEEKLY_PERIOD_RULE, ...configured };
  const cutoffClock = clock(rule.factCutoffTime, "17:00");
  const local = partsInZone(now, timezone);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const day = localDate.getUTCDay() || 7;
  const daysSinceCutoff = (day - rule.factCutoffWeekday + 7) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceCutoff);
  const beforeCutoff =
    local.hour < cutoffClock.hour ||
    (local.hour === cutoffClock.hour && local.minute < cutoffClock.minute);
  if (daysSinceCutoff === 0 && beforeCutoff) {
    localDate.setUTCDate(localDate.getUTCDate() - 7);
  }
  const nextCutoffDate = new Date(localDate.getTime() + 7 * 86_400_000);
  const startsAt = zonedDate(
    {
      year: localDate.getUTCFullYear(),
      month: localDate.getUTCMonth() + 1,
      day: localDate.getUTCDate(),
      hour: cutoffClock.hour,
      minute: cutoffClock.minute,
      second: 0,
    },
    timezone,
  );
  const endsAt = zonedDate(
    {
      year: nextCutoffDate.getUTCFullYear(),
      month: nextCutoffDate.getUTCMonth() + 1,
      day: nextCutoffDate.getUTCDate(),
      hour: cutoffClock.hour,
      minute: cutoffClock.minute,
      second: 0,
    },
    timezone,
  );
  return {
    periodKey: isoWeekKey(localDate),
    startsAt,
    endsAt,
    cutoffAt: endsAt,
    // Kept as a storage compatibility value; Team Report generation is approval-driven.
    submissionDeadlineAt: endsAt,
  };
}
