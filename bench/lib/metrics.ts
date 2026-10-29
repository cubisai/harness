// What one bench run did, from its thread events: todo use, code mode, tool
// calls, tokens, cost, time, skills and errors. Pure, so it is unit-tested.

import type { ThreadEvent } from "../../src/shared/types";

/** A stored thread event; `parentId` marks a subagent's events. */
export type BenchEvent = ThreadEvent;

export type ToolClass = "code" | "look" | "shell" | "edit" | "todo" | "skill" | "memory" | "other";

/** Every agent names its tools differently (Claude Read/Grep, native read/grep, Codex Run…). */
export function toolClass(name: string): ToolClass {
  const n = name.toLowerCase();
  if (n === "run_code") return "code";
  if (["read", "grep", "glob", "search", "list", "ls"].includes(n)) return "look";
  if (["run", "bash", "shell", "powershell"].includes(n)) return "shell";
  if (["edit", "write", "multiedit", "apply_patch", "notebookedit"].includes(n)) return "edit";
  if (["todowrite", "update_plan"].includes(n)) return "todo";
  if (n === "skill") return "skill";
  if (n.endsWith("memory_read") || n.endsWith("memory_write")) return "memory";
  return "other";
}

/** A shell command that runs tests or a typecheck: the agent checked its own work. */
const VERIFY = /\b(vitest|jest|mocha|pytest|tsc|typecheck|node --test|bun (run )?test|npm (run )?test|pnpm (run )?test|yarn test|cargo test|go test)\b/;

export function isVerifyCommand(command: string): boolean {
  return VERIFY.test(command);
}

export interface RunMetrics {
  todo: {
    /** Plan updates (each `plan` event). */
    updates: number;
    /** Parts in the last list. */
    parts: number;
    /** The first list came before the first edit; null when the run made no edit or no list. */
    beforeFirstEdit: boolean | null;
    /** Every part of the last list is completed; null without a list. */
    allCompleted: boolean | null;
  };
  tools: {
    /** Top-level tool calls (subagent calls not counted). */
    total: number;
    runCode: number;
    runCodeFailed: number;
    look: number;
    shell: number;
    edit: number;
    byName: Record<string, number>;
  };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  costUsd: number | null;
  durationMs: number;
  /** CubiQ memory tool calls. */
  memory: { reads: number; writes: number };
  /** The project check the app runs after a turn that changed files: results, first result, fix rounds, last result. */
  check: { runs: number; firstOk: boolean | null; fixRounds: number; finalOk: boolean | null };
  /** The evidence gate's flags ("Worth a second look: …"). */
  evidence: string[];
  /** Shell commands that ran tests or a typecheck. */
  verifyRuns: number;
  /** Model calls (native agent only). */
  steps: number | null;
  errors: string[];
  /** Skills seen loaded: the sentinel in their body shows up in the events, or a skill-tool call names them (Claude's Skill result is only "Launching skill: <name>"). */
  skills: string[];
  /** The last top-level assistant text. */
  answer: string;
}

