// The bench contract: tasks (bench/tasks/*.json), the agent list
// (bench/agents.json) and one result file per run.

import type { Grader, GraderResult } from "../../evals/lib/types";
import type { RunMetrics, TodoExpect } from "./metrics";

export interface BenchTask {
  id: string;
  /** What the task measures, for people reading results. */
  about: string;
  /** Folder under bench/fixtures/; `<fixture>.hidden/` is copied in after the turn. */
  fixture?: string;
  /** A commit of this repo to use instead of a fixture (CLAUDE.md, AGENTS.md, .claude, .ai left out). */
  pinned?: string;
  /** Make the project a git repo with one commit. */
  git?: boolean;
  prompt: string;
  /** Sentinel → skill name; each sentinel sits only in its skill's body. */
  sentinels?: Record<string, string>;
  expect: { todo?: TodoExpect; runCode?: boolean; skills?: string[] };
  /** evals graders (file, command, answer, tool, event). */
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
  agent: string;
  model: string;
  trial: number;
  harness: { commit: string; dirty: boolean; versions: Record<string, string> };
  threadId: string;
  status: RunStatus;
  /** Graders passed (required ones). */
  pass: boolean;
  graders: GraderResult[];
  /** The task's behaviour expectations; null = the task doesn't set one. */
  checks: { todo: boolean | null; runCode: boolean | null; skills: boolean | null };
  metrics: RunMetrics;
  note?: string;
}
