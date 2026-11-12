// A design thread's own folder is its canvas: writes there never ask in Ask or
// Auto-edit mode. Everything else (other paths, commands, Plan mode) is decided
// as before. Paths are checked after following symlinks, so a link inside the
// folder that points outside it is outside.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PermissionMode } from "../../shared/types";

/** `p` with every symlink in its longest existing prefix followed; the missing rest is appended as written. */
function physical(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      missing.push(basename(cur));
      cur = parent;
    }
  }
}

/** True when `abs` is `root` or inside it. */
function within(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Folders inside a design folder that CubiQ writes and the agent must not: `system/` (the pinned kit and tokens)
 * and `styles/` (the systems a "More styles" round copies in). The agent's own `kit/` draft stays writable.
 */
export const MANAGED_DESIGN_DIRS = ["system", "styles"] as const;

/** The managed folder (`system`, `styles`) that `path` falls in, or null. */
export function managedDesignDir(cwd: string, design: string | undefined, path: string): string | null {
  if (!design || typeof path !== "string" || !path.trim()) return null;
  const root = physical(resolve(cwd, design));
  const abs = physical(resolve(cwd, path.trim()));
  return MANAGED_DESIGN_DIRS.find((d) => within(join(root, d), abs)) ?? null;
}

/** Whether `path` lands anywhere in the design folder, managed folders included (a place a copy may read from). */
export function inDesignRoot(cwd: string, design: string | undefined, path: string): boolean {
  if (!design || typeof path !== "string" || !path.trim()) return false;
  return within(physical(resolve(cwd, design)), physical(resolve(cwd, path.trim())));
}

/**
 * Whether every one of `paths` (absolute, or relative to `cwd`) lands inside the
 * design folder `<cwd>/<design>`, outside its managed folders. False for no design folder or no paths.
 */
export function insideDesignFolder(cwd: string, design: string | undefined, paths: readonly string[]): boolean {
  if (!design || !paths.length) return false;
  const root = physical(resolve(cwd, design));
  return paths.every((p) => {
    if (typeof p !== "string" || p.trim() === "") return false;
    const abs = physical(resolve(cwd, p.trim()));
    return within(root, abs) && !MANAGED_DESIGN_DIRS.some((d) => within(join(root, d), abs));
  });
}

/**
 * Whether a file write to `paths` is allowed without asking because it stays in
 * the thread's design folder. Only Ask and Auto-edit are widened: Plan stays
 * read-only and Full already allows everything.
 */
export function designWriteAllowed(mode: PermissionMode, cwd: string, design: string | undefined, paths: readonly string[]): boolean {
  return (mode === "ask" || mode === "auto-edit") && insideDesignFolder(cwd, design, paths);
}
