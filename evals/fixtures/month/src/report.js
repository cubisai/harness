import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseDate } from "./dates.js";

// Sums amounts per "YYYY-MM".
export function monthlyTotals(rows) {
  const totals = {};
  for (const r of rows) {
    const { year, month } = parseDate(r.date);
    const key = `${year}-${String(month).padStart(2, "0")}`;
    totals[key] = (totals[key] ?? 0) + r.amount;
  }
  return totals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
  for (const [month, total] of Object.entries(monthlyTotals(rows))) console.log(`${month}: ${total}`);
}
