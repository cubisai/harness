// The app side of lesson replay: a case runs through the eval runner on the
// background agent, inside a throwaway copy of the case's pre-turn tree.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrial } from "../../../evals/lib/runner";
import { LEARN_DEFAULTS, type LearnSettings, type Lesson, type LessonVerification } from "../../shared/learn";
import type { AgentDriver } from "../agents/types";
import { pickBackground } from "./background";
import type { LearnDb } from "./db";
import { today } from "./index";
import { caseTask, materializeCase, verifyLesson } from "./replay";

/** The shared driver, minus dispose(): the runner disposes its driver after a trial, and this one is the app's. */
export function keepAlive(d: AgentDriver): AgentDriver {
  return new Proxy(d, {
    get(target, key) {
      if (key === "dispose") return undefined;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export interface VerifyAppDeps {
  db: LearnDb;
  settings: () => LearnSettings | undefined;
  drivers: () => AgentDriver[];
  casesRoot: (projectId: string) => string;
  projectPath: (projectId: string) => string;
  appVersion: string;
  now?: () => number;
}

/** A learner `verifyLesson` dep: replays within the project's daily background budget, then charges it. */
export function createVerifier(deps: VerifyAppDeps): (l: Lesson) => Promise<{ verification: LessonVerification | null; promote: boolean; why: string; tokens: number }> {
  const now = deps.now ?? Date.now;
  return async (l) => {
    const learn = deps.settings() ?? LEARN_DEFAULTS;
    const bg = pickBackground({ learn, projectId: l.projectId, drivers: deps.drivers() });
    if (!bg) return { verification: null, promote: false, why: "no background model can run a replay", tokens: 0 };
    const day = today(now());
    if (deps.db.spent(l.projectId, day) >= learn.dailyTokens) return { verification: null, promote: false, why: "today's background budget is spent; try again tomorrow", tokens: 0 };
    const casesRoot = deps.casesRoot(l.projectId);
    const projectPath = deps.projectPath(l.projectId);
    const result = await verifyLesson(l, {
      casesRoot,
      db: deps.db,
      runtime: { model: bg.model, agent: bg.driver.id, appVersion: deps.appVersion },
      now,
      runCase: async (c, lessons) => {
        const root = mkdtempSync(join(tmpdir(), "cubiq-replay-"));
        try {
          materializeCase(c, { casesRoot, projectPath, into: join(root, "case") });
          const t = await runTrial({ task: caseTask(c, "case", lessons), fixturesRoot: root, driver: () => keepAlive(bg.driver), model: bg.model });
          // Only a finished, graded run is evidence; a provider error or a hung stream (budget-stop) decides nothing.
          if (t.status !== "passed" && t.status !== "failed") throw new Error(t.harnessError ?? t.status);
          return { pass: t.status === "passed", tokens: t.inputTokens + t.outputTokens };
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    });
    if (result.tokens > 0) deps.db.spend(l.projectId, day, result.tokens);
    return result;
  };
}
