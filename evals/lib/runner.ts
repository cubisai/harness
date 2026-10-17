// One eval trial: a fresh copy of the task's fixture, one agent turn under the
// task's budget, the hidden grader files copied in afterwards, then grading.
// The agent is any AgentDriver, so the same task runs on every agent.

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDriver, TurnInput } from "../../src/main/agents/types";
import { runCheck } from "../../src/main/check";
import { canonicalTool, clipSummary } from "../../src/shared/tools";
import type { ThreadEvent } from "../../src/shared/types";
import { generate } from "../../scripts/mock-extensions-lib.mjs";
import { grade, score } from "./graders";
import { assembleTask } from "./store";
import type { CompactEvent, Coverage, GradeInput, Task, TaskResult, TrialResult, TrialStatus } from "./types";

export interface TrialOptions {
  task: Task;
  /** evals/fixtures */
  fixturesRoot: string;
  /** A driver for the trial's project folder. */
  driver(cwd: string): AgentDriver;
  model: string;
  effort?: string;
  /** USD per 1M tokens, for drivers that report no cost. */
  price?: { input: number; output: number };
  /** Where the agent reads project skills (relative); the task's skill kit is written to each. */
  skillDirs?: string[];
  /** Keep the trial folder (debugging). */
  keep?: boolean;
  /** Injected in tests; defaults to runCheck. */
  runCommand?: GradeInput["runCommand"];
}

const TEXT_MAX = 2000;
const HARNESS_ERROR = /\b(?:401|403|429|5\d\d)\b|unauthori[sz]ed|forbidden|invalid api key|ECONN|ETIMEDOUT|fetch failed|ENOTFOUND/i;

/** A thread event cut down for grading and storage; null for kinds nobody grades. */
export function compact(e: ThreadEvent): CompactEvent | null {
  switch (e.kind) {
    case "tool-use":
      return { kind: e.kind, name: canonicalTool(e.name), summary: clipSummary(e.summary) };
    case "tool-result":
      return { kind: e.kind, isError: e.isError, summary: clipSummary(e.summary) };
    case "assistant-text":
    case "error":
      return { kind: e.kind, text: (e.kind === "error" ? e.message : e.text).slice(0, TEXT_MAX) };
    case "notice":
    case "plan-proposal":
      return { kind: e.kind, text: e.text.slice(0, TEXT_MAX) };
    case "turn-end":
      return { kind: e.kind };
    default:
      return null;
  }
}

/** How a trial ended; only a graded, error-free run whose required graders pass is "passed". */
export function trialStatus(o: { harnessError: string | null; graders: number; pass: boolean; overBudget: boolean; cancelled?: boolean }): TrialStatus {
  if (o.harnessError) return "harness-error";
  if (o.cancelled) return "cancelled";
  if (o.graders === 0) return "ungraded";
  if (o.pass) return "passed";
  return o.overBudget ? "budget-stop" : "failed";
}

const defaultRunCommand: GradeInput["runCommand"] = async (command, cwd, timeoutMs) => {
  const r = await runCheck(command, cwd, { timeoutMs });
  return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
};

/** Writes the task's mock skill kit into `dir`; returns sentinel → skill name. */
function writeSkillKit(task: Task, dir: string, skillDirs: string[]): Map<string, string> | undefined {
  if (!task.skills) return undefined;
  const kit = generate({ skills: task.skills.kit.skills, servers: 0, tools: 0, seed: task.skills.kit.seed, serverScript: "" });
  for (const f of kit.files.filter((f) => f.path.startsWith(".agents/skills/"))) {
    for (const to of skillDirs) {
      const path = join(dir, to, f.path.slice(".agents/skills/".length));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content);
    }
  }
  return new Map(kit.manifest.skills.map((s) => [s.sentinel, s.name]));
}

