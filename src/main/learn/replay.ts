// S4's evidence, in the words of a replay: run a case with and without the
// candidate lesson (S3's captured case), then check the lesson holds on other
// cases of the project. A run is cached by (case, lesson, runtime, rollout), so
// re-verifying on the same tier costs nothing. Promotion itself is lifecycle.ts.

import { createHash } from "node:crypto";
import { copyFileSync, type Dirent, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "../../../evals/lib/types";
import type { Lesson, LessonVerification, ReplayScore } from "../../shared/learn";
import { execCommandSync } from "../winspawn";
import { type CaseFile, listCases, readCase } from "./cases";
import type { LearnDb } from "./db";
import { lessonsBlock, promotion, type Runtime } from "./lifecycle";

export interface ReplayDeps {
  casesRoot: string;
  /** Up to `max` other cases of the project, held-out ones first; never `excludeId`. */
  otherCases?(excludeId: string, max: number): CaseFile[];
  /** Run one replay: the case's tree, its prompt (with `lessons` prepended when non-null), its graders. Throws when the run is no evidence (it couldn't run, or didn't finish). */
  runCase(c: CaseFile, lessons: string | null): Promise<{ pass: boolean; tokens: number }>;
  db: Pick<LearnDb, "cachedReplay" | "saveReplay">;
  runtime: Runtime;
  now(): number;
  /** Rollouts per side (default 1); transfer cases get one each. */
  rollouts?: number;
  /** Other cases to check transfer on (default 3). */
  transferCases?: number;
  /** Tokens this verification may spend; a fresh run is not started once they're gone (default: no limit). */
  budget?: number;
}

/** Other cases of the project to check transfer on: held-out first, then newest. */
function otherCasesFirst(root: string, excludeId: string, max: number): CaseFile[] {
  return listCases(root)
    .filter((c) => c.id !== excludeId)
    .sort((a, b) => Number(b.heldOut) - Number(a.heldOut))
    .slice(0, max);
}

/** A replay that is no evidence: it threw, or ended without a pass/fail. */
export class NoEvidence extends Error {}

/** The cache key of one replay: tied to the runtime and rollout that produced it. */
export function replayKey(caseId: string, lessonId: string | null, rt: Runtime, rollout: number): string {
  return createHash("sha256").update([caseId, lessonId ?? "", rt.model, rt.agent, rt.appVersion, String(rollout)].join("\0")).digest("hex").slice(0, 32);
}

/**
 * Replay `l`'s captured case with and without it, then check it doesn't make
 * other cases fail. Runs before/after first; transfer is skipped when
 * the source case alone already decides the outcome.
 */
export async function verifyLesson(l: Lesson, deps: ReplayDeps): Promise<{ verification: LessonVerification | null; promote: boolean; why: string; tokens: number }> {
  if (!l.caseId) return { verification: null, promote: false, why: "no captured case to replay", tokens: 0 };
  const c = readCase(deps.casesRoot, l.caseId);
  if (!c) return { verification: null, promote: false, why: "no captured case to replay", tokens: 0 };
  const rollouts = Math.max(1, deps.rollouts ?? 1);
  const transferMax = Math.max(0, deps.transferCases ?? 3);
  // The lesson even though it isn't active yet: the replay is what would make it so.
  const block = lessonsBlock([l]);
  let tokens = 0;

  const run = async (target: CaseFile, lessonId: string | null, text: string | null, rollout: number): Promise<boolean> => {
    const key = replayKey(target.id, lessonId, deps.runtime, rollout);
    const hit = deps.db.cachedReplay(key);
    if (hit) return hit.pass;
    // Stop between runs once the day's budget is gone; what ran is cached, so the next try picks up from there.
    if (deps.budget !== undefined && tokens >= deps.budget) throw new NoEvidence("today's background budget ran out");
    let r: { pass: boolean; tokens: number };
    try {
      r = await deps.runCase(target, text);
    } catch (err) {
      throw new NoEvidence(err instanceof Error ? err.message : String(err));
    }
    deps.db.saveReplay(key, target.id, lessonId, r.pass, r.tokens);
    tokens += r.tokens;
    return r.pass;
  };

  const decide = async (): Promise<{ verification: LessonVerification; promote: boolean; why: string; tokens: number }> => {
    const before: ReplayScore = { passed: 0, of: rollouts };
    for (let i = 0; i < rollouts; i++) if (await run(c, null, null, i)) before.passed++;
    const after: ReplayScore = { passed: 0, of: rollouts };
    for (let i = 0; i < rollouts; i++) if (await run(c, l.id, block, i)) after.passed++;

    // Once the case already passes without it, or still fails with it, transfer can't change the verdict: don't spend on it.
    if (before.passed === before.of || after.passed < after.of) {
      const verification: LessonVerification = { model: deps.runtime.model, agent: deps.runtime.agent, appVersion: deps.runtime.appVersion, at: deps.now(), before, after, transfer: { held: 0, of: 0 } };
      const p = promotion(verification);
      return { verification, promote: p.promote, why: p.why, tokens };
    }

    const others = (deps.otherCases ? deps.otherCases(c.id, transferMax) : otherCasesFirst(deps.casesRoot, c.id, transferMax)).slice(0, transferMax);
    let held = 0;
    for (const o of others) {
      const without = await run(o, null, null, 0);
      const withLesson = await run(o, l.id, block, 0);
      // Only a case the lesson breaks counts against it; one it also fixes is the transfer it should have.
      if (!without || withLesson) held++;
    }
    const verification: LessonVerification = {
      model: deps.runtime.model,
      agent: deps.runtime.agent,
      appVersion: deps.runtime.appVersion,
      at: deps.now(),
      before,
      after,
      transfer: { held, of: others.length },
    };
    const p = promotion(verification);
    return { verification, promote: p.promote, why: p.why, tokens };
  };

  try {
    return await decide();
  } catch (err) {
    // A run that couldn't run or finish is no evidence either way: a hung "without" would fake the fix.
    if (!(err instanceof NoEvidence)) throw err;
    return { verification: null, promote: false, why: `a replay couldn't finish (${err.message.slice(0, 160)}); nothing was decided`, tokens };
  }
}

/** Copy every file under `from` into `into`, keeping relative paths. */
function overlay(from: string, into: string, rel = ""): void {
  const dir = rel ? join(from, ...rel.split("/")) : from;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // No base/ (an all-tracked case).
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      overlay(from, into, child);
      continue;
    }
    const target = join(into, ...child.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, ...child.split("/")), target);
  }
}

