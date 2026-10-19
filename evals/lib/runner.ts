// One eval trial: a fresh copy of the task's fixture, one agent turn under the
// task's budget, the hidden grader files copied in afterwards, then grading.
// The agent is any AgentDriver, so the same task runs on every agent.

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDriver, HarnessTool, TurnInput } from "../../src/main/agents/types";
import type { BrowserBackend } from "../../src/main/browser/backend";
import { browserTools } from "../../src/main/browser/tools";
import { runCheck } from "../../src/main/check";
import { canonicalTool, clipSummary } from "../../src/shared/tools";
import { spansOf, timeSplit, type TimedEvent } from "../../src/shared/run-trace";
import type { McpServerEntry, ThreadEvent } from "../../src/shared/types";
import { generate } from "../../scripts/mock-extensions-lib.mjs";
import { grade, score } from "./graders";
import { assembleTask } from "./store";
import type { CompactEvent, Coverage, GradeInput, Scenario, Task, TaskResult, TrialResult, TrialStatus } from "./types";

export interface TrialOptions {
  task: Task;
  /** evals/fixtures */
  fixturesRoot: string;
  /** A driver for the trial's project folder, given the scenario's memory and MCP servers. */
  driver(cwd: string, scenario: Scenario): AgentDriver;
  model: string;
  effort?: string;
  /** USD per 1M tokens, for drivers that report no cost. */
  price?: { input: number; output: number };
  /** Where the agent reads project skills (relative); the task's skill kit is written to each. */
  skillDirs?: string[];
  /** The stdio script the mock MCP servers run; default test/fixtures/mock-mcp-many.mjs. */
  mcpServerScript?: string;
  /** A fresh headless browser for a task that requires one (one isolated session per trial); null = none available. */
  browser?: () => BrowserBackend | null;
  /** Keep the trial folder (debugging). */
  keep?: boolean;
  /** Injected in tests; defaults to runCheck. */
  runCommand?: GradeInput["runCommand"];
  /** A model and calibration folder for judge graders; absent = judges leave the trial ungraded. */
  judge?: { ask: (prompt: string) => Promise<string>; root: string };
  /** Write a full trace per trial here (redacted); its path relative to `traceRoot` goes on the result. */
  trace?: { dir: string; root: string; fidelity: string; redact(text: string): string; sessionFile?(sessionId: string): string | null };
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
export function trialStatus(o: { harnessError: string | null; graders: number; pass: boolean; overBudget: boolean; cancelled?: boolean; ungraded?: boolean }): TrialStatus {
  if (o.harnessError) return "harness-error";
  if (o.cancelled) return "cancelled";
  if (o.graders === 0 || o.ungraded) return "ungraded";
  if (o.pass) return "passed";
  return o.overBudget ? "budget-stop" : "failed";
}

const defaultRunCommand: GradeInput["runCommand"] = async (command, cwd, timeoutMs) => {
  const r = await runCheck(command, cwd, { timeoutMs });
  return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
};

/** Writes the task's mock skill kit into `dir`; returns sentinel → skill name. */
export function writeSkillKit(task: Task, dir: string, skillDirs: string[]): Map<string, string> | undefined {
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

/** The repo's mock MCP stdio server, the default script the generated servers run. */
const MOCK_MCP_SERVER = fileURLToPath(new URL("../../test/fixtures/mock-mcp-many.mjs", import.meta.url));

/** The task's mock MCP servers (from `generate`) and sentinel → "server/tool"; undefined without `task.mcp`. */
export function mcpKit(task: Task, serverScript = MOCK_MCP_SERVER): { servers: McpServerEntry[]; sentinels: Map<string, string> } | undefined {
  if (!task.mcp) return undefined;
  const kit = generate({ skills: 0, servers: task.mcp.servers, tools: task.mcp.tools, seed: task.mcp.seed, serverScript });
  const file = kit.files.find((f) => f.path === ".mcp.json");
  const parsed = JSON.parse(file?.content ?? "{}") as { mcpServers?: Record<string, { command: string; args?: string[] }> };
  const servers: McpServerEntry[] = Object.entries(parsed.mcpServers ?? {}).map(([name, s]) => ({
    name,
    spec: { type: "stdio", command: s.command, args: s.args ?? [] },
    enabled: true,
  }));
  return { servers, sentinels: new Map(kit.manifest.tools.map((t) => [t.sentinel, `${t.server}/${t.name}`])) };
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
  const kit = mcpKit(task, o.mcpServerScript);
  const browser = task.requires?.includes("browser") ? (o.browser?.() ?? null) : null;
  const tools: HarnessTool[] = browser ? browserTools(browser) : [];
  const scenario: Scenario = { memory: task.memory ?? null, mcpServers: kit?.servers ?? [], tools };

  const events: ThreadEvent[] = [];
  const timed: TimedEvent[] = [];
  let sessionId: string | null = null;
  const controller = new AbortController();
  let overBudget = false;
  let toolCalls = 0;
  let liveInput = 0;
  let turnsStarted = 0;
  const stop = () => {
    overBudget = true;
    controller.abort();
  };
  const timer = setTimeout(stop, task.budget.timeoutMs);
  const started = Date.now();
  let thrown: string | null = null;

  // Each turn is the whole budget/event scope with its own prompt and the session the last turn opened.
  const turnInput = (prompt: string, reply: string | undefined, sid: string | null): TurnInput => ({
    threadId: `eval-${task.id}`,
    cwd: dir,
    projectId: "eval",
    prompt,
    sessionId: sid,
    model: o.model,
    effort: o.effort ?? "low",
    permissionMode: task.mode,
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
      timed.push({ t: Date.now() - started, event: e });
      if (e.kind === "tool-use" && ++toolCalls > task.budget.maxSteps) stop();
    },
    onTextDelta: () => {},
    onUsageUpdate: (u) => {
      liveInput = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
      if (liveInput > task.budget.maxInputTokens) stop();
    },
    onSession: (id) => {
      sessionId = id;
    },
    requestPermission: async () => (task.permissions === "deny" ? "deny" : "allow-once"),
    requestPlanDecision: async (p) => {
      // Every agent's proposal reaches the graders the same way, whatever its plan tool is called.
      events.push({ kind: "plan-proposal", text: p.plan });
      // "stop" ends the turn at the proposal: the plan itself is what's graded, and approving costs tokens.
      if (task.planDecision && task.planDecision !== "stop") return task.planDecision;
      controller.abort();
      return "manual";
    },
    requestUserInput: async (questions) => (reply === undefined ? "dismiss" : { answers: Object.fromEntries(questions.map((q) => [q.id, [reply]])) }),
    tools,
    mcpServers: scenario.mcpServers,
  });

  const driver = o.driver(dir, scenario);
  try {
    for (const turn of [{ prompt: task.prompt, reply: task.reply }, ...(task.turns ?? [])]) {
      if (controller.signal.aborted) break;
      turnsStarted++;
      await driver.runTurn(turnInput(turn.prompt, turn.reply, sessionId));
    }
  } catch (err) {
    if (!controller.signal.aborted) thrown = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    driver.dispose?.();
    await browser?.close?.();
  }
  const durationMs = Date.now() - started;

  if (existsSync(hiddenDir)) cpSync(hiddenDir, dir, { recursive: true, force: true });
  const compacted = events.map(compact).filter((e): e is CompactEvent => e !== null);
  // Skill bodies sit in tool-result payloads, which compaction drops: keep each loaded skill's sentinel.
  if (sentinels) {
    const raw = JSON.stringify(events);
    for (const sentinel of sentinels.keys()) if (raw.includes(sentinel)) compacted.push({ kind: "skill-loaded", text: sentinel });
  }
  // MCP results are dropped by compaction too; a tool's sentinel in the transcript proves it ran and answered.
  if (kit) {
    const raw = JSON.stringify(events);
    for (const sentinel of kit.sentinels.keys()) if (raw.includes(sentinel)) compacted.push({ kind: "mcp-result", text: sentinel });
  }
  const graders = await grade({ task, events: compacted, dir, fixtureDir, overBudget, sentinels, mcpSentinels: kit?.sentinels, runCommand: o.runCommand ?? defaultRunCommand, ...(o.judge ? { ask: o.judge.ask, judgesRoot: o.judge.root } : {}) });
  const graded = score(graders);

  // Multi-turn trials fold every root turn-end; a child's turn-end only covers its own subagent.
  const ends = events.filter((e): e is Extract<ThreadEvent, { kind: "turn-end" }> => e.kind === "turn-end" && !e.parentId);
  const inputTokens = ends.length ? ends.reduce((n, e) => n + e.inputTokens, 0) : liveInput;
  const outputTokens = ends.length ? ends.reduce((n, e) => n + e.outputTokens, 0) : 0;
  const cacheReadTokens = ends.reduce((n, e) => n + (e.usage?.cacheReadTokens ?? 0), 0);
  const errorText = events.find((e) => e.kind === "error" && HARNESS_ERROR.test(e.message)) as { message: string } | undefined;
  const reportedCost = ends.length && ends.every((e) => typeof e.costUsd === "number") ? ends.reduce((n, e) => n + (e.costUsd ?? 0), 0) : null;
  const costUsd = reportedCost ?? (o.price ? (inputTokens * o.price.input + outputTokens * o.price.output) / 1e6 : null);
  const costCoverage: Coverage = reportedCost !== null ? "reported" : costUsd !== null ? "estimated" : "unavailable";
  const usageCoverage: Coverage = ends.length && ends.every((e) => typeof e.inputTokens === "number") ? "reported" : liveInput > 0 ? "estimated" : "unavailable";
  const harnessError = thrown ?? errorText?.message.slice(0, 300) ?? null;
  const status = trialStatus({ harnessError, graders: graders.length, pass: graded.pass, overBudget, ungraded: graders.some((g) => g.ungraded) });

  const trialId = randomUUID();
  const spans = spansOf(timed);
  const trace = o.trace ? writeTrace(o.trace, { trialId, task, status, durationMs, timed, spans, sessionId, turns: turnsStarted }) : undefined;

  if (!o.keep) rmSync(root, { recursive: true, force: true });
  return {
    trialId,
    status,
    pass: status === "passed",
    score: graded.score,
    graders,
    overBudget,
    harnessError,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    steps: ends.some((e) => typeof e.steps === "number") ? ends.reduce((n, e) => n + (e.steps ?? 0), 0) : toolCalls,
    toolCalls,
    durationMs,
    costUsd,
    usageCoverage,
    costCoverage,
    toolMs: timeSplit(spans, durationMs).toolMs,
    ...(trace ? { trace } : {}),
    events: compacted,
  };
}

/** One trial's full trace: timed events, spans and, when the engine keeps one, the model-visible session. */
function writeTrace(
  o: NonNullable<TrialOptions["trace"]>,
  t: { trialId: string; task: Task; status: string; durationMs: number; timed: TimedEvent[]; spans: ReturnType<typeof spansOf>; sessionId: string | null; turns: number },
): string {
  let session: unknown[] | undefined;
  const file = t.sessionId ? o.sessionFile?.(t.sessionId) : null;
  if (file && existsSync(file)) {
    session = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  }
  mkdirSync(o.dir, { recursive: true });
  const path = join(o.dir, `${t.task.id}-${t.trialId.slice(0, 8)}.json`);
  const body = { trialId: t.trialId, task: { id: t.task.id, prompt: t.task.prompt, mode: t.task.mode }, status: t.status, durationMs: t.durationMs, turns: t.turns, fidelity: o.fidelity, spans: t.spans, events: t.timed, ...(session ? { session } : {}) };
  writeFileSync(path, o.redact(JSON.stringify(body, null, 1)));
  return relative(o.root, path).split(sep).join("/");
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
