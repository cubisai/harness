// The eval runner on a scripted model: zero tokens, real fixtures, real
// native tools and real grader commands.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import { emptyUsage, type AssistantPart, type LlmEvent } from "../src/main/harness/llm/types";
import { SessionStore } from "../src/main/harness/session";
import type { Provider } from "../src/shared/types";
import { runTask, runTrial } from "../evals/lib/runner";
import type { Task } from "../evals/lib/types";
import { loadTasks } from "../evals/run";
import { tempDir } from "./helpers";

const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "evals", "fixtures");
const tasks = new Map(loadTasks().map((t) => [t.id, t]));
const task = (id: string): Task => structuredClone(tasks.get(id)!);

const provider: Provider = {
  id: "eval",
  label: "eval",
  wireProtocol: "openai-chat",
  baseURL: "http://127.0.0.1:9",
  secret: { kind: "envRef", envVar: "NONE" },
  models: [{ id: "m", name: "m", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 200_000, maxOutput: 4_000 }],
};

const call = (name: string, input: Record<string, unknown>, id = `c${Math.random().toString(36).slice(2, 8)}`): AssistantPart => ({ type: "tool-call", id, name, input });
const text = (t: string): AssistantPart => ({ type: "text", text: t });

/** A driver whose model plays `answers` in order (the last one repeats); `seen` runs before each call. */
function scripted(answers: AssistantPart[][], seen?: (cwd: string) => void, inputTokens = 1000) {
  let calls = 0;
  const driver = (cwd: string) => {
    const data = tempDir();
    let n = 0;
    return createProviderDriver("eval", {
      provider: () => provider,
      secret: () => "sk-test",
      secretHeaders: () => ({}),
      sessions: new SessionStore(join(data, "sessions")),
      outputDir: join(data, "out"),
      guardScript: BUILT_IN_GUARD,
      guide: () => null,
      memory: () => null,
      mcpTools: () => [],
      stream: async function* (): AsyncGenerator<LlmEvent> {
        calls++;
        seen?.(cwd);
        const message = answers[Math.min(n++, answers.length - 1)]!;
        const usage = { ...emptyUsage(), inputTokens, outputTokens: 50 };
        yield { type: "usage", usage };
        yield { type: "finish", reason: message.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", message, usage };
      },
    });
  };
  return { driver, calls: () => calls };
}

const FIX = [
  [call("read", { path: "src/range.js" })],
  [call("edit", { path: "src/range.js", old_string: "i < b", new_string: "i <= b" })],
  [text("Fixed: the loop now includes b.")],
];

describe("eval runner (scripted model)", () => {
  it("passes fix-off-by-one when the edit is right, with the hidden test run after the turn", async () => {
    let hiddenDuringTurn = false;
    const s = scripted(FIX, (cwd) => (hiddenDuringTurn ||= existsSync(join(cwd, "test", "range.test.mjs"))));
    const r = await runTrial({ task: task("fix-off-by-one"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(hiddenDuringTurn).toBe(false);
    expect(r.graders.map((g) => [g.type, g.pass])).toEqual([["command", true], ["file", true], ["event", true], ["budget", true]]);
    expect(r).toMatchObject({ pass: true, score: 1, overBudget: false, harnessError: null, toolCalls: 2 });
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.events.some((e) => e.kind === "tool-use" && e.name === "Edit")).toBe(true);
  }, 60_000);

  it("fails it when the agent only claims the tests pass", async () => {
    const s = scripted([[text("Done, all tests pass.")]]);
    const r = await runTrial({ task: task("fix-off-by-one"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.pass).toBe(false);
    expect(r.graders.find((g) => g.type === "command")?.pass).toBe(false);
    expect(r.graders.find((g) => g.type === "event")?.why).toMatch(/claimed/);
    expect(r.score).toBeLessThan(0.5);
  }, 60_000);

  it("aborts a turn over its step budget and fails the budget grader", async () => {
    const t = task("explain-no-edit");
    t.budget.maxSteps = 2;
    const s = scripted([[call("read", { path: "src/sum.js" })]]);
    const r = await runTrial({ task: t, fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.overBudget).toBe(true);
    expect(r.graders.find((g) => g.type === "budget")?.pass).toBe(false);
    expect(s.calls()).toBeLessThanOrEqual(4);
  });

  it("aborts a turn over its input-token budget", async () => {
    const t = task("explain-no-edit");
    t.budget.maxInputTokens = 500;
    const s = scripted([[call("read", { path: "src/sum.js" })]], undefined, 1000);
    const r = await runTrial({ task: t, fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.overBudget).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it("passes explain-no-edit on a read and an answer, and fails it on an edit", async () => {
    const ok = await runTrial({ task: task("explain-no-edit"), fixturesRoot: FIXTURES, driver: scripted([[call("read", { path: "src/sum.js" })], [text("It sums finite numbers.")]]).driver, model: "m" });
    expect(ok.pass).toBe(true);
    // Plan mode blocks the edit itself; the grader still sees the attempt.
    const bad = await runTrial({
      task: task("explain-no-edit"),
      fixturesRoot: FIXTURES,
      driver: scripted([[call("read", { path: "src/sum.js" })], [call("edit", { path: "src/sum.js", old_string: "total", new_string: "t" })], [text("Renamed.")]]).driver,
      model: "m",
    });
    expect(bad.graders.find((g) => g.type === "tool")?.pass).toBe(false);
    expect(bad.graders.find((g) => g.type === "file")?.pass).toBe(true);
    expect(bad.pass).toBe(false);
  });

  it("ends a plan-mode turn at the proposal and grades it", async () => {
    const s = scripted([[call("read", { path: "src/form.js" })], [call("propose_plan", { plan: "## Goal\nValidate email and age in submit()." })], [text("unreachable")]]);
    const r = await runTrial({ task: task("plan-proposes"), fixturesRoot: FIXTURES, driver: s.driver, model: "m" });
    expect(r.graders.map((g) => [g.type, g.pass])).toEqual([["tool", true], ["tool", true], ["file", true], ["event", true], ["budget", true]]);
    expect(r.pass).toBe(true);
    expect(s.calls()).toBe(2);
  });

  it("every task file loads and names an existing fixture", () => {
    expect(tasks.size).toBeGreaterThanOrEqual(20);
    for (const t of tasks.values()) expect(existsSync(join(FIXTURES, t.fixture)), t.id).toBe(true);
  });

  it("folds trials into pass@k and pass^k", async () => {
    let trial = 0;
    const driver = (cwd: string) => (trial++ === 0 ? scripted(FIX).driver(cwd) : scripted([[text("No change needed.")]]).driver(cwd));
    const r = await runTask({ task: task("fix-off-by-one"), fixturesRoot: FIXTURES, driver, model: "m", trials: 2, cacheKey: "k" });
    expect(r.trials.map((t) => t.pass)).toEqual([true, false]);
    expect(r).toMatchObject({ passAtK: true, passHatK: false, cached: false, cacheKey: "k" });
  }, 60_000);

  it("--dry prints the worst case without a key or a model call", () => {
    const out = execFileSync(process.execPath.includes("bun") ? process.execPath : "bun", ["evals/run.ts", "--tier", "smoke", "--dry"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PGS_API_KEY: "", TOKENHARBOR_API_KEY: "" },
    });
    expect(out).toMatch(/6 tasks, 6 trials, worst case 350,000 input tokens/);
    expect(out).toContain("fix-off-by-one");
  });
});
