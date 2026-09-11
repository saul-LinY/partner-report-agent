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

/** Compact the introduction for project navigation; retain the full text on hover. */
export function projectIntroduction(text?: string | null) {
  if (!text?.trim()) return "暂无项目介绍";
  const plain = text.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim();
  let brief = (plain.match(/^.*?[。！？]/)?.[0] ?? plain)
    .replace(/^.{0,40}?是(?:一个|一款|一套)?\s*/, "")
    .split(/，(?:用于|帮助|集中|支持|为|通过|可)/)[0]!
    .replace(/[。！？；，]+$/, "");
  if (brief.length > 28 && /^面向.+的\s*\S/.test(brief))
    brief = brief.replace(/^面向.+的\s*/, "");
  return brief.length <= 28 ? `${brief}。` : calendarExcerpt(brief, 28);
}
