// The eval contract: task files (evals/tasks/*.json), graders and stored
// results. Plan: .ai/plans/eval-framework.md.

import type { McpServerEntry } from "../../src/shared/types";

export type Tier = "smoke" | "full";
export type TaskTag = "capability" | "regression";

export interface Budget {
  /** Tool calls allowed in the turn before the runner aborts it. */
  maxSteps: number;
  /** Input tokens (uncached + cached) allowed before the runner aborts the turn. */
  maxInputTokens: number;
  timeoutMs: number;
}

export type Grader =
  | {
      type: "file";
      path: string;
      exists?: boolean;
      contains?: string;
      matches?: string;
      /** Same bytes as the fixture's copy (sha256). */
      unchanged?: boolean;
      required?: boolean;
      weight?: number;
    }
  | { type: "command"; run: string; timeoutMs?: number; required?: boolean; weight?: number }
  | { type: "tool"; name: string; min?: number; max?: number; required?: boolean; weight?: number }
  | { type: "skill"; expect?: string[]; none?: boolean; required?: boolean; weight?: number }
  /** planProposed: the agent presented a plan for approval (any agent's plan tool). */
  | { type: "event"; noError?: boolean; noFalseClaim?: boolean; planProposed?: boolean; required?: boolean; weight?: number }
  | { type: "budget"; required?: boolean; weight?: number }
  /** The final answer text: every `contains` (case-insensitive) and `matches` (regex, i). */
  | { type: "answer"; contains?: string[]; matches?: string; required?: boolean; weight?: number }
  /** Each "server/tool" in expect was called and its result came back (sentinel seen). */
  | { type: "mcp"; expect: string[]; required?: boolean; weight?: number };

export interface Task {
  id: string;
  tags: TaskTag[];
  tier: Tier;
  /** Folder under evals/fixtures/; `<fixture>.hidden/` (optional) is copied in after the turn. */
  fixture: string;
  prompt: string;
  mode: "ask" | "plan" | "auto-edit" | "full";
  /** Answer to any requestUserInput question during the first turn. */
  reply?: string;
  /** Follow-up user turns run in order on the SAME agent session after `prompt`. */
  turns?: { prompt: string; reply?: string }[];
  /** Memory text the agent is given (native engine: returned from the driver's `memory` dep). */
  memory?: string;
  /** Mock MCP servers from scripts/mock-extensions-lib.mjs `generate`. */
  mcp?: { servers: number; tools: number; seed: number };
  /** Capabilities the bun eval runner can't provide (they need Electron); such tasks are skipped, see run.ts. */
  requires?: ("browser" | "team")[];
  /** How the runner answers permission requests; default allow. */
  permissions?: "allow" | "deny";
  /** How the runner answers a plan proposal: "stop" ends the turn there (default), the others approve it. */
  planDecision?: "stop" | "auto" | "manual";
  /** Mock skill kit written into the fixture copy (scripts/mock-extensions-lib.mjs). */
  skills?: { kit: { skills: number; seed: number } };
  graders: Grader[];
  budget: Budget;
  /** What a correct run does, so a 0% score is checked against the task first. */
  reference?: string;
}

/** A thread event cut down for storage and grading: no deltas, summaries clipped to 160 chars. */
export interface CompactEvent {
  kind: string;
  /** Canonical tool name (tool-use). */
  name?: string;
  summary?: string;
  isError?: boolean;
  /** assistant-text / error / notice text, clipped to 2,000 chars. */
  text?: string;
}

export interface GradeInput {
  task: Task;
  events: CompactEvent[];
  /** The trial's project folder after the turn (hidden files already copied in). */
  dir: string;
  /** The task's fixture folder, for `unchanged`. */
  fixtureDir: string;
  overBudget: boolean;
  /** Sentinel → skill name, for `skill` graders. */
  sentinels?: Map<string, string>;
  /** Sentinel → "server/tool", for `mcp` graders. */
  mcpSentinels?: Map<string, string>;
  /** Runs a grader command in `dir`; injected so tests need no shell. */
  runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number | null; tail: string }>;
}

/** What a trial hands its driver before the first turn: memory text and mock MCP servers. */
export interface Scenario {
  memory: string | null;
  mcpServers: McpServerEntry[];
}

export interface GraderResult {
  type: Grader["type"];
  pass: boolean;
  required: boolean;
  weight: number;
  /** One line: why it passed or failed. */
  why: string;
}

/**
 * How a trial ended. Only "passed" is a quality pass: an infrastructure failure,
 * a cancelled turn or a trial with no graders can never count as one.
 */
export type TrialStatus = "passed" | "failed" | "harness-error" | "budget-stop" | "cancelled" | "ungraded";

/** Where a usage or cost number came from; missing is "unavailable", never zero. */
export type { UsageCoverage as Coverage } from "../../src/shared/run-trace";
import type { RunManifest, UsageCoverage as Coverage } from "../../src/shared/run-trace";

export interface TrialResult {
  /** Stable id, so a trial reused from the cache is never counted twice. Missing on old run files. */
  trialId?: string;
  /** Reused from an earlier run: its measured cost is history, not this run's spend. */
  cached?: boolean;
  /** Missing on old run files; see trialStatus(). */
  status?: TrialStatus;
  pass: boolean;
  /** Weighted share of graders passed, 0..1. */
  score: number;
  graders: GraderResult[];
  overBudget: boolean;
  /** Set when the turn failed outside the agent's control (auth, 5xx, crash). */
  harnessError: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  steps: number;
  toolCalls: number;
  durationMs: number;
  costUsd: number | null;
  /** Source of the token counts / of costUsd. Missing on old run files. */
  usageCoverage?: Coverage;
  costCoverage?: Coverage;
  /** Wall time inside tool calls (overlaps counted once); the rest is model + overhead. */
  toolMs?: number;
  /** Full trace file, relative to the results folder. */
  trace?: string;
  events: CompactEvent[];
}

export interface TaskResult {
  id: string;
  tags: TaskTag[];
  cacheKey: string;
  /** True when every trial was reused from the cache (no model calls). */
  cached: boolean;
  /** Trials asked for; trials.length can be lower when a harness error stopped the task. */
  requestedTrials?: number;
  trials: TrialResult[];
  /** At least one trial passed. */
  passAtK: boolean;
  /** Every requested trial ran and passed. */
  passHatK: boolean;
}

export interface RunMeta {
  tier: Tier;
  agent: string;
  model: string;
  protocol: string;
  harnessHash: string;
  /** Reasoning effort the turns ran at; part of the cache identity. */
  effort?: string;
  /** Everything the result depends on, versioned. Missing on old run files. */
  manifest?: RunManifest;
  startedAt: string;
  durationMs: number;
}

export interface RunResult {
  meta: RunMeta;
  tasks: TaskResult[];
}
