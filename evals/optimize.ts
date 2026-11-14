// Bounded optimizer CLI. One surface per experiment: it reads the
// train failures, tries each candidate on the validation split, records every
// round, and (with --release) checks the winner on the sealed holdout.
//   bun --env-file=.env evals/optimize.ts --surface model-effort --try "effort=medium;effort=high" --budget 2
// Flags: --surface <prompt|model-effort> (required), --try "k=v[,k=v];k=v" (candidates, ";"-separated),
// --budget <usd> (required, > 0), --trials <n> (default 3, min 3), --provider, --model, --agent,
// --price <in>,<out> (USD per 1M tokens, for a model that reports no cost; 0,0 for a free one),
// --id <name> (default opt-<surface>-<yyyymmdd-hhmmss>), --release (run the holdout too), --dry (plan only).
// Experiments live in .ai/evals/experiments/<id>/ (ignored local output).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addCandidate,
  applyRound,
  decide,
  newExperiment,
  saveExperiment,
  scoreOf,
  shouldStop,
  summary,
  trainFailures,
  SURFACES,
  WIRED,
  type Experiment,
  type SplitName,
  type Surface,
} from "./lib/optimize";
import { spend } from "./lib/accounting";
import type { RunResult } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
/** Where every experiment is recorded. */
const EXPERIMENTS = join(ROOT, ".ai", "evals", "experiments");
/** The settings each surface accepts; a key outside its list is refused. */
const SURFACE_KEYS: Record<string, string[]> = {
  "model-effort": ["model", "effort"],
  prompt: ["guide"],
};

/** A candidate's settings; the same shape the experiment store records. */
export type CandidateSettings = Parameters<typeof addCandidate>[1];

/** One split's run; injectable so tests need no CLI or model call. */
export type RunSplit = (split: SplitName, settings: CandidateSettings, trials: number, maxUsd: number) => Promise<RunResult>;

export interface OptimizeOptions {
  /** Experiment id; also its folder under root. */
  id: string;
  surface: Surface;
  /** Candidate settings to try, in order; each is one round. */
  candidates: CandidateSettings[];
  budgetUsd: number;
  trials: number;
  /** Run the sealed holdout for the winner as well. */
  release: boolean;
  /** Experiments root; injectable so tests use a temp dir. */
  root: string;
  provider?: string;
  model?: string;
  agent?: string;
  /** "<in>,<out>" USD per 1M tokens, passed to run.ts for a model that reports no cost ("0,0" when free). */
  price?: string;
  criteria?: Parameters<typeof newExperiment>[0]["criteria"];
}

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(a.slice(2), next);
      i++;
    } else out.set(a.slice(2), "true");
  }
  return out;
}

/** SURFACES/WIRED name surfaces; accept an array, a set or a keyed map. */
function includes(list: object, value: string): boolean {
  if (Array.isArray(list)) return (list as string[]).includes(value);
  if (list instanceof Set) return (list as Set<string>).has(value);
  return Object.prototype.hasOwnProperty.call(list, value);
}

function names(list: object): string[] {
  if (Array.isArray(list)) return (list as unknown[]).map(String);
  if (list instanceof Set) return Array.from(list as Set<string>);
  return Object.keys(list);
}

/** The known / wired surface names, whatever shape the library exports. */
export function knownSurfaces(): string[] {
  return names(SURFACES);
}
export function wiredSurfaces(): string[] {
  return names(WIRED);
}

/** null when the surface is known and wired; otherwise why not (exit 2). */
export function surfaceError(surface: string): string | null {
  if (!includes(SURFACES, surface)) return `--surface must be one of ${knownSurfaces().join(", ")} (got "${surface}")`;
  if (!includes(WIRED, surface)) return `surface ${surface} isn't wired yet (${wiredSurfaces().join(", ")} are)`;
  return null;
}

/** null when the settings are valid for the surface; otherwise why not. */
export function settingsError(surface: Surface, settings: CandidateSettings, root = ROOT): string | null {
  const allowed = SURFACE_KEYS[surface] ?? [];
  for (const key of Object.keys(settings)) {
    if (!allowed.includes(key)) return `${surface} doesn't take "${key}" (accepts ${allowed.join(", ")})`;
  }
  const guide = settings.guide;
  if (surface === "prompt" && guide !== undefined && !existsSync(resolve(root, guide))) return `prompt guide not found: ${guide}`;
  return null;
}

