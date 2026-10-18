// Grader validation (roadmap 13 P1.5): a task's graders must fail a no-op
// (the untouched fixture, no answer) and pass its reference solution
// (evals/references/<task>.json), or the task can't tell good work from none.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grade, score } from "./graders";
import { mcpKit, writeSkillKit } from "./runner";
import type { CompactEvent, GradeInput, Task } from "./types";

/** A known-good outcome: edits to the fixture copy plus the transcript graders read. */
export interface Reference {
  /** Exact-string replacements, applied in order; each `old` must occur. */
  edits?: { path: string; old: string; new: string }[];
  /** Whole files to write (new or replaced). */
  write?: Record<string, string>;
  delete?: string[];
  /** The transcript: answer text, tool calls, plan proposals... */
  events?: CompactEvent[];
  /** Skills the reference loads (by name; mapped to the kit's sentinels). */
  skills?: string[];
  /** MCP tools the reference calls (by "server/tool"; mapped to the kit's sentinels). */
  mcp?: string[];
}

export interface Check {
  pass: boolean;
  why: string[];
}

export interface Validation {
  id: string;
  /** Graders on a no-op; should fail. */
  noop: Check;
  /** Graders on the reference; should pass. null = no reference file. */
  reference: Check | null;
  /** Problems with the task's graders. */
  problems: string[];
  /** Set when the task needs a capability the runner can't provide; not a problem. */
  skipped?: string;
}

async function gradeOutcome(task: Task, fixturesRoot: string, runCommand: GradeInput["runCommand"], ref: Reference | null): Promise<Check> {
  const fixtureDir = join(fixturesRoot, task.fixture);
  const root = mkdtempSync(join(tmpdir(), `eval-validate-${task.id}-`));
  const dir = join(root, "project");
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(fixtureDir)) cpSync(fixtureDir, dir, { recursive: true });
    const sentinels = writeSkillKit(task, dir, [".agents/skills"]);
    const kit = mcpKit(task);
    // A fixture-level reference (`<fixture>.reference/`, files only) lays under the task's own.
    if (ref && existsSync(`${fixtureDir}.reference`)) cpSync(`${fixtureDir}.reference`, dir, { recursive: true, force: true });
    const events: CompactEvent[] = [...(ref?.events ?? [])];
    for (const e of ref?.edits ?? []) {
      const path = join(dir, e.path);
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      if (!text.includes(e.old)) throw new Error(`reference edit for ${e.path}: text not found`);
      writeFileSync(path, text.replace(e.old, e.new));
    }
    for (const [rel, content] of Object.entries(ref?.write ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    for (const rel of ref?.delete ?? []) unlinkSync(join(dir, rel));
    for (const name of ref?.skills ?? []) {
      const sentinel = [...(sentinels ?? [])].find(([, n]) => n === name)?.[0];
      if (!sentinel) throw new Error(`reference loads unknown skill ${name}`);
      events.push({ kind: "skill-loaded", text: sentinel });
    }
    for (const name of ref?.mcp ?? []) {
      const sentinel = [...(kit?.sentinels ?? [])].find(([, n]) => n === name)?.[0];
      if (!sentinel) throw new Error(`reference calls unknown MCP tool ${name}`);
      events.push({ kind: "mcp-result", text: sentinel });
    }
    events.push({ kind: "turn-end" });
    if (existsSync(`${fixtureDir}.hidden`)) cpSync(`${fixtureDir}.hidden`, dir, { recursive: true, force: true });
    const graders = await grade({ task, events, dir, fixtureDir, overBudget: false, sentinels, mcpSentinels: kit?.sentinels, runCommand });
    const { pass } = score(graders);
    return { pass, why: graders.map((g) => `${g.pass ? "✓" : "✗"} ${g.type}: ${g.why}`) };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The task's reference: evals/references/<id>.json, or {} when only `<fixture>.reference/` exists; null for none. */
export function loadReference(referencesRoot: string, task: Pick<Task, "id" | "fixture">, fixturesRoot: string): Reference | null {
  const path = join(referencesRoot, `${task.id}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Reference;
  return existsSync(join(fixturesRoot, `${task.fixture}.reference`)) ? {} : null;
}

export async function validateTask(task: Task, o: { fixturesRoot: string; referencesRoot: string; runCommand: GradeInput["runCommand"] }): Promise<Validation> {
  // Needs Electron's browser pane or team runtime, which the bun runner can't
  // provide: count it as skipped, not a failure (the eval run skips it too).
  if (task.requires?.length) return { id: task.id, noop: { pass: false, why: [] }, reference: null, problems: [], skipped: `needs ${task.requires.join(", ")}` };
  const problems: string[] = [];
  if (task.graders.length === 0) problems.push("no graders");
  const noop = await gradeOutcome(task, o.fixturesRoot, o.runCommand, null);
  if (noop.pass) problems.push("a no-op passes: the graders don't check the outcome");
  const ref = loadReference(o.referencesRoot, task, o.fixturesRoot);
  let reference: Check | null = null;
  if (ref) {
    try {
      reference = await gradeOutcome(task, o.fixturesRoot, o.runCommand, ref);
    } catch (err) {
      reference = { pass: false, why: [err instanceof Error ? err.message : String(err)] };
    }
    if (!reference.pass) problems.push("the reference solution fails");
  } else problems.push("no reference solution");
  return { id: task.id, noop, reference, problems };
}
