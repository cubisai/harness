// Re-renders a day's report and the results README from history.csv (no model calls).
//   bun bench/report.ts [YYYY-MM-DD]   (default: the newest day)
//   bun bench/report.ts --import <folder of run JSON files>   (adds them to history.csv first)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendHistory, days, readHistory, toRow, writeReports } from "./lib/results";
import type { RunResult } from "./lib/types";

const RESULTS = join(import.meta.dirname, "results");
const args = process.argv.slice(2);
const from = args.indexOf("--import");
if (from >= 0) {
  const dir = args[from + 1]!;
  const runs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunResult);
  appendHistory(RESULTS, runs.map(toRow));
  args.splice(from, 2);
}
const all = days(readHistory(RESULTS));
const date = args[0] ?? all.at(-1)?.date;
if (!date || !all.some((d) => d.date === date)) {
  console.error(date ? `no results for ${date}` : "no results yet");
  process.exit(1);
}
console.log(writeReports(RESULTS, date));
