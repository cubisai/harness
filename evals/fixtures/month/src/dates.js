// Parses "YYYY-MM-DD" into { year, month, day } with month 1-12.
export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}
