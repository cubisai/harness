import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import { createEmptyCatalog, findSkillsRoot, loadCatalog } from "../src/main/skills/catalog";

export const fixturesDir = resolve(__dirname, "fixtures");
export const mockSkillsRoot = resolve(fixturesDir, "mock-skills");
export const catalog = () => loadCatalog(findSkillsRoot([mockSkillsRoot]));
export const emptyCatalog = () => createEmptyCatalog();

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
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});
