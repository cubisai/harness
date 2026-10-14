// Eval CLI. Keys come from the environment, e.g.
//   bun --env-file=.env evals/run.ts --tier smoke --provider pgs [--dry]
// Flags: --tier smoke|full, --provider th|pgs, --model <id>, --trials <n>,
// --task <id>, --dry, --force, --keep, --save-baseline, --max-tokens <n>, --max-usd <n>,
// --price <in>,<out> (USD per 1M tokens). Plan: .ai/plans/eval-framework.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import type { HarnessProtocol } from "../src/main/harness/llm/types";
import { SessionStore } from "../src/main/harness/session";
import { discoverSkills } from "../src/main/skills/discover";
import { skillTool } from "../src/main/skills/tool";
import type { Provider } from "../src/shared/types";
import { runTask } from "./lib/runner";
import { cacheKey, compareBaseline, diffRuns, findCached, previousRun, readBaseline, saveBaseline, saveRun, summarize } from "./lib/store";
import type { RunResult, Task, TaskResult, Tier } from "./lib/types";

const ROOT = join(import.meta.dirname, "..");
const TASKS = join(ROOT, "evals", "tasks");
const FIXTURES = join(ROOT, "evals", "fixtures");
const RESULTS = join(ROOT, ".ai", "evals");
const BASELINE = join(ROOT, "evals", "baseline.json");

const PRESETS: Record<string, { envVar: string; baseURL: string; protocol: HarnessProtocol; model: string }> = {
  th: { envVar: "TOKENHARBOR_API_KEY", baseURL: "https://tokenharbor.ai/v1", protocol: "anthropic-messages", model: "claude-haiku-5.5" },
  pgs: { envVar: "PGS_API_KEY", baseURL: "https://api.pgsgrove.com/v1", protocol: "openai-chat", model: "deepseek-v4.1-flash" },
};

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

/** The harness and skills code the result depends on: their git trees, plus uncommitted changes. */
function harnessHash(): string {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const paths = ["src/main/harness", "src/main/skills"];
  const trees = paths.map((p) => git("rev-parse", `HEAD:${p}`)).join("");
  const dirty = git("diff", "HEAD", "--", ...paths);
  return createHash("sha256").update(trees + dirty).digest("hex").slice(0, 16);
}

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2));
  const tier = (f.get("tier") ?? "smoke") as Tier;
  const preset = PRESETS[f.get("provider") ?? "pgs"];
  if (!preset) throw new Error(`--provider must be one of ${Object.keys(PRESETS).join(", ")}`);
  const model = f.get("model") ?? preset.model;
  const trials = Number(f.get("trials") ?? 1);
  const maxTokens = Number(f.get("max-tokens") ?? Infinity);
  const maxUsd = Number(f.get("max-usd") ?? Infinity);
  const priceArg = f.get("price")?.split(",").map(Number);
  const price = priceArg && priceArg.length === 2 ? { input: priceArg[0]!, output: priceArg[1]! } : undefined;

  const tasks = loadTasks().filter((t) => (tier === "smoke" ? t.tier === "smoke" : true) && (!f.has("task") || t.id === f.get("task")));
  const trialsOf = (t: Task) => (t.tags.includes("regression") ? trials : 1);

  if (f.has("dry")) {
    const worst = tasks.reduce((n, t) => n + trialsOf(t) * t.budget.maxInputTokens, 0);
    console.log(`${tasks.length} tasks, ${tasks.reduce((n, t) => n + trialsOf(t), 0)} trials, worst case ${worst.toLocaleString()} input tokens${price ? ` ≈ $${((worst * price.input) / 1e6).toFixed(2)}` : ""}`);
    for (const t of tasks) console.log(`  ${t.id.padEnd(28)} ×${trialsOf(t)}  ≤${t.budget.maxInputTokens.toLocaleString()} tok  ≤${t.budget.maxSteps} steps`);
    return 0;
  }

  const key = process.env[preset.envVar] ?? "";
  if (!key) throw new Error(`${preset.envVar} is not set (run with bun --env-file=.env)`);
  const provider: Provider = {
    id: "eval",
    label: "eval",
    wireProtocol: preset.protocol,
    baseURL: preset.baseURL,
    secret: { kind: "envRef", envVar: preset.envVar },
    models: [{ id: model, name: model, capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 200_000, maxOutput: 8_000 }],
  };
  const scratch = mkdtempSync(join(tmpdir(), "eval-run-"));
  const driver = () =>
    createProviderDriver("eval", {
      provider: () => provider,
      secret: () => key,
      secretHeaders: () => ({}),
      sessions: new SessionStore(join(scratch, "sessions")),
      outputDir: join(scratch, "out"),
      guardScript: BUILT_IN_GUARD,
      guide: () => null,
      memory: () => null,
      mcpTools: () => [],
      skills: (dir) => {
        const found = discoverSkills({ origin: "project", dir: join(dir, ".agents", "skills") });
        return found.length ? skillTool(() => found) : null;
      },
    });

  const hash = harnessHash();
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
      const ck = cacheKey(task, join(FIXTURES, task.fixture), model, preset.protocol, hash);
      const hit = f.has("force") ? null : findCached(RESULTS, ck);
      const r = hit ?? (await runTask({ task, fixturesRoot: FIXTURES, driver, model, price, keep: f.has("keep"), trials: trialsOf(task), cacheKey: ck }));
      results.push(r);
      if (!r.cached) {
        spentTokens += r.trials.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0);
        spentUsd += r.trials.reduce((n, t) => n + (t.costUsd ?? 0), 0);
      }
      console.log(`${r.passAtK ? "PASS" : "FAIL"} ${task.id}${r.cached ? " (cached)" : ""}`);
      const harnessError = r.trials.find((t) => t.harnessError)?.harnessError;
      if (harnessError) {
        console.log(`harness error, stopping: ${harnessError}`);
        break;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const run: RunResult = { meta: { tier, agent: "native", model, protocol: preset.protocol, harnessHash: hash, startedAt, durationMs: Date.now() - Date.parse(startedAt) }, tasks: results };
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
