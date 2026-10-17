// Eval CLI. Keys come from the environment, e.g.
//   bun --env-file=.env evals/run.ts --tier smoke --provider pgs [--dry]
// Flags: --agent native|claude|codex|opencode (default native), --tier smoke|full,
// --provider th|pgs (native; opencode: pgs), --model <id>, --effort <level> (default low), --trials <n>,
// --task <id>[,<id>…], --dry, --force, --keep, --save-baseline, --max-tokens <n>, --max-usd <n>,
// --price <in>,<out> (USD per 1M tokens), --trend [--last <n>]
// (zero tokens: pass/token history per tier+model from .ai/evals). Plan: .ai/plans/eval-framework.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, setupAgent, type AgentId } from "./lib/agents";
import { incomplete } from "./lib/accounting";
import { runTask } from "./lib/runner";
import { assembleTask, cacheKey, compareBaseline, diffRuns, findCachedTrials, listRuns, previousRun, readBaseline, saveBaseline, saveRun, summarize, trend } from "./lib/store";
import type { RunResult, Task, TaskResult, Tier } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const TASKS = join(ROOT, "evals", "tasks");
const FIXTURES = join(ROOT, "evals", "fixtures");
const RESULTS = join(ROOT, ".ai", "evals");
const BASELINE = join(ROOT, "evals", "baseline.json");

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

export function loadTasks(dir = TASKS): Task[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Task;
      if (!t.id || !t.prompt || !t.fixture || !Array.isArray(t.graders) || !t.budget) throw new Error(`evals/tasks/${f}: missing id, prompt, fixture, graders or budget`);
      return t;
    });
}

/** The code a result depends on: the git trees of `paths`, their uncommitted changes, and the agent's CLI version. */
function harnessHash(paths: string[], version: string): string {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const trees = paths.map((p) => git("rev-parse", `HEAD:${p}`)).join("");
  const dirty = git("diff", "HEAD", "--", ...paths);
  return createHash("sha256").update(trees + dirty + version).digest("hex").slice(0, 16);
}

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2));
  if (f.has("trend")) {
    console.log(trend(listRuns(RESULTS), { tier: f.get("tier"), model: f.get("model"), last: f.has("last") ? Number(f.get("last")) : undefined }));
    return 0;
  }
  const tier = (f.get("tier") ?? "smoke") as Tier;
  const agent = (f.get("agent") ?? "native") as AgentId;
  if (!AGENTS.includes(agent)) throw new Error(`--agent must be one of ${AGENTS.join(", ")}`);
  const trials = Number(f.get("trials") ?? 1);
  const effort = f.get("effort") ?? "low";
  // The grading and trial code: a change there makes cached trials incomparable.
  const graderVersion = createHash("sha256")
    .update(["graders.ts", "runner.ts"].map((f) => readFileSync(join(ROOT, "evals", "lib", f), "utf8")).join("\0"))
    .digest("hex")
    .slice(0, 16);
  const maxTokens = Number(f.get("max-tokens") ?? Infinity);
  const maxUsd = Number(f.get("max-usd") ?? Infinity);
  const priceArg = f.get("price")?.split(",").map(Number);
  const price = priceArg && priceArg.length === 2 ? { input: priceArg[0]!, output: priceArg[1]! } : undefined;

  const tasks = loadTasks().filter((t) => (tier === "smoke" ? t.tier === "smoke" : true) && (!f.has("task") || f.get("task")!.split(",").includes(t.id)));
  const trialsOf = (t: Task) => (t.tags.includes("regression") ? trials : 1);

  if (f.has("dry")) {
    const worst = tasks.reduce((n, t) => n + trialsOf(t) * t.budget.maxInputTokens, 0);
    console.log(`${tasks.length} tasks, ${tasks.reduce((n, t) => n + trialsOf(t), 0)} trials, worst case ${worst.toLocaleString()} input tokens${price ? ` ≈ $${((worst * price.input) / 1e6).toFixed(2)}` : ""}`);
    for (const t of tasks) console.log(`  ${t.id.padEnd(28)} ×${trialsOf(t)}  ≤${t.budget.maxInputTokens.toLocaleString()} tok  ≤${t.budget.maxSteps} steps`);
    return 0;
  }

  const scratch = mkdtempSync(join(tmpdir(), "eval-run-"));
  const setup = setupAgent(agent, { root: ROOT, scratch, provider: f.get("provider"), model: f.get("model") });
  const { driver, label: model, protocol, skillDirs } = setup;
  console.log(`agent ${agent} · ${model}${setup.version ? ` · ${setup.version}` : ""}`);

  const hash = harnessHash(setup.hashPaths, setup.version);
  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];
  let spentTokens = 0;
  let spentUsd = 0;
  try {
    for (const task of tasks) {
      if (spentTokens >= maxTokens || spentUsd >= maxUsd) {
        console.log(`budget reached (${spentTokens} tokens, $${spentUsd.toFixed(2)}); skipping the rest`);
        break;
      }
      const ck = cacheKey(task, join(FIXTURES, task.fixture), model, protocol, hash, { effort, graderVersion });
      // Trial-level cache: reuse what's stored and run only the missing trials.
      const want = trialsOf(task);
      const reused = f.has("force") ? [] : findCachedTrials(RESULTS, ck).slice(0, want);
      const fresh =
        reused.length < want
          ? (await runTask({ task, fixturesRoot: FIXTURES, driver, model: setup.model, effort, skillDirs, price, keep: f.has("keep"), trials: want - reused.length, cacheKey: ck })).trials
          : [];
      const r = assembleTask(task, ck, want, reused, fresh);
      results.push(r);
      spentTokens += fresh.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0);
      spentUsd += fresh.reduce((n, t) => n + (t.costUsd ?? 0), 0);
      console.log(`${r.passAtK ? "PASS" : "FAIL"} ${task.id}${r.cached ? " (cached)" : reused.length ? ` (${reused.length} cached + ${fresh.length} run)` : ""}`);
      const harnessError = r.trials.find((t) => t.harnessError)?.harnessError;
      if (harnessError) {
        console.log(`harness error, stopping: ${harnessError}`);
        break;
      }
    }
  } finally {
    setup.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }

  const run: RunResult = { meta: { tier, agent, model, protocol, harnessHash: hash, effort, startedAt, durationMs: Date.now() - Date.parse(startedAt) }, tasks: results };
  const path = saveRun(RESULTS, run);
  console.log(`\n${summarize(run)}`);
  const diff = diffRuns(previousRun(RESULTS, tier, model, startedAt), run);
  if (diff) console.log(`\n${diff}`);
  const baseline = readBaseline(BASELINE);
  const vsBaseline = compareBaseline(baseline, run);
  if (vsBaseline) console.log(vsBaseline);
  if (f.has("save-baseline")) {
    saveBaseline(BASELINE, run);
    console.log(`baseline saved for ${tier}|${model}`);
  }
  console.log(`\nsaved ${path}`);
  // An incomplete run is never a quality pass, whatever the baseline says about the tasks that did run.
  const gaps = incomplete(results, tasks.length);
  if (gaps.length) {
    console.log(`incomplete: ${gaps.join("; ")}`);
    return 2;
  }
  // With a baseline, only backsliding fails the run; without one, any failing regression task does.
  if (baseline[`${tier}|${model}`]) return vsBaseline.includes("below baseline") ? 1 : 0;
  return results.some((r) => r.tags.includes("regression") && !r.passAtK) ? 1 : 0;
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
