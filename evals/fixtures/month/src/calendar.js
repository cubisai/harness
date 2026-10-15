import { parseDate } from "./dates.js";

// Days in the month of a "YYYY-MM-DD" date.
export function daysInMonth(s) {
  const { year, month } = parseDate(s);
  return new Date(year, month, 0).getDate();
}
