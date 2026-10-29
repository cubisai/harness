import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import { createEmptyCatalog, findSkillsRoot, loadCatalog } from "../src/main/skills/catalog";

export const fixturesDir = resolve(__dirname, "fixtures");
export const mockSkillsRoot = resolve(fixturesDir, "mock-skills");
export const catalog = () => loadCatalog(findSkillsRoot([mockSkillsRoot]));
export const emptyCatalog = () => createEmptyCatalog();

/** Whether a CLI actually runs here (a bare command name resolves on every machine, installed or not). */
export function runs(command: string | null | undefined): boolean {
  if (!command) return false;
  // A bare name on Windows needs the shell to find its .cmd shim; a full path runs as is (spaces and all).
  const shell = process.platform === "win32" && !/[\\/]/.test(command);
  return spawnSync(command, ["--version"], { stdio: "ignore", timeout: 15_000, shell }).status === 0;
}

const dirs: string[] = [];
const closers: (() => void)[] = [];

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "unskilled-test-"));
  dirs.push(d);
  return d;
}

/** Run after the test, before temp dirs go: Windows can't delete an open file. */
export function closeAfter(fn: () => void): void {
  closers.push(fn);
}

afterEach(() => {
  while (closers.length) closers.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
