// Local bench storage: results/history.csv (one flat row per run, the
// history every day compares against), results/<date>.md and results/README.md.
// Local only: .state/runs/<date>/*.json, the full record of each run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { overview, summarize, type DayRuns } from "./summary";
import type { RunResult } from "./types";

/** One run, flat: what the summaries and day-to-day deltas need. */
export interface RunRow {
  date: string;
  task: string;
  /** Rows written before suites existed read as "behaviour". */
  suite: string;
  tier: string;
  agent: string;
  model: string;
  trial: number;
  status: string;
  pass: boolean;
  /** Share of grader weight passed, 0..1. */
  score: number;
  /** Behaviour checks: true, false or null (the task sets none). */
  todoOk: boolean | null;
  runCodeOk: boolean | null;
  skillsOk: boolean | null;
  memoryOk: boolean | null;
  todoUpdates: number;
  todoBeforeEdit: boolean | null;
  todoClosed: boolean | null;
  tools: number;
  runCode: number;
  runCodeFailed: number;
  look: number;
  shell: number;
  edit: number;
  tokensIn: number;
  cacheRead: number;
  cacheWrite: number;
  tokensOut: number;
  costUsd: number | null;
  durationMs: number;
  skills: string;
  memReads: number;
  memWrites: number;
  /** The app's project check: first result, fix rounds used, last result (null = no check ran). */
  checkFirstOk: boolean | null;
  fixRounds: number;
  checkFinalOk: boolean | null;
  /** Evidence-gate flags raised. */
  evidence: number;
  /** Test or typecheck commands the agent ran itself. */
  verifyRuns: number;
  /** Self-improve's worst turn score ("ok", "warn", "fail"; "" when off) and the project's lessons. */
  health: string;
  lessons: number;
  commit: string;
  dirty: boolean;
  versions: string;
  /** Why it didn't pass, short. */
  why: string;
}

const COLUMNS: (keyof RunRow)[] = [
  "date", "suite", "tier", "task", "agent", "model", "trial", "status", "pass", "score", "todoOk", "runCodeOk", "skillsOk", "memoryOk",
  "todoUpdates", "todoBeforeEdit", "todoClosed", "tools", "runCode", "runCodeFailed", "look", "shell", "edit", "tokensIn", "cacheRead", "cacheWrite",
  "tokensOut", "costUsd", "durationMs", "skills", "memReads", "memWrites", "checkFirstOk", "fixRounds", "checkFinalOk", "evidence", "verifyRuns",
  "health", "lessons", "commit", "dirty", "versions", "why",
];
const BOOLS = new Set<keyof RunRow>(["pass", "todoOk", "runCodeOk", "skillsOk", "memoryOk", "todoBeforeEdit", "todoClosed", "checkFirstOk", "checkFinalOk", "dirty"]);
const NUMS = new Set<keyof RunRow>(["trial", "score", "todoUpdates", "tools", "runCode", "runCodeFailed", "look", "shell", "edit", "tokensIn", "cacheRead", "cacheWrite", "tokensOut", "costUsd", "durationMs", "memReads", "memWrites", "fixRounds", "evidence", "verifyRuns", "lessons"]);
/** Columns that can be empty on purpose (unknown), not zero. */
const NULLABLE_NUMS = new Set<keyof RunRow>(["costUsd"]);

