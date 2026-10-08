import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The project's guide: `.cubiq/CUBIQ.md`, or the older `.agents/HARNESS.md`
 * when there's no CUBIQ.md. Never both, so nothing is sent twice.
 */
export function projectGuidePath(cwd: string): string {
  const own = join(cwd, ".cubiq", "CUBIQ.md");
  const legacy = join(cwd, ".agents", "HARNESS.md");
  return !existsSync(own) && existsSync(legacy) ? legacy : own;
}

/**
 * The user's own guide in the app data folder, `CUBIQ.md`. A `HARNESS.md` from
 * before the rename is moved over once; best effort, a failed move reads nothing.
 */
export function userGuidePath(dataDir: string): string {
  const own = join(dataDir, "CUBIQ.md");
  const legacy = join(dataDir, "HARNESS.md");
  if (!existsSync(own) && existsSync(legacy)) {
    try {
      renameSync(legacy, own);
    } catch {
      // Left where it was; the user can move it.
    }
  }
  return own;
}

/**
 * What a design thread's agent is told until Design mode has its own guide (D3):
 * where to build, and that the canvas has no network. Stable per thread, so the
 * prompt cache holds.
 */
export function designNote(dir: string): string {
  return [
    "# Design thread",
    `This thread is a design. Build it as one self-contained web page at \`${dir}/index.html\` (relative to the working folder); put any extra CSS, JS, images or fonts beside it in \`${dir}/\` and link them with relative paths.`,
    "The page shows live in CubiQ's canvas, which reloads as you write and has no network: no CDN scripts, web fonts, remote images or fetch calls. Inline scripts and styles work.",
  ].join("\n\n");
}

/**
 * The harness guide agents receive as instructions: the app's bundled copy,
 * then the user's own, then the project's. Each file is read once and cached by
 * its mtime, so repeated calls return the same text and the prompt cache isn't
 * broken by a re-read (which also means a guide edited mid-session is only
 * picked up on the next mtime change, not mid-turn).
 */
export function createGuide(opts: { bundled: string; global: string }): {
  forCwd(cwd: string, design?: string): string;
  partsForCwd(cwd: string): { source: "bundled" | "user" | "project"; path: string; text: string }[];
} {
  const cache = new Map<string, { mtimeMs: number; text: string }>();

  /** A file's trimmed text, cached by mtime, or "" when it's missing or unreadable. */
  const read = (path: string): string => {
    try {
      const { mtimeMs } = statSync(path);
      const hit = cache.get(path);
      if (hit && hit.mtimeMs === mtimeMs) return hit.text;
      // LF only: a CRLF checkout (git autocrlf on Windows) would otherwise inflate the prompt and its estimate.
      const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trim();
      cache.set(path, { mtimeMs, text });
      return text;
    } catch {
      return "";
    }
  };

  /** The three guide files as parts, in the order agents receive them, omitting empty ones. */
  const partsForCwd = (cwd: string): { source: "bundled" | "user" | "project"; path: string; text: string }[] => {
    const sources: { source: "bundled" | "user" | "project"; path: string }[] = [
      { source: "bundled", path: opts.bundled },
      { source: "user", path: opts.global },
      { source: "project", path: projectGuidePath(cwd) },
    ];
    return sources
      .map((s) => ({ ...s, text: read(s.path) }))
      .filter((p) => p.text.length > 0);
  };

  return {
    forCwd(cwd: string, design?: string): string {
      return [...partsForCwd(cwd).map((p) => p.text), ...(design ? [designNote(design)] : [])].join("\n\n");
    },
    partsForCwd,
  };
}
