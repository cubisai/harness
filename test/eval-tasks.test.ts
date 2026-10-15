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