/** "--try" candidates: ";"-separated, each "k=v" pairs separated by ",". */
export function parseTry(value: string): CandidateSettings[] {
  return value.split(";").map((chunk) => {
    const settings: Record<string, string> = {};
    for (const pair of chunk.split(",")) {
      const at = pair.indexOf("=");
      if (at < 1) throw new Error(`--try entries must be k=v (got "${pair}")`);
      settings[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    return settings;
  });
}

/** The argv for one run; pure enough to assert in tests. */
export function buildRunArgs(split: SplitName, settings: CandidateSettings, o: OptimizeOptions, trials = o.trials, maxUsd = o.budgetUsd, out?: string): string[] {
  const model = settings.model ?? o.model;
  return [
    "bun",
    "--env-file=.env",
    "evals/run.ts",
    "--split",
    split,
    "--trials",
    String(trials),
    ...(trials > 1 ? ["--trials-all"] : []),
    "--max-usd",
    String(maxUsd),
    ...(out ? ["--out", out] : []),
    ...(split === "holdout" ? ["--release"] : []),
    ...(o.provider ? ["--provider", o.provider] : []),
    ...(o.agent ? ["--agent", o.agent] : []),
    ...(model ? ["--model", model] : []),
    ...(o.price ? ["--price", o.price] : []),
    ...(settings.effort ? ["--effort", settings.effort] : []),
    ...(settings.guide ? ["--guide", settings.guide] : []),
  ];
}

/** The real runner: one run.ts per split, its JSON read back from --out. */
export function makeRunSplit(o: OptimizeOptions): RunSplit {
  return async (split, settings, trials, maxUsd) => {
    const out = join(tmpdir(), `opt-${o.id}-${split}-${randomUUID().slice(0, 8)}.json`);
    const argv = buildRunArgs(split, settings, o, trials, maxUsd, out);
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd: ROOT, stdio: "inherit", shell: false });
    // Exit 2 is an incomplete run, which still writes the result; a missing file is a real failure.
    if (!existsSync(out)) throw new Error(`evals/run.ts wrote no result for ${split} (exit ${result.status ?? "?"})`);
    const run = JSON.parse(readFileSync(out, "utf8")) as RunResult;
    rmSync(out, { force: true });
    return run;
  };
}

/**
 * The loop: train failures are the only split it inspects; validation selects a
 * candidate; the holdout is a release decision only. The record is saved after
 * every step, so a crash or a stop leaves it complete.
 */
export async function optimize(o: OptimizeOptions, runSplit: RunSplit): Promise<Experiment> {
  let e: Experiment = newExperiment({ id: o.id, surface: o.surface, budgetUsd: o.budgetUsd, criteria: o.criteria });
  const dir = saveExperiment(o.root, e);

  // The optimizer only ever sees train failures: never validation or holdout content.
  const train = await runSplit("train", {}, 1, o.budgetUsd);
  e.trainFailures = trainFailures(train);
  writeFileSync(join(dir, "train-failures.md"), e.trainFailures.map((f) => `- ${f.id}: ${f.why.join("; ")}`).join("\n") + "\n");
  e.spentUsd += spend(train.tasks).spent.usd;
  saveExperiment(o.root, e);
  // A model that reports no cost would spend past --budget unseen: stop until its price (0,0 when free) is given.
  if (stopUnpriced(e, train, o.root)) return e;

  // The validation baseline every candidate is compared against.
  const baseRun = await runSplit("validation", {}, o.trials, o.budgetUsd);
  const baseline = scoreOf(baseRun, "validation");
  e.baselineScore = baseline;
  e.bestScore = baseline;
  e.spentUsd += baseline.costUsd;
  saveExperiment(o.root, e);
  if (stopUnpriced(e, baseRun, o.root)) return e;

  const describe = (s: CandidateSettings): string => Object.entries(s).map(([k, v]) => `${k}=${v}`).join(", ");
  for (const settings of o.candidates) {
    const stop = shouldStop(e);
    if (stop) {
      e.stop = stop;
      break;
    }
    const added = addCandidate(e, settings, describe(settings));
    e = added.experiment;
    const run = await runSplit("validation", settings, o.trials, Math.max(0, o.budgetUsd - e.spentUsd));
    const score = scoreOf(run, "validation");
    const decision = decide(e.bestScore!, score, e.criteria);
    e = applyRound(e, { candidateId: added.candidate.id, validation: score, decision, at: new Date().toISOString() }, score.costUsd);
    saveExperiment(o.root, e);
    // A candidate's model= can be one that reports no cost: the next round's budget would be blind.
    if (stopUnpriced(e, run, o.root)) return e;
  }
  if (!e.stop) e.stop = "done";

  // The holdout is sealed: it only ever runs for a release decision.
  if (o.release && e.best !== "c0") {
    const best = e.candidates.find((c) => c.id === e.best);
    const candidate = await runSplit("holdout", best?.settings ?? {}, o.trials, Math.max(0, o.budgetUsd - e.spentUsd));
    const holdout = scoreOf(candidate, "holdout");
    const base = await runSplit("holdout", {}, o.trials, Math.max(0, o.budgetUsd - e.spentUsd - holdout.costUsd));
    const baselineHoldout = scoreOf(base, "holdout");
    e = { ...e, spentUsd: e.spentUsd + holdout.costUsd + baselineHoldout.costUsd, release: { candidateId: e.best, holdout, baselineHoldout }, updatedAt: new Date().toISOString() };
    saveExperiment(o.root, e);
  }

  saveExperiment(o.root, e);
  console.log(summary(e));
  return e;
}

