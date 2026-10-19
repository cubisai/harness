// Eval CLI. Keys come from the environment, e.g.
//   bun --env-file=.env evals/run.ts --tier smoke --provider pgs [--dry]
// Flags: --agent native|claude|codex|opencode (default native), --tier smoke|full,
// --provider th|pgs (native; opencode: pgs), --model <id>, --effort <level> (default low), --trials <n>,
// --task <id>[,<id>…], --dry, --force, --keep, --save-baseline, --max-tokens <n>, --max-usd <n>,
// --price <in>,<out> (USD per 1M tokens), --trend [--last <n>],
// --report [--tier t] [--model m] [--vs <run file>] (re-render the newest run's HTML report, zero tokens),
// --validate-graders [--task ids] (no model: a no-op must fail and evals/references/<task>.json must pass)
// --stability [N] [--task ids] (no model: re-runs grader validation N times; exit 1 when a verdict flips)
// --calibrate-judge <name> [--provider p] [--model m] (judges evals/judges/<name>.json's labelled examples, stores the report; exit 1 below the bar)
// --split train|validation|holdout [--release] (only that split; the holdout is sealed unless --release),
// --guide <file> (a project guide for the agent; its hash joins every trial's cache key),
// --out <file> (also write the run JSON there),
// --splits (no model: the split summary and any leakage across splits; exit 1 when there is any)
// (zero tokens: pass/token history per tier+model from .ai/evals). Plan: .ai/plans/eval-framework.md.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENTS, setupAgent, type AgentId } from "./lib/agents";
import { incomplete } from "./lib/accounting";
import { compareRuns, renderReport } from "./lib/report";
import { runTask } from "./lib/runner";
import { validateTask } from "./lib/validate";
import { formatStability, stability } from "./lib/calibrate";
import { askFor } from "./lib/ask";
import { calibrate, isCalibrated, loadCalibration, MIN_ACCURACY, MIN_EXAMPLES } from "./lib/judge";
import { runCheck } from "../src/main/check";
import { AgentBrowserBackend, resolveAgentBrowser } from "../src/main/browser/agent-browser";
import { RUN_MANIFEST_VERSION, type RunManifest } from "../src/shared/run-trace";
import { assembleTask, cacheKey, EVAL_RUNTIME_VERSION, redact, runFileName, compareBaseline, diffRuns, findCachedTrials, listRuns, previousRun, readBaseline, saveBaseline, saveRun, summarize, trend } from "./lib/store";
import { checkSplits, forSplit, SPLIT_SHARES, splitSummary } from "./lib/splits";
import type { RunResult, Split, Task, TaskResult, Tier } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const TASKS = join(ROOT, "evals", "tasks");
const FIXTURES = join(ROOT, "evals", "fixtures");
const RESULTS = join(ROOT, ".ai", "evals");
const BASELINE = join(ROOT, "evals", "baseline.json");
const REFERENCES = join(ROOT, "evals", "references");
const JUDGES = join(ROOT, "evals", "judges");
const TRACES = join(RESULTS, "traces");
/** Trace folders kept (newest runs); older ones are deleted at the start of a run. */
const TRACE_RUNS_KEPT = 20;
/** The dataset splits (roadmap P8.1): train/validation/holdout. */
const SPLITS = Object.keys(SPLIT_SHARES) as Split[];

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
  // The grader command hook both --validate-graders and --stability grade through.
  const checkRunner = () => async (command: string, cwd: string, timeoutMs: number) => {
    const r = await runCheck(command, cwd, { timeoutMs });
    return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
  };
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
      if (task.requires?.includes("team")) {
        console.log(`skip ${task.id}: needs team, unavailable in the eval runner`);
        continue;
      }
      const v = await validateTask(task, {
        fixturesRoot: FIXTURES,
        referencesRoot: REFERENCES,
        runCommand: checkRunner(),
      });
      if (v.problems.length) bad++;
      console.log(`${v.problems.length ? "BAD " : "OK  "} ${task.id.padEnd(24)} ${v.problems.join("; ")}`);
      if (f.has("verbose") || v.problems.some((p) => p !== "no reference solution")) for (const line of [...v.noop.why.map((w) => `noop ${w}`), ...(v.reference?.why.map((w) => `ref  ${w}`) ?? [])]) console.log(`       ${line}`);
    }
    return bad ? 1 : 0;
  }
  if (f.has("stability")) {
    const only = f.get("task")?.split(",");
    const requested = Number(f.get("stability"));
    // A missing or non-numeric N falls back to 3; a real one is clamped to 2..20.
    const n = Number.isFinite(requested) ? Math.min(20, Math.max(2, Math.round(requested))) : 3;
    let flaky = 0;
    for (const task of loadTasks().filter((t) => !only || only.includes(t.id))) {
      if (task.requires?.includes("team")) {
        console.log(`skip ${task.id}: needs team, unavailable in the eval runner`);
        continue;
      }
      const s = await stability(task, n, (t) => validateTask(t, { fixturesRoot: FIXTURES, referencesRoot: REFERENCES, runCommand: checkRunner() }));
      if (s.flips.length) flaky++;
      console.log(formatStability(s));
    }
    return flaky ? 1 : 0;
  }
  if (f.has("calibrate-judge")) {
    const name = f.get("calibrate-judge")!;
    const c = loadCalibration(JUDGES, name);
    if (!c) {
      console.error(`no calibration file: evals/judges/${name}.json`);
      return 2;
    }
    if (c.examples.length < MIN_EXAMPLES) {
      console.log(`BAD  ${name}: ${c.examples.length} labelled examples, needs at least ${MIN_EXAMPLES}`);
      return 1;
    }
    const { model, ask } = askFor({ provider: f.get("provider"), model: f.get("model") });
    const r = await calibrate(ask, c.rubric, c.examples);
    const next = { ...c, report: { ...r, model, at: new Date().toISOString() } };
    writeFileSync(join(JUDGES, `${name}.json`), `${JSON.stringify(next, null, 2)}\n`);
    const ok = isCalibrated(next);
    console.log(`${ok ? "OK  " : "BAD "} ${name}: accuracy ${r.accuracy.toFixed(2)} on ${r.n}, kappa ${r.agreement.toFixed(2)} (${model})${ok ? "" : ` — needs ≥ ${MIN_ACCURACY} to count`}`);
    return ok ? 0 : 1;
  }
  if (f.has("splits")) {
    const tasks = loadTasks();
    console.log(splitSummary(tasks));
    const problems = checkSplits(tasks);
    for (const p of problems) console.log(`BAD  ${p.kind.padEnd(16)} ${p.tasks[0]} / ${p.tasks[1]}: ${p.detail}`);
    if (!problems.length) console.log("OK   no leakage across splits");
    return problems.length ? 1 : 0;
  }
  // A split spans the whole case set, so it defaults to the full tier (smoke cases are a handful across splits).
  const tier = (f.get("tier") ?? (f.has("split") ? "full" : "smoke")) as Tier;
  const agent = (f.get("agent") ?? "native") as AgentId;
  if (!AGENTS.includes(agent)) throw new Error(`--agent must be one of ${AGENTS.join(", ")}`);
  const splitArg = f.get("split");
  if (splitArg !== undefined && !SPLITS.includes(splitArg as Split)) {
    console.error(`--split must be one of ${SPLITS.join(", ")} (got "${splitArg}")`);
    return 2;
  }
  const trials = Number(f.get("trials") ?? 1);
  const effort = f.get("effort") ?? "low";
  // --guide swaps the agent's project guide; a candidate's file must exist.
  const guideArg = f.get("guide");
  const guidePath = guideArg ? resolve(ROOT, guideArg) : undefined;
  if (guidePath !== undefined && !existsSync(guidePath)) {
    console.error(`--guide: no such file: ${guideArg}`);
    return 2;
  }
  // The grading and trial code: a change there makes cached trials incomparable.
  const graderVersion = fileHash("evals/lib/graders.ts", "evals/lib/runner.ts");
  const maxTokens = Number(f.get("max-tokens") ?? Infinity);
  const maxUsd = Number(f.get("max-usd") ?? Infinity);
  const priceArg = f.get("price")?.split(",").map(Number);
  const price = priceArg && priceArg.length === 2 ? { input: priceArg[0]!, output: priceArg[1]! } : undefined;

  const loaded = loadTasks();
  // --split narrows to one split before --task/--tier; the holdout stays sealed unless --release.
  const splitTasks = splitArg !== undefined ? forSplit(loaded, splitArg as Split, { sealed: !f.has("release") }) : loaded;
  const selected = splitTasks.filter((t) => (tier === "smoke" ? t.tier === "smoke" : true) && (!f.has("task") || f.get("task")!.split(",").includes(t.id)));
  // A browser task runs on a headless agent-browser session when the CLI is installed; the team runtime needs Electron.
  const headless = resolveAgentBrowser();
  const unavailable = (t: Task): string | null => (t.requires?.includes("team") ? "team" : t.requires?.includes("browser") && !headless ? "browser (agent-browser isn't installed)" : null);
  for (const t of selected) {
    const why = unavailable(t);
    if (why) console.log(`skip ${t.id}: needs ${why}, unavailable in the eval runner`);
  }
  const tasks = selected.filter((t) => !unavailable(t));
  const trialsOf = (t: Task) => (t.tags.includes("regression") ? trials : 1);

  if (f.has("dry")) {
    const worst = tasks.reduce((n, t) => n + trialsOf(t) * t.budget.maxInputTokens, 0);
    console.log(`${tasks.length} tasks, ${tasks.reduce((n, t) => n + trialsOf(t), 0)} trials, worst case ${worst.toLocaleString()} input tokens${price ? ` ≈ $${((worst * price.input) / 1e6).toFixed(2)}` : ""}`);
    for (const t of tasks) console.log(`  ${t.id.padEnd(28)} ×${trialsOf(t)}  ≤${t.budget.maxInputTokens.toLocaleString()} tok  ≤${t.budget.maxSteps} steps`);
    return 0;
  }

  const scratch = mkdtempSync(join(tmpdir(), "eval-run-"));
  const setup = setupAgent(agent, { root: ROOT, scratch, provider: f.get("provider"), model: f.get("model"), guide: guidePath });
  const { driver, label: model, protocol, skillDirs } = setup;
  console.log(`agent ${agent} · ${model}${setup.version ? ` · ${setup.version}` : ""}`);

  // A custom guide changes the prompt, so its content joins the cache key; runs
  // without --guide keep the plain harness hash and their existing keys.
  const guideHash = guidePath ? createHash("sha256").update(readFileSync(guidePath, "utf8")).digest("hex").slice(0, 16) : "";
  const hash = guidePath ? `${harnessHash(setup.hashPaths, setup.version)}:${guideHash}` : harnessHash(setup.hashPaths, setup.version);
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
      guide: guideHash || fileHash("resources/CUBIQ.md"),
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
  // Judge graders get a model only when some task has one; an uncalibrated judge still leaves its trial ungraded.
  const judge = tasks.some((t) => t.graders.some((g) => g.type === "judge")) ? { ask: askFor({ provider: f.get("provider") }).ask, root: JUDGES } : undefined;
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
          ? (await runTask({ task, fixturesRoot: FIXTURES, driver, model: setup.model, effort, skillDirs, price, keep: f.has("keep"), trials: want - reused.length, cacheKey: ck, trace, judge, browser: () => (headless ? new AgentBrowserBackend({ session: `cubiq-eval-${randomUUID().slice(0, 8)}`, command: headless, screenshotDir: join(scratch, "shots") }) : null) })).trials
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
  const outArg = f.get("out");
  if (outArg) {
    const outPath = resolve(ROOT, outArg);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, redact(JSON.stringify(run, null, 1)));
    console.log(`out ${outPath}`);
  }
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