/** Rebuild a case's full pre-turn tree in `into`: git archive of headSha from `projectPath`, then base/ overlaid and `deleted` removed. */
export function materializeCase(c: CaseFile, o: { casesRoot: string; projectPath: string; into: string; exec?: typeof execCommandSync }): void {
  const exec = o.exec ?? execCommandSync;
  mkdirSync(o.into, { recursive: true });
  const tar = join(o.into, "..", `${c.id}.tar`);
  try {
    exec("git", ["archive", "--format=tar", "-o", tar, c.headSha], { cwd: o.projectPath });
  } catch {
    throw new Error(`the case's commit ${c.headSha.slice(0, 7)} is no longer in the repository`);
  }
  try {
    exec("tar", ["-xf", tar, "-C", o.into], { cwd: o.projectPath });
  } finally {
    rmSync(tar, { force: true });
  }
  overlay(join(o.casesRoot, c.id, "base"), o.into);
  for (const rel of c.deleted) rmSync(join(o.into, ...rel.split("/")), { recursive: true, force: true });
}

/** The eval Task a replay runs: the case's prompt (lessons prepended), graders and mode, with a modest budget. */
export function caseTask(c: CaseFile, fixture: string, lessons: string | null): Task {
  return {
    id: `case-${c.id}`,
    tags: [],
    tier: "full",
    fixture,
    prompt: lessons ? `${lessons}\n\n${c.prompt}` : c.prompt,
    mode: c.mode,
    graders: c.graders,
    budget: { maxSteps: 40, maxInputTokens: 400_000, timeoutMs: 600_000 },
  };
}