export async function runTrial(o: TrialOptions): Promise<TrialResult> {
  const { task } = o;
  const fixtureDir = join(o.fixturesRoot, task.fixture);
  const hiddenDir = `${fixtureDir}.hidden`;
  const root = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  if (existsSync(fixtureDir)) cpSync(fixtureDir, dir, { recursive: true });
  const sentinels = writeSkillKit(task, dir, o.skillDirs ?? [".agents/skills"]);

  const events: ThreadEvent[] = [];
  const controller = new AbortController();
  let overBudget = false;
  let toolCalls = 0;
  let liveInput = 0;
  const stop = () => {
    overBudget = true;
    controller.abort();
  };
  const timer = setTimeout(stop, task.budget.timeoutMs);
  const started = Date.now();
  let thrown: string | null = null;

  const input: TurnInput = {
    threadId: `eval-${task.id}`,
    cwd: dir,
    projectId: "eval",
    prompt: task.prompt,
    sessionId: null,
    model: o.model,
    effort: o.effort ?? "low",
    permissionMode: task.mode,
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
      if (e.kind === "tool-use" && ++toolCalls > task.budget.maxSteps) stop();
    },
    onTextDelta: () => {},
    onUsageUpdate: (u) => {
      liveInput = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
      if (liveInput > task.budget.maxInputTokens) stop();
    },
    onSession: () => {},
    requestPermission: async () => (task.permissions === "deny" ? "deny" : "allow-once"),
    requestPlanDecision: async (p) => {
      // Every agent's proposal reaches the graders the same way, whatever its plan tool is called.
      events.push({ kind: "plan-proposal", text: p.plan });
      // "stop" ends the turn at the proposal: the plan itself is what's graded, and approving costs tokens.
      if (task.planDecision && task.planDecision !== "stop") return task.planDecision;
      controller.abort();
      return "manual";
    },
    requestUserInput: async () => "dismiss",
    tools: [],
    mcpServers: [],
  };

  const driver = o.driver(dir);
  try {
    await driver.runTurn(input);
  } catch (err) {
    if (!controller.signal.aborted) thrown = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    driver.dispose?.();
  }
  const durationMs = Date.now() - started;

  if (existsSync(hiddenDir)) cpSync(hiddenDir, dir, { recursive: true, force: true });
  const compacted = events.map(compact).filter((e): e is CompactEvent => e !== null);
  // Skill bodies sit in tool-result payloads, which compaction drops: keep each loaded skill's sentinel.
  if (sentinels) {
    const raw = JSON.stringify(events);
    for (const sentinel of sentinels.keys()) if (raw.includes(sentinel)) compacted.push({ kind: "skill-loaded", text: sentinel });
  }
  const graders = await grade({ task, events: compacted, dir, fixtureDir, overBudget, sentinels, runCommand: o.runCommand ?? defaultRunCommand });
  const graded = score(graders);

  const end = events.findLast((e) => e.kind === "turn-end") as Extract<ThreadEvent, { kind: "turn-end" }> | undefined;
  const inputTokens = end?.inputTokens ?? liveInput;
  const outputTokens = end?.outputTokens ?? 0;
  const cacheReadTokens = end?.usage?.cacheReadTokens ?? 0;
  const errorText = events.find((e) => e.kind === "error" && HARNESS_ERROR.test(e.message)) as { message: string } | undefined;
  const reportedCost = typeof end?.costUsd === "number" ? end.costUsd : null;
  const costUsd = reportedCost ?? (o.price ? (inputTokens * o.price.input + outputTokens * o.price.output) / 1e6 : null);
  const costCoverage: Coverage = reportedCost !== null ? "reported" : costUsd !== null ? "estimated" : "unavailable";
  const usageCoverage: Coverage = typeof end?.inputTokens === "number" ? "reported" : liveInput > 0 ? "estimated" : "unavailable";
  const harnessError = thrown ?? errorText?.message.slice(0, 300) ?? null;
  const status = trialStatus({ harnessError, graders: graders.length, pass: graded.pass, overBudget });

  if (!o.keep) rmSync(root, { recursive: true, force: true });
  return {
    trialId: randomUUID(),
    status,
    pass: status === "passed",
    score: graded.score,
    graders,
    overBudget,
    harnessError,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    steps: end?.steps ?? toolCalls,
    toolCalls,
    durationMs,
    costUsd,
    usageCoverage,
    costCoverage,
    events: compacted,
  };
}

/** Runs `trials` trials of a task (stopping early on a harness error) and folds them into a TaskResult. */
export async function runTask(o: TrialOptions & { trials: number; cacheKey: string }): Promise<TaskResult> {
  const trials: TrialResult[] = [];
  for (let i = 0; i < o.trials; i++) {
    const t = await runTrial(o);
    trials.push(t);
    if (t.harnessError) break;
  }
  return assembleTask(o.task, o.cacheKey, o.trials, [], trials);
}
