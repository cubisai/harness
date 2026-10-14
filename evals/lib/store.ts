// Eval result store: cache keys, run files, reports and diffs. Plan:
// .ai/plans/eval-framework.md.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RunMeta, RunResult, Task, TaskResult } from "./types";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else if (entry.isFile()) out.push(toPosix(relative(root, abs)));
  }
}

/** sha256 over the sorted `relPath\0sha256(bytes)` of every file under dir. */
export function hashDir(dir: string): string {
  if (!existsSync(dir)) return sha256Hex("");
  const files: string[] = [];
  walk(dir, dir, files);
  const entries = files.map((rel) => `${rel}\0${sha256Hex(readFileSync(join(dir, rel)))}`).sort();
  return sha256Hex(entries.join("\n"));
}

/** Cache key for a task's inputs: everything that can change the result. */
export function cacheKey(
  task: Task,
  fixtureDir: string,
  model: string,
  protocol: string,
  harnessHash: string,
): string {
  const parts = [
    JSON.stringify(task),
    hashDir(fixtureDir),
    hashDir(`${fixtureDir}.hidden`),
    model,
    protocol,
    harnessHash,
  ];
  return sha256Hex(parts.join("\n"));
}

const SECRET_NAME = /(_API_KEY|_TOKEN|SECRET|PASSWORD)$/i;
const SECRET_ANY = /SECRET/i;

/** Replace secret-looking env values with `***`. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!SECRET_NAME.test(name) && !SECRET_ANY.test(name)) continue;
    out = out.split(value).join("***");
  }
  return out;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<tier>-<model>-<startedAt>.json`, with some punctuation made filename-safe. */
export function runFileName(meta: RunMeta): string {
  return `${meta.tier}-${slug(meta.model)}-${meta.startedAt.replace(/[:.]/g, "-")}.json`;
}

/** Write a redacted run file and return its path. */
export function saveRun(dir: string, run: RunResult, env?: NodeJS.ProcessEnv): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, runFileName(run.meta));
  writeFileSync(path, redact(JSON.stringify(run, null, 1), env));
  return path;
}

/** Every readable run in dir, newest first by meta.startedAt. */
export function listRuns(dir: string): RunResult[] {
  if (!existsSync(dir)) return [];
  const runs: RunResult[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      runs.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as RunResult);
    } catch {
      // Skip files that aren't valid run JSON.
    }
  }
  return runs.sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
}

/** First task with the key that no trial failed at the harness level, newest run first. */
export function findCached(dir: string, key: string): TaskResult | null {
  for (const run of listRuns(dir)) {
    for (const task of run.tasks) {
      if (task.cacheKey !== key) continue;
      if (task.trials.some((t) => Boolean(t.harnessError))) continue;
      return { ...task, cached: true, trials: task.trials.map((t) => ({ ...t })) };
    }
  }
  return null;
}

/** Newest run of the same tier+model started before `before`. */
export function previousRun(dir: string, tier: string, model: string, before: string): RunResult | null {
  for (const run of listRuns(dir)) {
    if (run.meta.tier !== tier || run.meta.model !== model) continue;
    if (run.meta.startedAt < before) return run;
  }
  return null;
}

