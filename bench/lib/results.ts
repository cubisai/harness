// Reads and writes bench/results/<date>/: one JSON per run and the day's summary.md.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarize, type DayRuns } from "./summary";
import type { RunResult } from "./types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every day folder's runs, oldest first. */
export function readDays(resultsDir: string): DayRuns[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((d) => DAY.test(d))
    .sort()
    .map((date) => ({
      date,
      runs: readdirSync(join(resultsDir, date))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(resultsDir, date, f), "utf8")) as RunResult),
    }));
}

/** Writes <date>/summary.md from that day's runs and the days before; returns its path. */
export function writeSummary(resultsDir: string, date: string, days: DayRuns[]): string {
  const day = days.find((d) => d.date === date) ?? { date, runs: [] };
  const file = join(resultsDir, date, "summary.md");
  writeFileSync(file, summarize(day, days));
  return file;
}
