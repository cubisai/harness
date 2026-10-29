// Eval result store: cache keys, run files, reports and diffs. Plan:
// .ai/plans/eval-framework.md.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { accountingLine } from "./accounting";
import type { RunMeta, RunResult, Task, TaskResult, TrialResult } from "./types";

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

/** Bumped when the runner's trial semantics change, so older cached trials stop matching. */
export const EVAL_RUNTIME_VERSION = "2";

/** The rest of an experiment's identity: settings outside the task file that change its result. */
export interface Identity {
  /** Reasoning effort the turns run at. */
  effort?: string;
  /** Hash of the grader code. */
  graderVersion?: string;
}

/** Cache key for a task's inputs: everything that can change the result. */
export function cacheKey(
  task: Task,
  fixtureDir: string,
  model: string,
  protocol: string,
  harnessHash: string,
  identity: Identity = {},
): string {
  const parts = [
    JSON.stringify(task),
    hashDir(fixtureDir),
    hashDir(`${fixtureDir}.hidden`),
    model,
    protocol,
    harnessHash,
    `runtime ${EVAL_RUNTIME_VERSION}`,
    `effort ${identity.effort ?? ""}`,
    `graders ${identity.graderVersion ?? ""}`,
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

/** A trial worth reusing: the agent ran to an outcome (an infra failure or a cancel says nothing about it). */
function reusable(t: TrialResult): boolean {
  if (t.harnessError) return false;
  return t.status !== "harness-error" && t.status !== "cancelled";
}

/**
 * Every reusable trial stored under `key`, newest run first, each counted once.
 * Trials carry a trialId; an old run file's task that was itself a cache copy
 * (`cached: true`, no ids) repeats an earlier run's trials and is skipped.
 */
export function findCachedTrials(dir: string, key: string): TrialResult[] {
  const seen = new Set<string>();
  const out: TrialResult[] = [];
  for (const run of listRuns(dir)) {
    for (const task of run.tasks) {
      if (task.cacheKey !== key) continue;
      task.trials.forEach((t, i) => {
        if (!t.trialId && task.cached) return;
        if (!reusable(t)) return;
        const id = t.trialId ?? `${run.meta.startedAt}#${task.id}#${i}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ ...t, trialId: id, cached: true });
      });
    }
  }
  return out;
}

/** Folds reused and fresh trials into a task result; pass^k needs every requested trial. */
export function assembleTask(
  task: Pick<Task, "id" | "tags">,
  key: string,
  requested: number,
  reused: TrialResult[],
  fresh: TrialResult[],
): TaskResult {
  const trials = [...reused.slice(0, requested), ...fresh];
  return {
    id: task.id,
    tags: task.tags,
    cacheKey: key,
    cached: fresh.length === 0 && trials.length > 0,
    requestedTrials: requested,
    trials,
    passAtK: trials.some((t) => t.pass),
    passHatK: trials.length >= requested && trials.length > 0 && trials.every((t) => t.pass),
  };
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
    if (trials.length > 1 || (task.requestedTrials ?? 1) > 1) status += ` pass^k ${task.passHatK ? "yes" : "no"}`;
    const cachedCount = task.cached ? trials.length : trials.filter((t) => t.cached).length;
    const short = task.requestedTrials !== undefined && trials.length < task.requestedTrials ? ` (${trials.length}/${task.requestedTrials} trials)` : "";
    lines.push(
      `${task.id.padEnd(20)} ${status.padEnd(18)} score ${mean.toFixed(2)}  in ${taskIn} tok  ` +
        `steps ${taskSteps}${cachedCount === trials.length && trials.length ? " (cached)" : cachedCount ? ` (${cachedCount} cached)` : ""}${short}`,
    );

    // Cached trials count toward pass totals but not toward token totals.
    for (const t of trials) {
      if (task.cached || t.cached) continue;
      inTok += t.inputTokens;
      outTok += t.outputTokens;
      cacheRead += t.cacheReadTokens;
      steps += t.steps;
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
  lines.push(accountingLine(run.tasks));
  return lines.join("\n");
}

/** Pass/token/cache aggregates for a trend line (same rules as summarize). */
function runStats(run: RunResult): { passed: number; total: number; passHat: number; inTok: number; cacheRead: number } {
  let passed = 0;
  let passHat = 0;
  let inTok = 0;
  let cacheRead = 0;
  for (const task of run.tasks) {
    if (task.passAtK) passed++;
    if (task.passHatK) passHat++;
    // Cached trials count toward pass totals but not toward token totals.
    if (task.cached) continue;
    const fresh = task.trials.filter((t) => !t.cached);
    inTok += fresh.reduce((s, t) => s + t.inputTokens, 0);
    cacheRead += fresh.reduce((s, t) => s + t.cacheReadTokens, 0);
  }
  return { passed, total: run.tasks.length, passHat, inTok, cacheRead };
}

/** Zero-token pass/token history per tier+model from the saved run files. */
export function trend(runs: RunResult[], o: { tier?: string; model?: string; last?: number } = {}): string {
  const filtered = runs.filter((r) => (o.tier === undefined || r.meta.tier === o.tier) && (o.model === undefined || r.meta.model === o.model));
  if (filtered.length === 0) return "no runs";

  const byKey = new Map<string, RunResult[]>();
  for (const run of filtered) {
    const key = `${run.meta.tier}|${run.meta.model}`;
    const list = byKey.get(key);
    if (list) list.push(run);
    else byKey.set(key, [run]);
  }

  const lines: string[] = [];
  const keys = [...byKey.keys()].sort();
  for (const key of keys) {
    // Runs arrive newest-first; keep the newest `last`, then reverse to oldest→newest.
    const group = byKey.get(key)!.slice(0, o.last ?? 10).reverse();
    const [tier, model] = key.split("|");
    lines.push(`${tier} · ${model} (${group.length} runs)`);
    for (const run of group) {
      const s = runStats(run);
      const denom = s.inTok + s.cacheRead;
      const hit = denom === 0 ? 0 : Math.round((s.cacheRead / denom) * 100);
      lines.push(
        `  ${run.meta.startedAt.slice(0, 16).replace("T", " ")}  ${s.passed}/${s.total} pass  pass^k ${s.passHat}/${s.total}  ` +
          `in ${s.inTok} tok  cache-hit ${hit}%  ${run.meta.harnessHash.slice(0, 7)}`,
      );
    }

    // Flipped tasks: pass/fail per run (only among runs containing the task), duplicates collapsed.
    const byId = new Map<string, string[]>();
    for (const run of group) {
      for (const task of run.tasks) {
        const seq = byId.get(task.id);
        if (seq) seq.push(task.passAtK ? "P" : "F");
        else byId.set(task.id, [task.passAtK ? "P" : "F"]);
      }
    }
    const flipped: string[] = [];
    for (const [id, seq] of byId) {
      const collapsed: string[] = [];
      for (const v of seq) if (collapsed[collapsed.length - 1] !== v) collapsed.push(v);
      if (collapsed.length > 1) flipped.push(`${id} (${collapsed.join("→")})`);
    }
    if (flipped.length) lines.push(`  flipped: ${flipped.join(", ")}`);
    lines.push("");
  }
  // Drop the trailing blank line between groups.
  lines.pop();
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
      .reduce((sum, t) => sum + t.trials.filter((x) => !x.cached).reduce((s, x) => s + x.inputTokens, 0), 0);
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
