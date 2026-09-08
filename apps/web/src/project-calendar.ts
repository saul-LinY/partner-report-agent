import { addProgressDays } from "@partner-report/contracts/project-progress";
export function shiftCalendarMonth(month: string, offset: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
export function calendarMonthDays(month: string) {
  const first = `${month}-01`;
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const last = addProgressDays(`${shiftCalendarMonth(month, 1)}-01`, -1);
  const length = Math.ceil((offset + Number(last.slice(-2))) / 7) * 7;
  return Array.from({ length }, (_, i) => addProgressDays(first, i - offset));
}
/** Keep the original wording; the full summary remains available in the day detail. */
export function calendarExcerpt(text: string, max = 64) {
  const plain = text.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim();
  const sentence = plain.match(/^.*?[。！？](?:\s|$)?/)?.[0]?.trim() ?? plain;
  return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
}
