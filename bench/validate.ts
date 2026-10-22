// Proves each task is fair before its results are trusted (zero model calls):
// the untouched start must fail the required graders, and for a replayed
// commit the real change must pass them all (typecheck included).
//   bun bench/validate.ts [--tasks a,b]

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade } from "../evals/lib/graders";
import type { Task } from "../evals/lib/types";
import { runCheck } from "../src/main/check";
import { layTree, repoTree, revealHidden, sourceOf } from "./lib/project";
import type { BenchTask } from "./lib/types";

const BENCH = import.meta.dirname;
const only = process.argv.includes("--tasks") ? process.argv[process.argv.indexOf("--tasks") + 1]!.split(",") : null;
const tasks = readdirSync(join(BENCH, "tasks"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(BENCH, "tasks", f), "utf8")) as BenchTask)
  .filter((t) => !only || only.includes(t.id));

async function graded(task: BenchTask, tree: string): Promise<{ required: boolean; all: boolean; why: string }> {
  const dir = mkdtempSync(join(tmpdir(), `bench-validate-${task.id}-`));
  try {
    layTree(tree, dir, Boolean(task.git));
    revealHidden(task, dir);
    const evalTask = { id: task.id, tags: ["regression"], tier: "smoke", fixture: "", prompt: task.prompt, mode: "full", graders: task.graders, budget: { maxSteps: 0, maxInputTokens: 0, timeoutMs: 0 } } satisfies Task;
    const results = await grade({
      task: evalTask,
      events: [],
      dir,
      fixtureDir: tree,
      overBudget: false,
      runCommand: async (command, cwd, timeoutMs) => {
        const r = await runCheck(command, cwd, { timeoutMs });
        return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
      },
    });
    return {
      required: results.every((r) => !r.required || r.pass),
      all: results.every((r) => r.pass),
      why: results.map((r) => `${r.pass ? "✓" : "✗"} ${r.why.replace(/\s+/g, " ").slice(0, 160)}`).join("\n      "),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let bad = 0;
for (const task of tasks) {
  // Answer graders need a transcript; those tasks are checked by reading results.
  if (task.graders.every((g) => g.type === "answer")) {
    console.log(`- ${task.id}: answer-only, skipped`);
    continue;
  }
  const start = await graded(task, sourceOf(task));
  const startOk = !start.required;
  console.log(`${startOk ? "✓" : "✗"} ${task.id}: untouched start ${start.required ? "PASSES (unfair: nothing to do)" : "fails"}\n      ${start.why}`);
  if (!startOk) bad++;
  if (task.repo?.hidden) {
    const ref = await graded(task, repoTree(task.repo.hidden.commit, "guides", task.repo.install));
    console.log(`${ref.all ? "✓" : "✗"} ${task.id}: real change ${task.repo.hidden.commit} ${ref.all ? "passes" : "FAILS (unfair: the reference can't pass)"}\n      ${ref.why}`);
    if (!ref.all) bad++;
  }
}
console.log(bad ? `\n${bad} problem(s)` : "\nall tasks fair");
process.exit(bad ? 1 : 0);
