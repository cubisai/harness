// Every eval task that ships a reference solution (`<fixture>.reference/`) is
// proven with zero model calls: its command and file graders fail on the bare
// fixture and pass once the reference is laid over it.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/main/check";
import { loadTasks } from "../evals/run";
import { grade } from "../evals/lib/graders";
import type { GradeInput, Task } from "../evals/lib/types";
import { validateTask } from "../evals/lib/validate";

const FIXTURES = join(__dirname, "..", "evals", "fixtures");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const runCommand: GradeInput["runCommand"] = async (command, cwd, timeoutMs) => {
  const r = await runCheck(command, cwd, { timeoutMs });
  return { ok: r.ok, exitCode: r.exitCode, tail: r.tail };
};

/** Fixture (+ reference) + hidden files in a fresh dir, graded on its command and file graders only. */
async function gradeWith(task: Task, withReference: boolean) {
  const fixtureDir = join(FIXTURES, task.fixture);
  const dir = mkdtempSync(join(tmpdir(), `eval-task-${task.id}-`));
  dirs.push(dir);
  cpSync(fixtureDir, dir, { recursive: true });
  if (withReference) cpSync(`${fixtureDir}.reference`, dir, { recursive: true, force: true });
  if (existsSync(`${fixtureDir}.hidden`)) cpSync(`${fixtureDir}.hidden`, dir, { recursive: true, force: true });
  const graders = task.graders.filter((g) => g.type === "command" || g.type === "file");
  return grade({ task: { ...task, graders }, events: [], dir, fixtureDir, overBudget: false, runCommand });
}

const withReference = loadTasks().filter((t) => existsSync(join(FIXTURES, `${t.fixture}.reference`)));

describe("eval tasks with a reference solution", () => {
  it("has some", () => expect(withReference.length).toBeGreaterThanOrEqual(5));

  for (const task of withReference) {
    it(`${task.id}: graders fail on the fixture`, async () => {
      const results = await gradeWith(task, false);
      expect(results.some((r) => r.required && !r.pass)).toBe(true);
    });

    it(`${task.id}: graders pass on the reference`, async () => {
      const results = await gradeWith(task, true);
      expect(results.filter((r) => !r.pass).map((r) => r.why)).toEqual([]);
    });
  }
});

describe("grader validation (evals/references)", () => {
  const REFERENCES = join(__dirname, "..", "evals", "references");

  for (const task of loadTasks()) {
    it(`${task.id}: a no-op fails and the reference passes`, async () => {
      const v = await validateTask(task, { fixturesRoot: FIXTURES, referencesRoot: REFERENCES, runCommand });
      expect(v.problems, [...v.noop.why, ...(v.reference?.why ?? [])].join("\n")).toEqual([]);
    }, 30_000);
  }

  it("flags a task whose graders a no-op passes, and a missing reference", async () => {
    const weak: Task = { ...loadTasks().find((t) => t.id === "explain-no-edit")!, id: "weak-x", graders: [{ type: "budget" }] };
    const v = await validateTask(weak, { fixturesRoot: FIXTURES, referencesRoot: REFERENCES, runCommand });
    expect(v.problems).toEqual(["a no-op passes: the graders don't check the outcome", "no reference solution"]);
  });
});
