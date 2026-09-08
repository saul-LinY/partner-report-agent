import { expect, it } from "vitest";
import { calendarMonthDays, shiftCalendarMonth } from "./project-calendar.js";
it("renders complete Monday-to-Sunday weeks including leap days and year boundaries", () => {
  const september = calendarMonthDays("2026-09");
  expect(september).toHaveLength(35);
  expect(september[0]).toBe("2026-08-31");
  expect(september.at(-1)).toBe("2026-10-04");
  expect(calendarMonthDays("2024-02")).toContain("2024-02-29");
  expect(calendarMonthDays("2026-02")).not.toContain("2026-02-29");
  expect(shiftCalendarMonth("2026-01", -1)).toBe("2025-12");
  expect(shiftCalendarMonth("2026-12", 1)).toBe("2027-01");
});
