// The bench contract: tasks (bench/tasks/*.json), the agent list
// (bench/agents.json) and one result record per run.

import type { Grader, GraderResult } from "../../evals/lib/types";
import type { Health } from "../../src/shared/learn";
import type { MemoryType } from "../../src/shared/types";
import type { RunMetrics, TodoExpect } from "./metrics";

export type Suite = "behaviour" | "solve" | "memory" | "context";
export type Tier = "easy" | "medium" | "hard";

/** One more message after the task's prompt: in the same thread, or a new thread on the same project. */
export interface FollowUp {
  prompt: string;
  newThread?: boolean;
  /** Before sending, wait (up to 2 min) for a new project memory note: the previous message asked the agent to remember something. */
  afterMemory?: boolean;
}

export interface BenchTask {
  id: string;
  suite: Suite;
  tier?: Tier;
  /** In the daily core set (`--suite core`, the default); every task runs with `--suite full`. */
  core?: boolean;
  /** What the task measures, for people reading results. */
  about: string;
  /** Folder under bench/fixtures/; `<fixture>.hidden/` is copied in after the turn. */
  fixture?: string;
  /** This repo at a commit, without CLAUDE.md, AGENTS.md, .claude, .ai (every agent starts equal). */
  pinned?: string;
  /**
   * This repo at a commit as it's really worked on: CLAUDE.md (minus the opencode-delegation section), AGENTS.md and
   * .claude/skills stay, .ai goes. `install` links a node_modules installed once for that commit. `hidden` files are
   * taken from another commit (the real change's tests) and written in after the turn.
   */
  repo?: { commit: string; install?: boolean; hidden?: { commit: string; paths: string[] } };
  /** A folder under bench/fixtures/ copied in after the turn (grader scripts for repo tasks). */
  hiddenDir?: string;
  /** Make the project a git repo with one commit. */
  git?: boolean;
  /** The project's check command (the app runs it after a turn that changed files) and its fix rounds. */
  check?: { command: string; fixRounds: number };
  /** Self-improve on for this project: turns are scored, failures drafted into lessons. */
  learn?: boolean;
  /** Project memory notes written before the first message (the project's notes are cleared first). */
  memory?: { name: string; description: string; type: MemoryType; body: string }[];
  prompt: string;
  then?: FollowUp[];
  /** Sentinel → skill name; each sentinel sits only in its skill's body. */
  sentinels?: Record<string, string>;
  expect: { todo?: TodoExpect; runCode?: boolean; skills?: string[]; memoryWritten?: boolean };
  /** evals graders (file, command, answer, tool, event); `required: false` ones score but don't decide pass. */
  graders: Grader[];
  timeoutMs?: number;
}

export interface BenchAgent {
  /** Result-file and summary name, e.g. "claude-sonnet". */
  id: string;
  /** CubiQ agent id: claude, codex, opencode, provider-<id>. */
  agent: string;
  model: string;
  /** Free or rate-limited: at least 90 s between its runs. */
  spaced?: boolean;
  /** A native OpenAI-compatible provider, registered once per bench profile; the key stays in `envVar`. */
  provider?: { id: string; label: string; baseURL: string; envVar: string };
}

export type RunStatus = "passed" | "failed" | "timeout" | "stalled" | "error";

export interface RunResult {
  date: string;
  startedAt: string;
  task: string;
  suite: Suite;
  tier: Tier | null;
  agent: string;
  model: string;
  trial: number;
  harness: { commit: string; dirty: boolean; versions: Record<string, string> };
  threadIds: string[];
  status: RunStatus;
  /** Required graders passed. */
  pass: boolean;
  /** Share of grader weight passed, 0..1. */
  score: number;
  graders: GraderResult[];
  /** The task's behaviour expectations; null = the task doesn't set one. */
  checks: { todo: boolean | null; runCode: boolean | null; skills: boolean | null; memory: boolean | null };
  metrics: RunMetrics;
  /** Project memory notes before the first message and at the end. */
  memoryNotes: { before: number; after: number };
  /** Self-improve's own score of each turn (learn tasks), worst first; and the project's lessons once the learner has drafted (the bench waits for its queue after the last run). */
  learn: { health: Health[]; lessons: number } | null;
  note?: string;
}
