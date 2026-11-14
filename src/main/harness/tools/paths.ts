// Path handling shared by the file tools: resolve against the thread's folder,
// report paths relative to it, and keep the read-before-write record.

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ToolError, type ToolContext } from "./types";

export interface ResolvedPath {
  abs: string;
  /** Forward-slash path relative to cwd, or the absolute path when outside it. */
  shown: string;
  /** Outside the thread's folder: the loop asks before an edit there. */
  outside: boolean;
}

export function resolvePath(cwd: string, p: string): ResolvedPath {
  if (!p.trim()) throw new ToolError("The path is empty.");
  const abs = resolve(cwd, p.trim());
  const rel = relative(cwd, abs);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return { abs, shown: outside ? abs.split(sep).join("/") : rel.split(sep).join("/") || ".", outside };
}

/** Remember a file's state after reading or writing it. */
export function noteRead(ctx: ToolContext, abs: string, mtimeMs?: number): void {
  if (mtimeMs !== undefined) {
    ctx.reads.set(abs, mtimeMs);
    return;
  }
  try {
    ctx.reads.set(abs, statSync(abs).mtimeMs);
  } catch {
    ctx.reads.delete(abs);
  }
}

/**
 * An existing file may only be changed after it was read this session and
 * while it's unchanged since; a new file needs no read.
 */
export function assertFresh(ctx: ToolContext, path: ResolvedPath): void {
  let mtime: number;
  try {
    mtime = statSync(path.abs).mtimeMs;
  } catch {
    return; // doesn't exist yet
  }
  const seen = ctx.reads.get(path.abs);
  if (seen === undefined) throw new ToolError(`Read ${path.shown} before changing it.`);
  if (Math.abs(mtime - seen) > 1) throw new ToolError(`${path.shown} changed since you last read it. Read it again before changing it.`);
}