/** `sentinels`: sentinel → skill name (each sentinel sits only in its skill's body). */
export function runMetrics(events: BenchEvent[], sentinels: Map<string, string> = new Map()): RunMetrics {
  const top = events.filter((e) => !e.parentId);
  const uses = top.filter((e): e is Extract<BenchEvent, { kind: "tool-use" }> => e.kind === "tool-use");
  const failed = new Set(top.filter((e) => e.kind === "tool-result" && e.isError).map((e) => (e as Extract<BenchEvent, { kind: "tool-result" }>).toolUseId));
  const byName: Record<string, number> = {};
  const count: Record<ToolClass, number> = { code: 0, look: 0, shell: 0, edit: 0, todo: 0, skill: 0, memory: 0, other: 0 };
  for (const u of uses) {
    byName[u.name] = (byName[u.name] ?? 0) + 1;
    count[toolClass(u.name)]++;
  }

  const plans = top.filter((e): e is Extract<BenchEvent, { kind: "plan" }> => e.kind === "plan");
  const firstPlan = top.findIndex((e) => e.kind === "plan");
  const firstEdit = top.findIndex((e) => e.kind === "tool-use" && toolClass(e.name) === "edit");
  const last = plans.at(-1);

  const ends = top.filter((e): e is Extract<BenchEvent, { kind: "turn-end" }> => e.kind === "turn-end");
  const sum = (f: (e: Extract<BenchEvent, { kind: "turn-end" }>) => number | null | undefined) => ends.reduce((n, e) => n + (f(e) ?? 0), 0);
  const costs = ends.map((e) => e.costUsd);

  const raw = JSON.stringify(events);
  const checks = top.filter((e): e is Extract<BenchEvent, { kind: "check" }> => e.kind === "check" && e.ok !== null);
  const evidence = top.flatMap((e) => (e.kind === "notice" && e.evidence ? e.evidence : []));
  const commandOf = (u: Extract<BenchEvent, { kind: "tool-use" }>): string => {
    const p = u.payload as { command?: unknown } | undefined;
    return typeof p?.command === "string" ? p.command : u.summary;
  };
  const texts = top.filter((e): e is Extract<BenchEvent, { kind: "assistant-text" }> => e.kind === "assistant-text");

  return {
    todo: {
      updates: plans.length,
      parts: last?.entries.length ?? 0,
      beforeFirstEdit: firstPlan < 0 || firstEdit < 0 ? null : firstPlan < firstEdit,
      allCompleted: last ? last.entries.length > 0 && last.entries.every((p) => p.status === "completed") : null,
    },
    tools: {
      total: uses.filter((u) => toolClass(u.name) !== "todo").length,
      runCode: count.code,
      runCodeFailed: uses.filter((u) => toolClass(u.name) === "code" && failed.has(u.toolUseId)).length,
      look: count.look,
      shell: count.shell,
      edit: count.edit,
      byName,
    },
    tokens: {
      input: sum((e) => e.inputTokens),
      output: sum((e) => e.outputTokens),
      cacheRead: sum((e) => e.usage?.cacheReadTokens),
      cacheWrite: sum((e) => e.usage?.cacheWriteTokens),
      reasoning: sum((e) => e.usage?.reasoningTokens),
    },
    memory: {
      reads: uses.filter((u) => u.name.toLowerCase().endsWith("memory_read")).length,
      writes: uses.filter((u) => u.name.toLowerCase().endsWith("memory_write")).length,
    },
    check: {
      runs: checks.length,
      firstOk: checks[0] ? checks[0].ok === true : null,
      fixRounds: checks.reduce((n, c) => Math.max(n, c.round ?? 0), 0),
      finalOk: checks.length ? checks.at(-1)!.ok === true : null,
    },
    evidence,
    verifyRuns: uses.filter((u) => toolClass(u.name) === "shell" && isVerifyCommand(commandOf(u))).length,
    costUsd: costs.length && costs.every((c) => c !== null) ? costs.reduce((n, c) => n + (c ?? 0), 0) : null,
    durationMs: sum((e) => e.durationMs),
    steps: ends.some((e) => e.steps !== undefined) ? sum((e) => e.steps) : null,
    errors: events.filter((e): e is Extract<BenchEvent, { kind: "error" }> => e.kind === "error").map((e) => e.message),
    skills: [
      ...new Set([
        ...[...sentinels].filter(([s]) => raw.includes(s)).map(([, name]) => name),
        ...[...sentinels.values()].filter((name) => uses.some((u) => toolClass(u.name) === "skill" && new RegExp(`(^|[\\s:/])${name}$`).test(u.summary.trim()))),
      ]),
    ],
    answer: texts.at(-1)?.text ?? "",
  };
}

export type TodoExpect = "none" | "before-edit";

/**
 * Whether the run's todo use matches what the task expects; null when the task doesn't say.
 * "before-edit": a list, closed at the end, not started after the first edit. An agent that writes
 * files only through the shell (Codex often does) has no edit call to compare with.
 */
export function todoOk(m: RunMetrics, expect: TodoExpect | undefined): boolean | null {
  if (!expect) return null;
  if (expect === "none") return m.todo.updates === 0;
  return m.todo.updates > 0 && m.todo.beforeFirstEdit !== false && m.todo.allCompleted === true;
}
