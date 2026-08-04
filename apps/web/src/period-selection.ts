type PeriodLike = {
  status: string;
  starts_at: string;
  ends_at: string;
};

export function selectCurrentOpenPeriod<T extends PeriodLike>(
  periods: T[],
  now = new Date(),
) {
  const open = periods.filter((period) => period.status === "open");
  const current = open.find(
    (period) =>
      new Date(period.starts_at) <= now && new Date(period.ends_at) > now,
  );
  if (current) return current;
  return open.find((period) => new Date(period.starts_at) <= now) ?? open[0];
}
