import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One `package.json` script that looks like a dev server, with the port it would listen on. */
export interface DevScript {
  script: string;
  command: string;
  port: number;
}

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** Which package manager a project uses, by its lockfile; npm when there's no lockfile. */
export function packageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The port a command opens: an explicit flag first, then the tool's own default, else 3000. */
export function inferPort(command: string, script: string): number {
  const explicit = /--port[= ](\d+)/.exec(command) ?? /(?:^|\s)-p (\d+)/.exec(command) ?? /PORT=(\d+)/.exec(command);
  if (explicit) return Number(explicit[1]);
  const c = command.toLowerCase();
  if (/\bvite\b/.test(c)) return script === "preview" || /vite\s+preview/.test(c) ? 4173 : 5173;
  if (/\bnext\b/.test(c)) return 3000;
  if (/\breact-scripts\b/.test(c)) return 3000;
  if (/\bastro\b/.test(c)) return 4321;
  if (/\bnuxt\b/.test(c)) return 3000;
  if (/\bwebpack\b/.test(c) && /\b(serve|dev-server)\b/.test(c)) return 8080;
  if (/\bremix\b/.test(c)) return 3000;
  if (/\bng serve\b/.test(c)) return 4200;
  return 3000;
}

/** A script that only builds or tests, never serves: skip it. */
function isBuildOnly(command: string): boolean {
  const c = command.trim().toLowerCase();
  if (/^node\s+--test\b/.test(c) || /^vitest\b/.test(c) || /^jest\b/.test(c)) return true;
  return c.includes("build") && !/(dev|serve|preview)/.test(c);
}

const CANDIDATES = ["dev", "start", "serve", "preview"] as const;

/** The dev-server scripts in a project's package.json, in preference order; [] when there's none to run. */
export function detectScripts(cwd: string): DevScript[] {
  let pkg: { scripts?: Record<string, unknown> } | null = null;
  try {
    pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const out: DevScript[] = [];
  for (const name of CANDIDATES) {
    const command = scripts[name];
    if (typeof command !== "string" || !command.trim()) continue;
    if (isBuildOnly(command)) continue;
    out.push({ script: name, command, port: inferPort(command, name) });
  }
  return out;
}