/** Plain-text per-task table plus a totals footer. */
export function summarize(run: RunResult): string {
  const lines: string[] = [];
  let passed = 0;
  let passHat = 0;
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  let steps = 0;
  let cost = 0;
  let costUnknown = false;

  for (const task of run.tasks) {
    const trials = task.trials;
    const mean = trials.length ? trials.reduce((s, t) => s + t.score, 0) / trials.length : 0;
    const taskIn = trials.reduce((s, t) => s + t.inputTokens, 0);
    const taskSteps = trials.reduce((s, t) => s + t.steps, 0);
    if (task.passAtK) passed++;
    if (task.passHatK) passHat++;

    let status = task.passAtK ? "PASS" : "FAIL";
    if (trials.length > 1) status += ` pass^k ${task.passHatK ? "yes" : "no"}`;
    lines.push(
      `${task.id.padEnd(20)} ${status.padEnd(18)} score ${mean.toFixed(2)}  in ${taskIn} tok  ` +
        `steps ${taskSteps}${task.cached ? " (cached)" : ""}`,
    );

    // Cached tasks count toward pass totals but not toward token totals.
    if (task.cached) continue;
    inTok += taskIn;
    outTok += trials.reduce((s, t) => s + t.outputTokens, 0);
    cacheRead += trials.reduce((s, t) => s + t.cacheReadTokens, 0);
    steps += taskSteps;
    for (const t of trials) {
      if (t.costUsd === null) costUnknown = true;
      else cost += t.costUsd;
    }
  }

  const total = run.tasks.length;
  const denom = inTok + cacheRead;
  const hit = denom === 0 ? 0 : Math.round((cacheRead / denom) * 100);
  lines.push(
    `${passed}/${total} passed · pass^k ${passHat}/${total} · in ${inTok} tok · out ${outTok} tok · ` +
      `cache-hit ${hit}% · steps ${steps} · $${costUnknown ? "unknown" : cost.toFixed(2)}`,
  );
  return lines.join("\n");
}

/** Newly failing / passing tasks and the input-token delta vs the previous run. */
export function diffRuns(prev: RunResult | null, cur: RunResult): string {
  if (!prev) return "";

  const passIds = (run: RunResult): Set<string> =>
    new Set(run.tasks.filter((t) => t.passAtK).map((t) => t.id));
  const prevPass = passIds(prev);
  const prevIds = new Set(prev.tasks.map((t) => t.id));

  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];
  for (const task of cur.tasks) {
    if (!prevIds.has(task.id)) continue;
    const wasPass = prevPass.has(task.id);
    if (wasPass && !task.passAtK) newlyFailing.push(task.id);
    else if (!wasPass && task.passAtK) newlyPassing.push(task.id);
  }

  const lines: string[] = [];
  if (newlyFailing.length) lines.push(`newly failing: ${newlyFailing.sort().join(", ")}`);
  if (newlyPassing.length) lines.push(`newly passing: ${newlyPassing.sort().join(", ")}`);

  const tokenSum = (run: RunResult): number =>
    run.tasks
      .filter((t) => !t.cached)
      .reduce((sum, t) => sum + t.trials.reduce((s, x) => s + x.inputTokens, 0), 0);
  const prevSum = tokenSum(prev);
  const curSum = tokenSum(cur);
  if (prevSum !== 0 && curSum !== 0) {
    const delta = Math.round(((curSum - prevSum) / prevSum) * 100);
    lines.push(`tokens: ${delta >= 0 ? "+" : ""}${delta}% vs ${prev.meta.startedAt}`);
  }
  return lines.join("\n");
}

/** Committed pass/fail per task, keyed by "<tier>|<model>"; no transcripts. */
export type Baseline = Record<string, Record<string, "pass" | "fail">>;

const baselineKey = (run: RunResult): string => `${run.meta.tier}|${run.meta.model}`;

export function readBaseline(path: string): Baseline {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Baseline;
  } catch {
    return {};
  }
}

/** Records this run's results in the baseline for its tier+model; tasks it didn't run keep their entry. */
export function saveBaseline(path: string, run: RunResult): void {
  const all = readBaseline(path);
  const merged = { ...all[baselineKey(run)], ...Object.fromEntries(run.tasks.map((t) => [t.id, t.passAtK ? "pass" : "fail"] as const)) };
  all[baselineKey(run)] = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
}

/** Tasks that passed in the baseline and fail now, and the reverse; "" when there's no baseline. */
export function compareBaseline(base: Baseline, run: RunResult): string {
  const expected = base[baselineKey(run)];
  if (!expected) return "";
  const worse = run.tasks.filter((t) => expected[t.id] === "pass" && !t.passAtK).map((t) => t.id);
  const better = run.tasks.filter((t) => expected[t.id] === "fail" && t.passAtK).map((t) => t.id);
  const lines: string[] = [];
  if (worse.length) lines.push(`below baseline: ${worse.join(", ")}`);
  if (better.length) lines.push(`above baseline: ${better.join(", ")}`);
  return lines.join("\n") || "matches baseline";
}
