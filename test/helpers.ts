import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import type { InjectionPlan } from "../src/main/inject";
import { ensureOpenCodeGuard, ensureOpenCodeGuardV2, withOpenCodeGuard } from "../src/main/inject/opencode-guard";
import { withOpenCodeV2 } from "../src/main/inject/opencode-v2";
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

/**
 * An OpenCode plan with CubiQ's plugin, shaped for the CLI's major version the
 * way src/main/index.ts does it: v2 takes the plugin package and v2 config.
 * `config` is v1-shaped, like every injector writes it.
 */
export function openCodeGuardedPlan(
  major: number | null | undefined,
  config: Record<string, unknown>,
  guard: { dir: string; script?: string; python?: string[] } = { dir: tempDir() },
): InjectionPlan {
  const v2 = (major ?? 1) >= 2;
  const pluginUrl = v2 ? ensureOpenCodeGuardV2(guard.dir) : ensureOpenCodeGuard(guard.dir);
  const { dir: _dir, ...rest } = guard;
  const plan = withOpenCodeGuard({ env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, byok: false }, { pluginUrl, ...rest });
  return v2 ? withOpenCodeV2(plan) : plan;
}
