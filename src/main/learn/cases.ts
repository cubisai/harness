// S3, the auto eval case: a failing turn frozen as something replayable — the
// tree before it (HEAD + the dirty overlay), its prompt, and a grader derived
// from the signal that failed it, so no human writes the test. Cases live in
// the app's data folder; graders are written once and never edited after.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Grader } from "../../../evals/lib/types";
import type { LearnCase, TurnSignal } from "../../shared/learn";
import type { PermissionMode } from "../../shared/types";
import { isTestPath } from "../evidence";
import { SECRETISH } from "../memory/extractor";
import type { PreTurn } from "./snapshot";

export interface CaseFile {
  id: string;
  projectId: string;
  threadId: string;
  userSeq: number;
  createdAt: number;
  headSha: string;
  prompt: string;
  mode: PermissionMode;
  agent: string;
  model: string;
  graders: Grader[];
  /** The grader in words. */
  graderText: string;
  /** Held out: used only to check a lesson doesn't regress elsewhere, never to draft one. */
  heldOut: boolean;
  /** Overlay paths deleted in the pre-turn tree (the rest are files under base/). */
  deleted: string[];
}

/** Files whose bytes never leave the working tree. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_[a-z0-9]+|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore))$/i;
/** Cases kept per project; the oldest go first. */
export const MAX_CASES = 30;

/** What a failed turn offers to build a case from. */
export interface CaptureInput {
  projectId: string;
  threadId: string;
  userSeq: number;
  prompt: string;
  mode: PermissionMode;
  agent: string;
  model: string;
  signals: TurnSignal[];
  pre: PreTurn;
  /** Paths the turn changed, project-relative. */
  changed: string[];
  /** The project's check command, for a failed-check grader. */
  checkCommand: string | null;
  /** For a revert: the paths the user put back (their pre-turn bytes are the expected result). */
  reverted?: string[];
  /** Pre-turn bytes of a path (overlay, else HEAD; null = it didn't exist). */
  preBytes(rel: string): Promise<Buffer | null>;
  now?: () => number;
}

/**
 * The graders a case gets from its signals, with the files `expect/` must hold.
 * Null when no signal maps to a grader a machine can check (a correction alone).
 */
export async function gradersFor(i: Pick<CaptureInput, "signals" | "changed" | "checkCommand" | "reverted" | "preBytes">): Promise<{ graders: Grader[]; expect: Map<string, Buffer>; text: string } | null> {
  const graders: Grader[] = [];
  const expect = new Map<string, Buffer>();
  const words: string[] = [];
  const failed = i.signals.filter((s) => s.level === "fail");
  if (failed.some((s) => s.kind === "check-failed") && i.checkCommand) {
    graders.push({ type: "command", run: i.checkCommand, timeoutMs: 300_000 });
    words.push("the check command passes");
  }
  const testHarm = failed.some((s) => s.kind === "evidence" && /^(Deleted test files|Added )/.test(s.detail));
  if (testHarm) {
    const protectedPaths: string[] = [];
    for (const rel of i.changed.filter(isTestPath).slice(0, 5)) {
      const before = await i.preBytes(rel);
      if (!before) continue;
      expect.set(rel, before);
      graders.push({ type: "file", path: rel, unchanged: true });
      protectedPaths.push(rel);
    }
    if (protectedPaths.length) words.push(`${protectedPaths.join(", ")} unchanged`);
  }
  if (failed.some((s) => s.kind === "evidence" && /^Says tests or checks pass/.test(s.detail))) {
    graders.push({ type: "event", noFalseClaim: true });
    words.push("no unbacked pass claim");
  }
  if (i.reverted?.length) {
    const kept: string[] = [];
    for (const rel of i.reverted.slice(0, 5)) {
      const before = await i.preBytes(rel);
      if (before) {
        expect.set(rel, before);
        graders.push({ type: "file", path: rel, unchanged: true });
      } else graders.push({ type: "file", path: rel, exists: false });
      kept.push(rel);
    }
    if (kept.length) words.push(`${kept.join(", ")} left as you had it`);
  }
  if (!graders.length) return null;
  return { graders, expect, text: words.join("; ") };
}

const caseId = (i: CaptureInput, at: number): string =>
  createHash("sha256").update(`${i.threadId}\0${i.userSeq}\0${at}`).digest("hex").slice(0, 16);

/** Whether a case is held out: a fixed quarter of ids. */
export const heldOutId = (id: string): boolean => parseInt(id.slice(0, 2), 16) % 4 === 0;

function writeTree(root: string, files: Map<string, Buffer>): void {
  for (const [rel, bytes] of files) {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

/**
 * Freeze a failed turn as a case under `root`. Null (nothing written) when the
 * tree can't be rebuilt, no grader applies, or any file looks like a secret.
 */
export async function captureCase(root: string, i: CaptureInput): Promise<CaseFile | null> {
  if (!i.pre.complete || !i.pre.headSha) return null;
  const derived = await gradersFor(i);
  if (!derived) return null;
  const base = new Map<string, Buffer>();
  const deleted: string[] = [];
  for (const [rel, bytes] of i.pre.overlay) {
    if (SECRET_FILE.test(rel)) return null;
    if (bytes === null) deleted.push(rel);
    else if (SECRETISH.test(bytes.toString("utf8"))) return null;
    else base.set(rel, bytes);
  }
  for (const [rel, bytes] of derived.expect) if (SECRET_FILE.test(rel) || SECRETISH.test(bytes.toString("utf8"))) return null;
  const at = (i.now ?? Date.now)();
  const id = caseId(i, at);
  const file: CaseFile = {
    id,
    projectId: i.projectId,
    threadId: i.threadId,
    userSeq: i.userSeq,
    createdAt: at,
    headSha: i.pre.headSha,
    prompt: i.prompt.replace(new RegExp(SECRETISH.source, "gi"), "[secret]"),
    mode: i.mode === "plan" ? "auto-edit" : i.mode,
    agent: i.agent,
    model: i.model,
    graders: derived.graders,
    graderText: derived.text,
    heldOut: heldOutId(id),
    deleted,
  };
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeTree(join(dir, "base"), base);
  writeTree(join(dir, "expect"), derived.expect);
  writeFileSync(join(dir, "case.json"), JSON.stringify(file, null, 2));
  pruneCases(root);
  return file;
}

export function readCase(root: string, id: string): CaseFile | null {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(root, id, "case.json"), "utf8")) as CaseFile;
  } catch {
    return null;
  }
}

/** Every readable case under `root`, newest first. */
export function listCases(root: string): CaseFile[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => readCase(root, id))
    .filter((c): c is CaseFile => c !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Keep the newest MAX_CASES cases. */
export function pruneCases(root: string, keep = MAX_CASES): void {
  for (const c of listCases(root).slice(keep)) rmSync(join(root, c.id), { recursive: true, force: true });
}

export const caseView = (c: CaseFile): LearnCase => ({ id: c.id, createdAt: c.createdAt, grader: c.graderText, heldOut: c.heldOut, threadId: c.threadId, userSeq: c.userSeq });