/** Marks the experiment stopped (cost-unknown) when the run has unpriced trials; true when it did. */
function stopUnpriced(e: Experiment, run: RunResult, root: string): boolean {
  const why = unknownCost(run);
  if (!why) return false;
  e.stop = "cost-unknown";
  saveExperiment(root, e);
  console.log(`${why}\n${summary(e)}`);
  return true;
}

/**
 * Why the budget can't be enforced for this run, or null when every trial is priced.
 * Cached trials count too: a model that reported no cost before won't now, and a
 * fully cached train run would otherwise look priced (0 of 0 fresh trials).
 */
export function unknownCost(run: RunResult): string | null {
  const { measured } = spend(run.tasks);
  if (measured.known === measured.trials) return null;
  return `Spend can't be measured: ${measured.trials - measured.known} of ${measured.trials} trials report no cost, so --budget can't stop the run. Pass --price <in>,<out> (USD per 1M tokens), or --price 0,0 for a free model.`;
}

/** "opt-<surface>-<yyyymmdd-hhmmss>" in UTC. */
function defaultId(surface: string): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `opt-${surface}-${stamp}`;
}

/** --dry: the runs the loop would make, no model calls. */
function plan(o: OptimizeOptions, describe: (s: CandidateSettings) => string): string {
  const lines = [
    `surface ${o.surface} · ${o.candidates.length} candidate(s) · budget $${o.budgetUsd} · ${o.trials} trials`,
    `train: baseline (1 trial) -> ${join(o.root, o.id, "train-failures.md")}`,
    `validation: baseline (${o.trials} trials)`,
  ];
  for (const settings of o.candidates) lines.push(`validation: ${describe(settings)} (${o.trials} trials)`);
  if (o.release) lines.push(`holdout: baseline and the winner (${o.trials} trials, --release)`);
  return lines.join("\n");
}

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2));
  const surfaceArg = f.get("surface");
  if (!surfaceArg) {
    console.error("--surface is required");
    return 2;
  }
  const badSurface = surfaceError(surfaceArg);
  if (badSurface) {
    console.error(badSurface);
    return 2;
  }
  const budgetUsd = Number(f.get("budget"));
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    console.error("--budget must be a number > 0");
    return 2;
  }
  const surface = surfaceArg as Surface;
  const candidates = f.has("try") ? parseTry(f.get("try")!) : [];
  for (const settings of candidates) {
    const bad = settingsError(surface, settings);
    if (bad) {
      console.error(bad);
      return 2;
    }
  }
  const trials = Math.max(3, Math.trunc(Number(f.get("trials") ?? 3)) || 3);
  const o: OptimizeOptions = {
    id: f.get("id") ?? defaultId(surface),
    surface,
    candidates,
    budgetUsd,
    trials,
    release: f.has("release"),
    root: EXPERIMENTS,
    provider: f.get("provider"),
    model: f.get("model"),
    agent: f.get("agent"),
    price: f.get("price"),
  };
  const describe = (s: CandidateSettings): string => Object.entries(s).map(([k, v]) => `${k}=${v}`).join(", ");
  if (f.has("dry")) {
    console.log(plan(o, describe));
    return 0;
  }
  await optimize(o, makeRunSplit(o));
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}
