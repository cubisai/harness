// Eval CLI. Keys come from the environment, e.g.
//   bun --env-file=.env evals/run.ts --tier smoke --provider pgs [--dry]
// Flags: --agent native|claude|codex|opencode (default native), --tier smoke|full,
// --provider th|pgs (native; opencode: pgs), --model <id>, --effort <level> (default low), --trials <n>,
// --task <id>[,<id>…], --dry, --force, --keep, --save-baseline, --max-tokens <n>, --max-usd <n>,
// --price <in>,<out> (USD per 1M tokens), --trend [--last <n>],
// --report [--tier t] [--model m] [--vs <run file>] (re-render the newest run's HTML report, zero tokens),
// --validate-graders [--task ids] (no model: a no-op must fail and evals/references/<task>.json must pass)
// (zero tokens: pass/token history per tier+model from .ai/evals). Plan: .ai/plans/eval-framework.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, setupAgent, type AgentId } from "./lib/agents";
import { incomplete } from "./lib/accounting";
import { compareRuns, renderReport } from "./lib/report";
import { runTask } from "./lib/runner";
import { validateTask } from "./lib/validate";
import { runCheck } from "../src/main/check";
import { RUN_MANIFEST_VERSION, type RunManifest } from "../src/shared/run-trace";
import { assembleTask, cacheKey, EVAL_RUNTIME_VERSION, redact, runFileName, compareBaseline, diffRuns, findCachedTrials, listRuns, previousRun, readBaseline, saveBaseline, saveRun, summarize, trend } from "./lib/store";
import type { RunResult, Task, TaskResult, Tier } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const TASKS = join(ROOT, "evals", "tasks");
const FIXTURES = join(ROOT, "evals", "fixtures");
const RESULTS = join(ROOT, ".ai", "evals");
const BASELINE = join(ROOT, "evals", "baseline.json");
const REFERENCES = join(ROOT, "evals", "references");
const TRACES = join(RESULTS, "traces");
/** Trace folders kept (newest runs); older ones are deleted at the start of a run. */
const TRACE_RUNS_KEPT = 20;

