// Which shell commands only read an expert's own skill files. Codex has no
// read tool of its own, so a team member opens its SKILL.md with `cat`, and in
// Ask mode every command asks. A plain read inside the expert's skill folder is
// the one command we approve without asking: no shell syntax, one path, inside
// the root.

import { posix, win32 } from "node:path";

/** The shell wrappers Codex puts around a command: `/bin/zsh -lc "…"`, `bash -c '…'`, `powershell -Command "…"`. */
const WRAPPER = /^(?:\S*[\\/])?(?:ba|z)?sh(?:\.exe)?\s+-l?c\s+(["'])([\s\S]*)\1$|^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-NoProfile\s+)?-Command\s+(["'])([\s\S]*)\3$/i;

/** One read-only command and its single path operand (quoted or bare). */
const READ = /^(?:cat|head(?:\s+-n\s*\d+)?|tail(?:\s+-n\s*\d+)?|sed\s+-n\s+'\d+(?:,\d+)?p'|ls(?:\s+-[a-zA-Z]+)?|wc\s+-[lc]|Get-Content(?:\s+-Raw)?|type)\s+(?:'([^']+)'|"([^"]+)"|([^\s'"]+))$/;

/** Anything that chains, redirects, substitutes or globs. */
const SHELL_SYNTAX = /[;&|<>`$(){}*?\n\r]/;

/** The command with its shell wrapper peeled off (one level). */
function unwrap(command: string): string {
  const m = WRAPPER.exec(command.trim());
  return m ? (m[2] ?? m[4] ?? "").trim() : command.trim();
}

/** Whether `path` is `root` or inside it, after resolving `..`; case-insensitive on Windows. */
function inside(root: string, path: string, windows: boolean): boolean {
  const p = windows ? win32 : posix;
  const norm = (s: string) => (windows ? p.resolve(s).toLowerCase() : p.resolve(s));
  const rel = p.relative(norm(root), norm(path));
  return rel === "" || (!rel.startsWith(`..${p.sep}`) && rel !== ".." && !p.isAbsolute(rel));
}

/**
 * True when `command` only reads a file or lists a folder under one of
 * `roots`. Relative paths are refused: the command's cwd is the project, never
 * a skill folder.
 */
export function isSkillRead(command: string, roots: string[], windows = process.platform === "win32"): boolean {
  if (!roots.length) return false;
  const inner = unwrap(command);
  const m = READ.exec(inner);
  if (!m) return false;
  const path = m[1] ?? m[2] ?? m[3] ?? "";
  if (!path || SHELL_SYNTAX.test(path) || !(windows ? win32 : posix).isAbsolute(path)) return false;
  // The rest of the command (everything but the path) must be plain too.
  if (SHELL_SYNTAX.test(inner.replace(path, ""))) return false;
  return roots.some((root) => Boolean(root) && inside(root, path, windows));
}
