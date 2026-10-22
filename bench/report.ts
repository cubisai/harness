// Re-renders a day's summary.md from its stored runs (no model calls).
//   bun bench/report.ts [YYYY-MM-DD]   (default: the newest day)

import { join } from "node:path";
import { readDays, writeSummary } from "./lib/results";

const RESULTS = join(import.meta.dirname, "results");
const days = readDays(RESULTS);
const date = process.argv[2] ?? days.at(-1)?.date;
if (!date || !days.some((d) => d.date === date)) {
  console.error(date ? `no results for ${date}` : "no results yet");
  process.exit(1);
}
console.log(writeSummary(RESULTS, date, days));
