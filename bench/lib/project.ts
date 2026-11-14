// A bench run's project folder: where its starting files come from (a fixture,
// or this repo at a commit), resetting it before a run, and the hidden files
// written in after the turn.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { execCommandSync } from "../../src/main/winspawn";
import { withoutDelegation } from "./guides";
import type { BenchTask } from "./types";

const ROOT = join(import.meta.dirname, "..", "..");
const BENCH = join(ROOT, "bench");
const STATE = join(BENCH, ".state");

const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

/** A commit-ish (e.g. "eb2bdd0^") as a short hash, so folder names stay plain. */
const shortSha = (rev: string): string => execFileSync("git", ["rev-parse", "--short=9", rev], { cwd: ROOT, encoding: "utf8" }).trim();

/**
 * This repo at `rev`, extracted once into .state/trees. "bare" drops the agent guides (every agent starts equal);
 * "guides" keeps them as the project is really worked on (minus delegation and .ai). `install` adds node_modules.
 */
export function repoTree(rev: string, mode: "bare" | "guides", install = false): string {
  const sha = shortSha(rev);
  const dir = join(STATE, "trees", `${sha}-${mode}`);
  const ready = join(dir, ".bench-ready");
  if (!existsSync(ready)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tar = join(STATE, "trees", `${sha}.tar`);
    execFileSync("git", ["archive", "-o", tar, sha], { cwd: ROOT });
    execFileSync("tar", ["-xf", tar, "-C", dir]);
    rmSync(tar, { force: true });
    const drop = mode === "bare" ? ["CLAUDE.md", "AGENTS.md", ".claude", ".ai", ".agents", ".cubiq", ".opencode"] : [".ai"];
    for (const p of drop) rmSync(join(dir, p), { recursive: true, force: true });
    if (mode === "guides" && existsSync(join(dir, "CLAUDE.md"))) writeFileSync(join(dir, "CLAUDE.md"), withoutDelegation(readFileSync(join(dir, "CLAUDE.md"), "utf8")));
    writeFileSync(ready, "");
  }
  if (install && !existsSync(join(dir, "node_modules"))) {
    log(`installing node_modules for ${sha} (once)`);
    // Scripts skipped: graders run tests and typechecks, never Electron.
    execCommandSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, timeout: 600_000 });
  }
  return dir;
}

/** Where a task's starting files come from. */
export function sourceOf(task: BenchTask): string {
  if (task.repo) return repoTree(task.repo.commit, "guides", task.repo.install);
  if (task.pinned) return repoTree(task.pinned, "bare");
  return join(BENCH, "fixtures", task.fixture!);
}

/** Copies `from` into an emptied `dir`; a node_modules is linked, not copied. `git` makes it a repo with one commit. */
export function layTree(from: string, dir: string, git: boolean): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const modules = join(from, "node_modules");
  cpSync(from, dir, { recursive: true, preserveTimestamps: true, filter: (src) => !src.endsWith(".bench-ready") && src !== modules && !src.startsWith(modules + sep) });
  if (existsSync(modules)) symlinkSync(modules, join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (git) {
    const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    // A linked node_modules is a symlink, which the repo's "node_modules/" ignore rule doesn't match.
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules\n");
    run("add", "-A");
    run("commit", "-q", "-m", "start");
  }
}

/** Empties the run's project folder and lays the task's starting state into it. */
export function resetProject(task: BenchTask, dir: string): void {
  layTree(sourceOf(task), dir, Boolean(task.git));
}

/** Writes the task's hidden files in after the turn: a fixture's `.hidden`, `hiddenDir`, and a repo task's real tests. */
export function revealHidden(task: BenchTask, dir: string): void {
  for (const folder of [task.fixture ? `${task.fixture}.hidden` : null, task.hiddenDir ?? null]) {
    const from = folder ? join(BENCH, "fixtures", folder) : null;
    if (from && existsSync(from)) cpSync(from, dir, { recursive: true, force: true });
  }
  const hidden = task.repo?.hidden;
  for (const path of hidden?.paths ?? []) {
    const text = execFileSync("git", ["show", `${hidden!.commit}:${path}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