function pruneTraces(): void {
  if (!existsSync(TRACES)) return;
  const dirs = readdirSync(TRACES)
    .map((name) => ({ name, at: statSync(join(TRACES, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const d of dirs.slice(TRACE_RUNS_KEPT - 1)) rmSync(join(TRACES, d.name), { recursive: true, force: true });
}

const fileHash = (...rel: string[]): string =>
  createHash("sha256")
    .update(rel.map((r) => (existsSync(join(ROOT, r)) ? readFileSync(join(ROOT, r), "utf8") : "")).join("\0"))
    .digest("hex")
    .slice(0, 16);

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

/** Writes `<results>/reports/<run>.html`, compared with `base` when given; returns its path. */
function writeReport(run: RunResult, base: RunResult | null, baseLabel?: string): string {
  const dir = join(RESULTS, "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, runFileName(run.meta).replace(/\.json$/, ".html"));
  writeFileSync(path, renderReport(run, base ? compareRuns(base, run) : undefined, baseLabel ?? (base ? base.meta.startedAt : undefined)));
  return path;
}

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2));
  if (f.has("report")) {
    const runs = listRuns(RESULTS).filter((r) => (!f.has("tier") || r.meta.tier === f.get("tier")) && (!f.has("model") || r.meta.model === f.get("model")));
    const run = runs[0];
    if (!run) {
      console.log("no runs");
      return 1;
    }
    const vs = f.get("vs");
    const base = vs ? (JSON.parse(readFileSync(vs, "utf8")) as RunResult) : previousRun(RESULTS, run.meta.tier, run.meta.model, run.meta.startedAt);
    console.log(writeReport(run, base, vs));
    return 0;
  }
  if (f.has("trend")) {
    console.log(trend(listRuns(RESULTS), { tier: f.get("tier"), model: f.get("model"), last: f.has("last") ? Number(f.get("last")) : undefined }));
    return 0;
  }
  if (f.has("validate-graders")) {
    const only = f.get("task")?.split(",");
    let bad = 0;
    for (const task of loadTasks().filter((t) => !only || only.includes(t.id))) {
      if (task.requires?.length) {
        console.log(`skip ${task.id}: needs ${task.requires.join(", ")}, unavailable in the eval runner`);
        continue;
      }
      const v = await validateTask(task, {
        fixturesRoot: FIXTURES,
        referencesRoot: REFERENCES,
        runCommand: async (command, cwd, timeoutMs) => {
          const r = await runCheck(command, cwd, { timeoutMs });
          return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
        },
      });
      if (v.problems.length) bad++;
      console.log(`${v.problems.length ? "BAD " : "OK  "} ${task.id.padEnd(24)} ${v.problems.join("; ")}`);
      if (f.has("verbose") || v.problems.some((p) => p !== "no reference solution")) for (const line of [...v.noop.why.map((w) => `noop ${w}`), ...(v.reference?.why.map((w) => `ref  ${w}`) ?? [])]) console.log(`       ${line}`);
    }
    return bad ? 1 : 0;
  }
  const tier = (f.get("tier") ?? "smoke") as Tier;
  const agent = (f.get("agent") ?? "native") as AgentId;
  if (!AGENTS.includes(agent)) throw new Error(`--agent must be one of ${AGENTS.join(", ")}`);
  const trials = Number(f.get("trials") ?? 1);
  const effort = f.get("effort") ?? "low";
  // The grading and trial code: a change there makes cached trials incomparable.
  const graderVersion = fileHash("evals/lib/graders.ts", "evals/lib/runner.ts");
  const maxTokens = Number(f.get("max-tokens") ?? Infinity);
  const maxUsd = Number(f.get("max-usd") ?? Infinity);
  const priceArg = f.get("price")?.split(",").map(Number);
  const price = priceArg && priceArg.length === 2 ? { input: priceArg[0]!, output: priceArg[1]! } : undefined;

  const selected = loadTasks().filter((t) => (tier === "smoke" ? t.tier === "smoke" : true) && (!f.has("task") || f.get("task")!.split(",").includes(t.id)));
  // Tasks needing Electron's browser or team runtime can't run here; say so and leave them out.
  for (const t of selected) if (t.requires?.length) console.log(`skip ${t.id}: needs ${t.requires.join(", ")}, unavailable in the eval runner`);
  const tasks = selected.filter((t) => !t.requires?.length);
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
  const manifest: RunManifest = {
    version: RUN_MANIFEST_VERSION,
    runId: runFileName({ tier, model, startedAt } as RunResult["meta"]).replace(/\.json$/, ""),
    origin: "eval",
    agent,
    requestedModel: f.get("model") ?? "default",
    model: setup.model,
    protocol,
    effort,
    versions: {
      harness: hash,
      graders: graderVersion,
      runtime: EVAL_RUNTIME_VERSION,
      guide: fileHash("resources/CUBIQ.md"),
      tasks: createHash("sha256").update(tasks.map((t) => JSON.stringify(t)).join("\n")).digest("hex").slice(0, 16),
      app: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string,
      ...(setup.version ? { cli: setup.version } : {}),
    },
    price: price ? { ...price, source: "--price" } : null,
    budget: { maxTokens: Number.isFinite(maxTokens) ? maxTokens : null, maxUsd: Number.isFinite(maxUsd) ? maxUsd : null, trials },
    fidelity: setup.fidelity,
    platform: `${process.platform}-${process.arch}`,
    startedAt,
  };
  pruneTraces();
  const trace = { dir: join(TRACES, manifest.runId), root: RESULTS, fidelity: setup.fidelity, redact: (text: string) => redact(text), sessionFile: setup.sessionFile };
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
          ? (await runTask({ task, fixturesRoot: FIXTURES, driver, model: setup.model, effort, skillDirs, price, keep: f.has("keep"), trials: want - reused.length, cacheKey: ck, trace })).trials
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

  const run: RunResult = { meta: { tier, agent, model, protocol, harnessHash: hash, effort, manifest, startedAt, durationMs: Date.now() - Date.parse(startedAt) }, tasks: results };
  const path = saveRun(RESULTS, run);
  console.log(`\n${summarize(run)}`);
  const prev = previousRun(RESULTS, tier, model, startedAt);
  const diff = diffRuns(prev, run);
  if (diff) console.log(`\n${diff}`);
  const baseline = readBaseline(BASELINE);
  const vsBaseline = compareBaseline(baseline, run);
  if (vsBaseline) console.log(vsBaseline);
  if (f.has("save-baseline")) {
    saveBaseline(BASELINE, run);
    console.log(`baseline saved for ${tier}|${model}`);
  }
  console.log(`\nsaved ${path}`);
  console.log(`report ${writeReport(run, prev)}`);
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