export function toRow(r: RunResult): RunRow {
  const m = r.metrics;
  return {
    date: r.date,
    task: r.task,
    suite: r.suite,
    tier: r.tier ?? "",
    agent: r.agent,
    model: r.model,
    trial: r.trial,
    status: r.status,
    pass: r.pass,
    score: Math.round(r.score * 100) / 100,
    todoOk: r.checks.todo,
    runCodeOk: r.checks.runCode,
    skillsOk: r.checks.skills,
    memoryOk: r.checks.memory,
    todoUpdates: m.todo.updates,
    todoBeforeEdit: m.todo.beforeFirstEdit,
    todoClosed: m.todo.allCompleted,
    tools: m.tools.total,
    runCode: m.tools.runCode,
    runCodeFailed: m.tools.runCodeFailed,
    look: m.tools.look,
    shell: m.tools.shell,
    edit: m.tools.edit,
    tokensIn: m.tokens.input,
    cacheRead: m.tokens.cacheRead,
    cacheWrite: m.tokens.cacheWrite,
    tokensOut: m.tokens.output,
    costUsd: m.costUsd,
    durationMs: m.durationMs,
    skills: m.skills.join(" "),
    memReads: m.memory.reads,
    memWrites: m.memory.writes,
    checkFirstOk: m.check.firstOk,
    fixRounds: m.check.fixRounds,
    checkFinalOk: m.check.finalOk,
    evidence: m.evidence.length,
    verifyRuns: m.verifyRuns,
    health: r.learn?.health[0] ?? "",
    lessons: r.learn?.lessons ?? 0,
    commit: r.harness.commit.slice(0, 7),
    dirty: r.harness.dirty,
    versions: Object.entries(r.harness.versions).map(([k, v]) => `${k} ${v}`).join(" · "),
    why: (r.note ?? (r.pass ? "" : r.graders.filter((g) => !g.pass).map((g) => g.why).join("; "))).replace(/\s+/g, " ").slice(0, 200),
  };
}

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: RunRow[]): string {
  return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** RFC 4180 fields: quotes, doubled quotes, commas and newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((f) => f !== ""));
}

export function fromCsv(text: string): RunRow[] {
  const [header, ...lines] = parseCsv(text);
  if (!header) return [];
  return lines.map((fields) => {
    const row: Record<string, unknown> = {};
    header.forEach((name, i) => {
      const key = name as keyof RunRow;
      const raw = fields[i] ?? "";
      row[key] = BOOLS.has(key) ? (raw === "" ? null : raw === "1") : NUMS.has(key) ? (raw === "" ? (NULLABLE_NUMS.has(key) ? null : 0) : Number(raw)) : raw;
    });
    // Columns added later: older rows read as their defaults.
    for (const key of COLUMNS) if (!(key in row)) row[key] = BOOLS.has(key) ? null : NUMS.has(key) && !NULLABLE_NUMS.has(key) ? 0 : NULLABLE_NUMS.has(key) ? null : "";
    if (!row.suite) row.suite = "behaviour";
    if (!header.includes("score")) row.score = row.pass ? 1 : 0;
    return row as unknown as RunRow;
  });
}

const historyFile = (resultsDir: string) => join(resultsDir, "history.csv");

export function readHistory(resultsDir: string): RunRow[] {
  const file = historyFile(resultsDir);
  return existsSync(file) ? fromCsv(readFileSync(file, "utf8")) : [];
}

const runKey = (r: RunRow) => `${r.date}|${r.task}|${r.agent}|${r.model}|${r.trial}`;

/** Adds the runs to history.csv; a rerun of the same date, task, agent, model and trial replaces the old row. */
export function appendHistory(resultsDir: string, rows: RunRow[]): void {
  mkdirSync(resultsDir, { recursive: true });
  const fresh = new Set(rows.map(runKey));
  const all = [...readHistory(resultsDir).filter((r) => !fresh.has(runKey(r))), ...rows].sort((a, b) => runKey(a).localeCompare(runKey(b)));
  writeFileSync(historyFile(resultsDir), toCsv(all));
}

export function days(rows: RunRow[]): DayRuns[] {
  const by = new Map<string, RunRow[]>();
  for (const r of rows) by.set(r.date, [...(by.get(r.date) ?? []), r]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, runs]) => ({ date, runs }));
}

/** Writes <date>.md and the README overview from history.csv; returns the day file. */
export function writeReports(resultsDir: string, date: string): string {
  const all = days(readHistory(resultsDir));
  const day = all.find((d) => d.date === date) ?? { date, runs: [] };
  const file = join(resultsDir, `${date}.md`);
  writeFileSync(file, summarize(day, all));
  writeFileSync(join(resultsDir, "README.md"), overview(all));
  return file;
}
